import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { parsePrUrl } from "../github.js";
import { log } from "../log.js";
import { cancelledDuringGrace, detectLang, minutes, newSessionId, resumeHint, showInDesktopApp, threadTsOf, trim, watchForStop } from "./shared.js";

function reviewPrompt({ mention, contextBlock }, pr, attachmentsBlock) {
  // The first line becomes the session's title in the Claude desktop app (it copies the opening
  // line of an imported CLI session verbatim), so lead with a "[slack]" tag + what/where.
  return `[slack] Review PR #${pr.number} — ${pr.repo}. A teammate asked me to review this pull request and post inline comments under MY GitHub account.

PR: ${pr.url} (repo ${pr.owner}/${pr.repo}, PR #${pr.number})

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}${attachmentsBlock}
Workflow:
1. PRE-CHECK first: run \`gh api user --jq .login\` and \`gh pr view ${pr.number} --json author,state,isDraft,reviews,comments\`. STOP immediately and post nothing (report REVIEW_STATUS: skipped, REVIEW_COMMENTS: 0, and say why in SLACK_REPLY) if ANY of these holds:
   - the PR author is me (never review my own PR),
   - I already submitted a review or comments on this PR (never double-review),
   - the PR is closed or merged.
2. You are in an isolated git worktree of this repository. Run \`gh pr checkout ${pr.number}\`, then \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\`. Read surrounding source files and callers for full context and trace each suspicion to its ROOT CAUSE — do not judge from the diff alone, and do not report a symptom when the real defect is one level deeper.
3. Many of these PRs are AI-generated: they read plausible and confident while hiding subtle wrongness (invented APIs, half-applied renames, tests that assert the mock). Never rubber-stamp — verify the diff's claims against the real code and docs. Review ONLY for real problems: bugs, regressions, lost data/functionality, broken API contracts, security issues, backward-compatibility breaks. SKIP minor issues entirely — style nits, naming, dead code, duplication notes, formatting, log wording. A prop/field/variable that is declared but never read is DEAD CODE: skip it, even when you can imagine a consumer being surprised. Comment only where a user or caller gets a wrong result. If unsure whether an issue is real, skip it.
4. Post findings as INLINE comments on the exact changed line (RIGHT side of the diff), all in ONE review call:
   \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` where the JSON has a "comments" array of {path, line, side: "RIGHT", body}. Never post a single big summary comment instead of inline comments.
5. Every comment MUST include the fix as code: a \`\`\`suggestion block when the fix fits within the commented line(s); otherwise a short code snippet showing the fix.
6. Comment style: English with basic vocabulary, short clear sentences. State the problem, the impact, then the fix. No long paragraphs — each comment's prose must stay under 200 characters (\`\`\`suggestion\`\`\`/code blocks do not count toward the limit).
7. Comment-only review: do NOT approve, do NOT request changes.
8. If the PR has no real issues, post nothing at all.

End your final message with exactly these lines:
REVIEW_STATUS: <reviewed | skipped — "skipped" if the PRE-CHECK stopped you (my own PR, I already reviewed it, or it is closed/merged) or you could not review the PR at all. Only "reviewed" means you actually read this diff.>
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
 * The thread reply always states the OUTCOME COUNT — "reviewed, N comment(s)" or "LGTM!" — built
 * from commentCount, not from the worker's free-text SLACK_REPLY (which often omits the number the
 * team wants to see at a glance).
 * @returns {{ commentCount: number, reviewed: boolean, slackReply: string, threadReply: string|null }}
 */
export function reviewOutcome(result) {
  const commentCount = Number.parseInt(result.match(/^REVIEW_COMMENTS:\s*(\d+)/m)?.[1] ?? "NaN", 10);
  const reviewed = result.match(/^REVIEW_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase() === "reviewed";
  const slackReply = result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  let threadReply = null;
  if (reviewed && !Number.isNaN(commentCount)) {
    threadReply =
      commentCount > 0
        ? `Reviewed — left ${commentCount} comment${commentCount === 1 ? "" : "s"} on the PR.`
        : "LGTM!";
  }
  return { commentCount, reviewed, slackReply, threadReply };
}

export async function handlePrReview(ctx) {
  const { mention, classification, contextBlock, config, slack, selfId } = ctx;
  // One Slack message often lists several PRs — review EVERY one, not just the first.
  const prs = parseAllPrUrls(`${classification.prUrl ?? ""}\n${mention.text ?? ""}\n${contextBlock}`);
  if (!prs.length) {
    await slack.postToSelf(
      selfId,
      `:warning: Review request detected but no GitHub PR link found.\n> ${classification.summary}\n${mention.permalink ?? ""}\nHandle it manually.`,
    );
    return { status: "no_pr_url" };
  }

  const many = prs.length > 1;
  const dmChannel = await slack.postToSelf(
    selfId,
    `:mag: *PR review picked up* — from @${mention.username ?? mention.user}\n` +
      prs.map((p) => `> ${p.url}`).join("\n") +
      "\n" +
      (config.workerGraceMs > 0
        ? `• *Starting in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel, before OR while it runs (comments posted under YOUR GitHub account; I'll reply in the Slack thread when done)\n`
        : "") +
      (many ? `• ${prs.length} PRs — reviewed one by one, with a single thread reply at the end\n` : "") +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, "review")) {
    return { status: "cancelled_by_user" };
  }

  // A "stop" reply aborts the current review AND every PR still queued after it.
  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, "review", controller);
  const results = [];
  try {
    for (const pr of prs) {
      if (controller.signal.aborted) {
        results.push({ pr, status: "cancelled" });
        continue;
      }
      results.push(await reviewOnePr({ ctx, pr, controller }));
    }
  } finally {
    stopWatching();
  }

  // One thread reply, covering only the PRs actually reviewed (a pre-check bail or a crash
  // must never read as "reviewed" to the team — those stay in the self-DM).
  const reviewed = results.filter((r) => r.status === "reviewed");
  const threadReply = buildThreadReply(reviewed);
  let repliedInThread = false;
  if (threadReply && mention.channel?.id) {
    await slack.replyInThread(mention.channel.id, threadTsOf(mention), threadReply);
    repliedInThread = true;
  }

  await slack.postToSelf(selfId, trim(buildSummaryDm({ results, mention, repliedInThread })));
  return {
    status: reviewed.length ? "reviewed" : (results[0]?.status ?? "skipped"),
    prs: results.map((r) => ({
      url: r.pr.url,
      status: r.status,
      comments: r.outcome && !Number.isNaN(r.outcome.commentCount) ? r.outcome.commentCount : null,
    })),
    repliedInThread,
  };
}

/**
 * Review a single PR in its own isolated worktree + session. Never throws for an expected
 * failure (missing checkout, worktree error, user stop) — returns a status the caller folds
 * into the batch summary. Only a truly unexpected error propagates.
 * @returns {Promise<{ pr, status: "reviewed"|"skipped"|"unparseable"|"cancelled"|"repo_missing"|"worktree_failed", outcome?, result?, worktreePath?, sessionId? }>}
 */
async function reviewOnePr({ ctx, pr, controller }) {
  const { mention, config, slack, selfId } = ctx;
  const label = `review:${pr.repo}#${pr.number}`;

  let repoPath;
  try {
    ({ repoPath } = ensureRepo({ reposRoot: config.reposRoot, repo: pr.repo, owner: pr.owner }));
  } catch (err) {
    log(`[${label}] no local checkout: ${err.message}`);
    await slack.postToSelf(selfId, `:warning: Can't review ${pr.url} — no local checkout of *${pr.repo}*: ${err.message}`);
    return { pr, status: "repo_missing", error: err.message };
  }

  let worktreePath;
  try {
    // Suffix the PR number: several PRs from one message share mention.ts and would otherwise
    // collide on the same worktree path.
    worktreePath = createWorktree(repoPath, pr.repo, `${mention.ts}-pr${pr.number}`, config.worktreesDir, config.baseBranch);
  } catch (err) {
    await slack.postToSelf(selfId, `:x: Could not prepare a worktree for reviewing ${pr.url}: ${err.message}`);
    return { pr, status: "worktree_failed", error: err.message };
  }

  const sessionId = newSessionId();
  const startedAt = Date.now();
  log(`[${label}] reviewing PR #${pr.number} (session ${sessionId}, timeout ${minutes(config.reviewTimeoutMs)} min)`);
  await slack.postToSelf(
    selfId,
    `:mag: *Reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)\n` +
      `:technologist: ${resumeHint(worktreePath, sessionId)}`,
  );

  const { block: attachmentsBlock } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir: worktreePath,
    label,
  });

  let result;
  let discarded = false;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: reviewPrompt(ctx, pr, attachmentsBlock),
      cwd: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.reviewModel,
      label,
      signal: controller.signal,
      sessionId,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      discarded = true;
      removeWorktree(repoPath, worktreePath);
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* — killed the review of ${pr.url} after ${minutes(Date.now() - startedAt)} min. If some comments were already posted, check the PR.`,
      );
      return { pr, status: "cancelled" };
    }
    throw err;
  } finally {
    // Any non-cancelled outcome keeps the worktree — the session stays resumable in Claude Code.
    if (!discarded) {
      log(`[${label}] finished after ${minutes(Date.now() - startedAt)} min — resume: cd ${worktreePath} && claude --resume ${sessionId}`);
      showInDesktopApp(sessionId);
    }
  }

  const outcome = reviewOutcome(result);
  const status = !outcome.reviewed ? "skipped" : Number.isNaN(outcome.commentCount) ? "unparseable" : "reviewed";
  log(`[${label}] result: ${status}${status === "reviewed" ? ` (${outcome.commentCount} comment(s))` : ""}`);
  return { pr, status, outcome, result, worktreePath, sessionId };
}

/** The single thread reply for a batch. One PR keeps the original wording; several get a list. */
export function buildThreadReply(reviewed) {
  if (!reviewed.length) return null;
  if (reviewed.length === 1) return reviewed[0].outcome.threadReply;
  const lines = reviewed.map((r) => {
    const c = r.outcome.commentCount;
    return `• #${r.pr.number} — ${c > 0 ? `${c} comment${c === 1 ? "" : "s"}` : "LGTM"}`;
  });
  return `Reviewed ${reviewed.length} PRs:\n${lines.join("\n")}`;
}

/** Self-DM: one line per PR with its real outcome — a skipped/failed one must never read as reviewed. */
function buildSummaryDm({ results, mention, repliedInThread }) {
  const line = (r) => {
    const c = r.outcome?.commentCount;
    switch (r.status) {
      case "reviewed":
        return `:white_check_mark: ${r.pr.url} — ${c > 0 ? `${c} inline comment${c === 1 ? "" : "s"}` : "no issues (LGTM)"}`;
      case "skipped":
        return `:information_source: ${r.pr.url} — skipped${r.outcome?.slackReply ? `: ${r.outcome.slackReply}` : " (pre-check: my own PR, already reviewed, or closed/merged)"}`;
      case "unparseable":
        return `:warning: ${r.pr.url} — couldn't parse the worker result, check the PR manually`;
      case "cancelled":
        return `:no_entry: ${r.pr.url} — stopped`;
      case "repo_missing":
        return `:warning: ${r.pr.url} — no local checkout of that repo`;
      case "worktree_failed":
        return `:x: ${r.pr.url} — worktree failed`;
      default:
        return `:grey_question: ${r.pr.url} — ${r.status}`;
    }
  };
  const header = results.length > 1 ? `*PR review done — ${results.length} PRs*` : `*PR review done*`;
  return (
    `${header}\n${results.map(line).join("\n")}\n` +
    (repliedInThread
      ? `Replied in the Slack thread.`
      : `:information_source: No thread reply (nothing was actually reviewed).`) +
    `\nOriginal: ${mention.permalink ?? "n/a"}`
  );
}
