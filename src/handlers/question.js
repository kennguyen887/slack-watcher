import path from "node:path";
import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { prepareAttachments } from "../attachments.js";
import { loadStyleProfile, styleBlock } from "../style.js";
import { log } from "../log.js";
import {
  cancelledDuringGrace,
  isVietnamese,
  minutes,
  newSessionId,
  threadTsOf,
  trim,
  watchForStop,
} from "./shared.js";

/**
 * The answer worker's tool set — an ALLOWLIST, and deliberately not the code worker's args.
 *
 * Unlike the code and review workers, this one runs in REPOS_ROOT: the user's real working copies
 * of every repo, not a disposable worktree. So it must not be able to write, and "please don't
 * write" in the prompt is not a control.
 *
 * Denying the write TOOLS is not enough either — measured, not assumed: with
 * `--dangerously-skip-permissions --disallowedTools Edit Write NotebookEdit`, the worker's Write
 * call was refused and it simply wrote the file with `Bash: echo > file` instead. Bash is the
 * hole, so the only real fix is to drop skip-permissions entirely and name what IS allowed.
 * Headless `-p` cannot prompt, so anything off this list is denied outright (verified: the same
 * write attempt under this list produced no file and the worker reported it was blocked).
 *
 * Bash entries are prefix-scoped to read-only commands. `gh api` is deliberately absent — it
 * takes -X POST, which would let an answer worker write to GitHub.
 */
const ANSWER_TOOLS = [
  "--allowedTools",
  "Read",
  "Grep",
  "Glob",
  "Bash(git log:*)",
  "Bash(git branch:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git remote:*)",
  "Bash(git status:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh issue view:*)",
  "Bash(ls:*)",
  "Bash(rg:*)",
];

/**
 * What the answer worker reported, and whether it may be posted publicly.
 *
 * "answer" is the only status that reaches the team. Everything else — the worker was unsure, the
 * question needs a decision only the user can make, the reply came back empty or too long for a
 * chat message — becomes a private draft instead. Posting under someone's name is not reversible
 * (Slack gives this tool no delete), so anything short of a confident, in-voice answer stays in.
 * @returns {{ status: string, reply: string, reason: string, postable: boolean }}
 */
export function answerOutcome(result, { maxChars = 600 } = {}) {
  const status = result.match(/^ANSWER_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase() ?? null;
  const reason = result.match(/^ANSWER_REASON:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const reply = (result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1] ?? "").trim();
  const postable = status === "answer" && reply.length > 0 && reply.length <= maxChars;
  return {
    status: status ?? "unparseable",
    reply,
    reason,
    postable,
    // Why a would-be answer was held back, for the DM — an over-long reply is the common one.
    heldBack:
      status === "answer" && !postable ? (reply ? `reply is ${reply.length} chars, over the ${maxChars} cap` : "worker returned an empty reply") : null,
  };
}

function answerPrompt({ mention, contextBlock }, attachmentsBlock, profile) {
  // The first line becomes the session's title in the Claude desktop app, so lead with "[slack]".
  return `[slack] Answer a teammate's question — #${mention.channel?.name ?? "dm"}. A teammate asked me something on Slack. Work out the answer, then write the reply I would send, in my own voice. It gets posted in the thread under MY name, automatically.

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}${attachmentsBlock}
You are in the workspace root holding the team's repositories — my live working copies, not a
scratch checkout. Your tools are restricted to reading (Read, Grep, Glob, and read-only git/gh
commands); a write will be refused, so do not plan around one. Read code, docs and git history as
much as you need.

Work out the answer FIRST, from the actual code and docs — not from what sounds plausible. Trace it
to the real source: the route, the migration, the config, the commit. If the question names a file,
endpoint, branch, repo or ticket, go and look at it.

Then decide whether I would answer it myself or hand it back to a human. Report ANSWER_STATUS:

"answer" — ONLY when ALL of these hold:
  - the question has a factual answer and you VERIFIED it in the code, docs or git history;
  - it is about how the system works, where something lives, which API/endpoint/branch/repo to use,
    what a piece of code does, or what the current state of something is;
  - nothing in the reply is a guess, an estimate, or a promise about the future.

"escalate" — anything else, and specifically whenever:
  - the answer needs a DECISION, a priority call, an approval, a deadline or a commitment ("nên làm
    cái nào trước", "có nên fix không", "bao giờ xong", "mình có được phép..."), or it affects
    money, contracts, access rights or credentials;
  - it asks me to DO something rather than to explain something (deploy, release, merge, grant
    access, test on my machine, look at my screen), or only I can see the answer;
  - it is about people, planning, process changes, hiring, or anything I would want to phrase myself;
  - the conversation context shows the team is still arguing about it, or someone already answered;
  - you could not verify the answer, the repository does not hold it, or you are guessing at all.
When in doubt, escalate. A wrong answer posted under my name costs far more than a slow one.
${styleBlock(profile)}
Write the reply as ONE Slack message in Vietnamese, matching the profile above:
- Say the answer and nothing else. No greeting, no sign-off, no "hy vọng giúp được", no recap of
  their question, no offer to help further, no bullet list unless I would really use one.
- Keep it to the length I actually write — a sentence or two. Long is wrong.
- Keep technical terms in English exactly as the team says them (API, endpoint, branch, deploy, RC,
  prod, merge, PR, env, cron, migration…). Never translate them.
- Plain text. No markdown headings, no bold, no numbered lists. A link is just the URL.
- Do not address them by @mention — it is a thread reply, they already get it.
- Never claim I did something I have not done, and never promise a time.

End your final message with exactly these lines:
ANSWER_STATUS: <answer | escalate>
ANSWER_REASON: <one short English sentence: what you verified and where, or why this needs me>
SLACK_REPLY: <the Vietnamese reply to post, or — when escalating — the draft for me to edit and send myself>`;
}

/**
 * Answer a teammate's Vietnamese question in the thread, as the user.
 *
 * Gated three ways, because this is the only handler that says something SUBSTANTIVE in public
 * under the user's name (the review handler only reports a count):
 *   1. Vietnamese only — English-speaking teammates are the user's to answer, by their request.
 *   2. A learned voice must exist (`npm run learn-style`), or the reply stays a private draft.
 *   3. The worker must come back confident; anything else is a draft too.
 * Plus the grace window every public action in this tool sits behind.
 */
export async function handleQuestion(ctx) {
  const { mention, config, slack, selfId } = ctx;
  const who = `@${mention.username ?? mention.user}`;

  if (!config.questionAutoReply) {
    return draftOnly(ctx, "auto-reply is off (QUESTION_AUTO_REPLY=1 to turn it on)");
  }
  // The user answers their English-speaking teammates themselves — clients and partners are on
  // that side of the line, and a machine-written reply to them is exactly the wrong first impression.
  if (!isVietnamese(mention.text ?? "")) {
    log(`[question] ${who} wrote in English — leaving it for you`);
    return draftOnly(ctx, "not a Vietnamese message — English teammates are yours to answer");
  }
  const profile = loadStyleProfile(config.styleProfileFile);
  if (!profile) {
    log("[question] no style profile — run `npm run learn-style`; drafting privately instead");
    return draftOnly(ctx, "no learned voice yet — run `npm run learn-style` first");
  }

  const graceNote =
    config.workerGraceMs > 0
      ? `• *Replying in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel, before OR while it runs\n`
      : "";
  const dmChannel = await slack.postToSelf(
    selfId,
    `:speech_balloon: *Question picked up* — ${who} in #${mention.channel?.name ?? "?"}:\n` +
      `> ${(mention.text ?? "").slice(0, 200)}\n` +
      graceNote +
      "• I'll answer in the thread as you, in Vietnamese — unless I'm not sure, then you get a draft\n" +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, "question")) return { status: "cancelled_by_user" };

  const destDir = path.join(config.attachmentsDir, mention.ts.replace(".", "-"));
  const { block: attachmentsBlock, dir } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir,
    label: "question",
  });

  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, "question", controller);
  const sessionId = newSessionId();
  let result;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: answerPrompt(ctx, attachmentsBlock, profile),
      cwd: config.reposRoot,
      timeoutMs: config.answerTimeoutMs,
      model: config.answerModel,
      // NOT config.workerClaudeArgs: that carries --dangerously-skip-permissions, which is
      // exactly what ANSWER_TOOLS exists to avoid here.
      extraArgs: ANSWER_TOOLS,
      label: "question",
      sessionId,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      await slack.postToSelf(selfId, `:no_entry: Stopped — nothing was posted. ${mention.permalink ?? ""}`);
      return { status: "cancelled_by_user" };
    }
    throw err;
  } finally {
    stopWatching();
    if (dir) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }

  return deliverAnswer(ctx, answerOutcome(result, { maxChars: config.answerMaxChars }), sessionId);
}

/**
 * Post the answer, or keep it private — the one decision that reaches the team.
 *
 * Split out from the worker run so it can be driven directly: "escalate stays out of the channel"
 * is the property this whole handler exists to guarantee, and it must not be reachable only
 * through a live claude process.
 */
export async function deliverAnswer(ctx, outcome, sessionId = null) {
  const { mention, classification, slack, selfId } = ctx;
  const who = `@${mention.username ?? mention.user}`;

  if (!outcome.postable) {
    await slack.postToSelf(
      selfId,
      trim(
        `:grey_question: *Not answering ${who} myself* — ${outcome.heldBack ?? (outcome.reason || outcome.status)}\n` +
          `> ${classification?.summary ?? ""}\n\nDraft for you to edit and send:\n${outcome.reply || "(the worker produced no draft)"}\n\n` +
          `Original: ${mention.permalink ?? "n/a"}`,
      ),
    );
    return { status: "answer_drafted", answerStatus: outcome.status, sessionId };
  }

  const threadTs = threadTsOf(mention);
  await slack.replyInThread(mention.channel.id, threadTs, outcome.reply);
  log(`[question] answered ${who} in the thread (${outcome.reply.length} chars)`);
  await slack.postToSelf(
    selfId,
    trim(
      `:white_check_mark: *Answered ${who}* in #${mention.channel?.name ?? "?"} as you:\n` +
        `> ${outcome.reply}\n` +
        `_${outcome.reason}_\n` +
        `Original: ${mention.permalink ?? "n/a"}`,
    ),
  );
  return { status: "answered", threadTs, sessionId, chars: outcome.reply.length };
}

/** Everything that must not be posted: tell the user it arrived and why it is theirs. */
async function draftOnly({ mention, classification, slack, selfId }, why) {
  await slack.postToSelf(
    selfId,
    trim(
      `:speech_balloon: *Question for you* — ${why}.\n` +
        `From @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}:\n` +
        `> ${(mention.text ?? "").slice(0, 300)}\n` +
        `_${classification.summary}_\n` +
        `Original: ${mention.permalink ?? "n/a"}`,
    ),
  );
  return { status: "left_to_you", why };
}
