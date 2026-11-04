import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { parsePrUrl } from "../github.js";
import { log } from "../log.js";
import { cancelledDuringGrace, detectLang, minutes, threadTsOf, trim, watchForStop } from "./shared.js";

/** Above this many changed files a single pass loses the tail of the diff — fan out instead. */
const FANOUT_FILE_THRESHOLD = 12;

/** Files per subagent when fanning out. Small enough that each one still reads real context. */
const FANOUT_BATCH_SIZE = 6;

function reviewPrompt({ mention, contextBlock, config }, pr, attachmentsBlock) {
  const checklist = fs.readFileSync(config.reviewChecklistFile, "utf8").trim();
  return `A teammate asked me to review a pull request. Review it and post inline comments under MY GitHub account.

PR: ${pr.url} (repo ${pr.owner}/${pr.repo}, PR #${pr.number})

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}${attachmentsBlock}
Workflow:

1. PRE-CHECK first: run \`gh api user --jq .login\` and \`gh pr view ${pr.number} --json author,state,isDraft,reviews,comments,commits\`. STOP immediately and post nothing (report REVIEW_STATUS: skipped, REVIEW_COMMENTS: 0, and say why in SLACK_REPLY) if ANY of these holds:
   - the PR author is me (never review my own PR),
   - the PR is closed or merged,
   - I already reviewed or commented on this PR AND no commit landed after my latest one (never repeat a review of unchanged code).
   If I already reviewed it but NEW commits landed since, do review — but only the changes since my last review (\`gh pr diff\` limited to those commits), and never repeat a point I already made.

2. GATHER. You are in an isolated git worktree of this repository. Run \`gh pr checkout ${pr.number}\`, \`gh pr view ${pr.number}\`, \`gh pr diff ${pr.number} --name-only\`, \`gh pr diff ${pr.number} --stat\`, then \`gh pr diff ${pr.number}\`. Note the total number of changed files — you must account for every one of them. Split the name list in two: the source files, and every test file (\`*.test.*\`, \`*.spec.*\`, anything under \`__tests__/\`) the PR ADDS **or GROWS** — the \`--stat\` output is what tells you which modified test files gained a real chunk; \`--name-only\` shows a doubled test file as an ordinary \`modified\` and hides the whole class. Keep that test-file list — section G is judged on all of it at once, and a PR that adds test files usually adds them by the dozen.

3. COVERAGE — this is the step that decides whether the review is worth anything. Every changed file gets read, with the source around it, not just its diff hunk. Nothing may be skipped for being "boilerplate", "just config", "just a rename", or "too long".
   - ${FANOUT_FILE_THRESHOLD} changed files or fewer: read them yourself, one at a time.
   - The test-file list from step 2 is judged by YOU, never handed to a batch subagent: section G wants ONE comment naming every file to delete, and a subagent holding 6 of 18 mirror test files cannot see the class.
   - More than ${FANOUT_FILE_THRESHOLD}: DO NOT try to hold the whole diff in one pass — that is how big PRs come back clean when they are not. Split the file list into batches of ~${FANOUT_BATCH_SIZE} and dispatch one Task subagent per batch, in parallel. Give each subagent: the PR number, its file list, the hunt list below verbatim, and instructions to open the surrounding source (definitions, callers, types, migrations) and return candidates as \`{file, line, what breaks, concrete inputs → wrong output, suggested fix}\`. Subagents only report; you verify and post. If the Task tool is not available to you, work the batches yourself one batch at a time — never collapse them back into a single skim.

4. HUNT — for each changed file, work the hunt list below. Collect candidates WITHOUT filtering: at this step you are not deciding whether anything is worth reporting, only whether it might be wrong. Write every suspicion down, even weak ones. Do not stop at the first finding in a file.

5. VERIFY each candidate before it survives — this is where filtering happens, not in step 4. Open the definition, the caller, the type, the schema, the sibling call site; trace concrete values. Keep a candidate only if you can state: **these inputs → this wrong result**. If you cannot, drop it silently. A candidate you merely could not confirm is dropped, not reported — but "I did not check" is not a reason to drop, go check.
   - EXCEPT section G (test files added or grown): a junk test has no wrong output to trace, so this gate would drop the whole class. Verify it by its own question — open the file and ask what real breakage it would catch. "None" means it survives to step 6.

6. REPORT FILTER. Post only verified findings from the hunt list's reportable classes, plus junk tests (section G) — those are reportable even though nothing is "broken". Post nothing from the "Do NOT report" section — no style, no naming, no dead code, no praise, no summary. If nothing survived verification, post nothing at all.

7. POST all surviving findings as INLINE comments on the exact changed line (RIGHT side of the diff), in ONE review call:
   \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` where the JSON has a "comments" array of {path, line, side: "RIGHT", body}. Never post a single big summary comment instead of inline comments.
   - Every comment MUST include the fix as code: a \`\`\`suggestion block when the fix fits within the commented line(s); otherwise a short code snippet.
   - Style: English, basic vocabulary, short sentences. Problem → impact → fix. No long paragraphs.
   - Comment-only: do NOT approve, do NOT request changes.

────────────────────── HUNT LIST ──────────────────────
${checklist}
───────────────────── END HUNT LIST ─────────────────────

End your final message with exactly these lines:
REVIEW_STATUS: <reviewed | skipped — "skipped" if the PRE-CHECK stopped you (my own PR, already reviewed with no new commits, or closed/merged) or you could not review the PR at all. Only "reviewed" means you actually read this diff.>
REVIEW_FILES: <files you actually read>/<total changed files in the PR>
REVIEW_CANDIDATES: <candidates found in step 4>/<how many survived verification in step 5>
REVIEW_TESTS: <test files you flagged as junk>/<test files this PR adds or grows> (0/0 if it touches none)
REVIEW_COMMENTS: <number of inline comments you posted, 0 if none>
SLACK_REPLY: <one short sentence in ${detectLang(mention.text) === "vi" ? "Vietnamese" : "English"} (match the language of the Slack message above, ignore the context block): if comments were posted, say you added review comments on the PR; if zero, say the PR looks good to you>`;
}

/**
 * What the worker reported, and what (if anything) belongs in the Slack thread.
 *
 * threadReply is null whenever the diff was NOT actually reviewed. A pre-check bail — my own PR,
 * one I already reviewed, one already closed/merged — reports 0 comments just like a clean review
 * does, and answering "LGTM!" to that tells the team a PR was reviewed when nobody read it. Those
 * cases stay a self-DM. An unparseable result also gets no reply.
 *
 * `coverage` carries the worker's own account of what it read (files, candidates, test files
 * flagged — the last one only when the PR touched any, so it reads as a signal, not as noise). It never gates
 * the reply — it goes in the self-DM so a "clean" verdict on a 85-file PR is visible as the
 * suspicious thing it is, instead of reading exactly like a clean verdict on a 3-file PR.
 * @returns {{ commentCount: number, reviewed: boolean, slackReply: string, threadReply: string|null, coverage: string }}
 */
export function reviewOutcome(result) {
  const commentCount = Number.parseInt(result.match(/^REVIEW_COMMENTS:\s*(\d+)/m)?.[1] ?? "NaN", 10);
  const reviewed = result.match(/^REVIEW_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase() === "reviewed";
  const slackReply = result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  const files = result.match(/^REVIEW_FILES:\s*(\S+)/m)?.[1];
  const candidates = result.match(/^REVIEW_CANDIDATES:\s*(\S+)/m)?.[1];
  const tests = result.match(/^REVIEW_TESTS:\s*(\S+)/m)?.[1];
  const coverage = [
    files && `read ${files} files`,
    candidates && `${candidates} candidates verified`,
    tests && tests !== "0/0" && `flagged ${tests} test files`,
  ]
    .filter(Boolean)
    .join(", ");
  let threadReply = null;
  if (reviewed && !Number.isNaN(commentCount)) {
    threadReply = commentCount > 0 ? slackReply || "I added some review comments on the PR." : "LGTM!";
  }
  return { commentCount, reviewed, slackReply, threadReply, coverage };
}

export async function handlePrReview(ctx) {
  const { mention, classification, contextBlock, config, slack, selfId } = ctx;
  const pr = parsePrUrl(classification.prUrl) ?? parsePrUrl(mention.text + contextBlock);
  if (!pr) {
    await slack.postToSelf(
      selfId,
      `:warning: Review request detected but no GitHub PR link found.\n> ${classification.summary}\n${mention.permalink ?? ""}\nHandle it manually.`,
    );
    return { status: "no_pr_url" };
  }
  let repoPath;
  try {
    ({ repoPath } = ensureRepo({ reposRoot: config.reposRoot, repo: pr.repo, owner: pr.owner }));
  } catch (err) {
    log(`[review:${pr.repo}] no local checkout: ${err.message}`);
    await slack.postToSelf(
      selfId,
      `:warning: Can't review ${pr.url} — no local checkout of *${pr.repo}*: ${err.message}\nOriginal: ${mention.permalink ?? "n/a"}`,
    );
    return { status: "repo_missing", error: err.message };
  }

  const dmChannel = await slack.postToSelf(
    selfId,
    `:mag: *PR review picked up* — from @${mention.username ?? mention.user}\n` +
      `> ${pr.url}\n` +
      (config.workerGraceMs > 0
        ? `• *Starting in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel, before OR while it runs (review comments will be posted under YOUR GitHub account, and I'll reply in the Slack thread when done)\n`
        : "") +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, `review:${pr.repo}`)) {
    return { status: "cancelled_by_user" };
  }

  let worktreePath;
  try {
    log(`[review:${pr.repo}] preparing isolated worktree...`);
    worktreePath = createWorktree(repoPath, pr.repo, mention.ts, config.worktreesDir, config.baseBranch);
  } catch (err) {
    await slack.postToSelf(selfId, `:x: Could not prepare a worktree for reviewing ${pr.url}: ${err.message}`);
    return { status: "worktree_failed", error: err.message };
  }

  const startedAt = Date.now();
  log(`[review:${pr.repo}] reviewing PR #${pr.number} (timeout ${minutes(config.reviewTimeoutMs)} min)`);
  await slack.postToSelf(selfId, `:mag: *Reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)`);

  const { block: attachmentsBlock } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir: worktreePath,
    label: `review:${pr.repo}`,
  });

  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, `review:${pr.repo}`, controller);

  let result;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: reviewPrompt(ctx, pr, attachmentsBlock),
      cwd: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.reviewModel,
      fallbackModel: config.reviewFallbackModel,
      label: `review:${pr.repo}`,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* — killed the running review of ${pr.url} after ${minutes(Date.now() - startedAt)} min. If some comments were already posted, check the PR. ${mention.permalink ?? ""}`,
      );
      return { status: "cancelled_mid_task" };
    }
    throw err;
  } finally {
    stopWatching();
    removeWorktree(repoPath, worktreePath);
    log(`[review:${pr.repo}] finished after ${minutes(Date.now() - startedAt)} min, worktree removed`);
  }

  const outcome = reviewOutcome(result);
  const { commentCount, threadReply } = outcome;
  log(
    `[review:${pr.repo}] result: ${threadReply === null ? "no thread reply, " : ""}` +
      `${Number.isNaN(commentCount) ? "unparseable" : `${commentCount} comment(s)`}` +
      `${outcome.coverage ? ` — ${outcome.coverage}` : ""}`,
  );

  let repliedInThread = false;
  if (threadReply !== null && mention.channel?.id) {
    await slack.replyInThread(mention.channel.id, threadTsOf(mention), threadReply);
    repliedInThread = true;
  }

  await slack.postToSelf(
    selfId,
    trim(dmForOutcome({ pr, result, outcome, repliedInThread })),
  );
  return {
    status: outcome.reviewed ? "reviewed" : "skipped",
    comments: Number.isNaN(commentCount) ? null : commentCount,
    repliedInThread,
  };
}

/** Self-DM wording per outcome — a skipped review must never read like a completed one. */
function dmForOutcome({ pr, result, outcome, repliedInThread }) {
  const { commentCount, reviewed, slackReply, coverage } = outcome;
  const scope = coverage ? ` _(${coverage})_` : "";
  if (Number.isNaN(commentCount)) {
    return `:warning: PR review finished but I couldn't parse the result for ${pr.url} — check the PR manually.\n\nWorker output:\n${result}`;
  }
  if (!reviewed) {
    return `:information_source: *Review skipped* — ${pr.url} was not reviewed${slackReply ? `: ${slackReply}` : " (pre-check stopped it: my own PR, already reviewed, or closed/merged)"}\nNothing posted on the PR or in the Slack thread.`;
  }
  if (commentCount > 0) {
    return (
      `:white_check_mark: *PR review done* — posted ${commentCount} inline comment(s) on ${pr.url}${scope}` +
      (repliedInThread ? `\nReplied in the Slack thread.` : "\n:warning: Could not reply in the Slack thread — do it manually.")
    );
  }
  return (
    `:white_check_mark: *PR review done* — no real issues found on ${pr.url}.${scope}` +
    (repliedInThread ? ` Replied *LGTM!* in the Slack thread.` : ` (couldn't reply in the thread — do it manually.)`)
  );
}
