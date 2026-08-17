import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { parsePrUrl } from "../github.js";
import { log } from "../log.js";
import { cancelledDuringGrace, detectLang, minutes, newSessionId, resumeHint, showInDesktopApp, threadTsOf, trim, watchForStop } from "./shared.js";

function reviewPrompt({ mention, contextBlock }, pr, attachmentsBlock) {
  return `A teammate asked me to review a pull request. Review it and post inline comments under MY GitHub account.

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
 * @returns {{ commentCount: number, reviewed: boolean, slackReply: string, threadReply: string|null }}
 */
export function reviewOutcome(result) {
  const commentCount = Number.parseInt(result.match(/^REVIEW_COMMENTS:\s*(\d+)/m)?.[1] ?? "NaN", 10);
  const reviewed = result.match(/^REVIEW_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase() === "reviewed";
  const slackReply = result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  let threadReply = null;
  if (reviewed && !Number.isNaN(commentCount)) {
    threadReply = commentCount > 0 ? slackReply || "I added some review comments on the PR." : "LGTM!";
  }
  return { commentCount, reviewed, slackReply, threadReply };
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

  const sessionId = newSessionId();
  const startedAt = Date.now();
  log(`[review:${pr.repo}] reviewing PR #${pr.number} (session ${sessionId}, timeout ${minutes(config.reviewTimeoutMs)} min)`);
  await slack.postToSelf(
    selfId,
    `:mag: *Reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)\n` +
      `:technologist: Pick it up in Claude Code afterwards (any outcome): ${resumeHint(worktreePath, sessionId)}`,
  );

  const { block: attachmentsBlock } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir: worktreePath,
    label: `review:${pr.repo}`,
  });

  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, `review:${pr.repo}`, controller);

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
      label: `review:${pr.repo}`,
      signal: controller.signal,
      sessionId,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      discarded = true;
      removeWorktree(repoPath, worktreePath);
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* — killed the running review of ${pr.url} after ${minutes(Date.now() - startedAt)} min. If some comments were already posted, check the PR. ${mention.permalink ?? ""}`,
      );
      return { status: "cancelled_mid_task" };
    }
    throw err;
  } finally {
    stopWatching();
    // Any non-cancelled outcome keeps the worktree — the review session can be
    // reopened in Claude Code (e.g. to apply the findings right there).
    if (!discarded) {
      log(`[review:${pr.repo}] finished after ${minutes(Date.now() - startedAt)} min — resume: cd ${worktreePath} && claude --resume ${sessionId}`);
      showInDesktopApp(sessionId);
    }
  }

  const outcome = reviewOutcome(result);
  const { commentCount, threadReply } = outcome;
  log(`[review:${pr.repo}] result: ${threadReply === null ? "no thread reply, " : ""}${Number.isNaN(commentCount) ? "unparseable" : `${commentCount} comment(s)`}`);

  let repliedInThread = false;
  if (threadReply !== null && mention.channel?.id) {
    await slack.replyInThread(mention.channel.id, threadTsOf(mention), threadReply);
    repliedInThread = true;
  }

  await slack.postToSelf(
    selfId,
    trim(dmForOutcome({ pr, result, outcome, repliedInThread }) + `\n:technologist: Session is in the Claude desktop app now — or in terminal: ${resumeHint(worktreePath, sessionId)}`),
  );
  return {
    status: outcome.reviewed ? "reviewed" : "skipped",
    comments: Number.isNaN(commentCount) ? null : commentCount,
    repliedInThread,
    sessionId,
    worktreePath,
  };
}

/** Self-DM wording per outcome — a skipped review must never read like a completed one. */
function dmForOutcome({ pr, result, outcome, repliedInThread }) {
  const { commentCount, reviewed, slackReply } = outcome;
  if (Number.isNaN(commentCount)) {
    return `:warning: PR review finished but I couldn't parse the result for ${pr.url} — check the PR manually.\n\nWorker output:\n${result}`;
  }
  if (!reviewed) {
    return `:information_source: *Review skipped* — ${pr.url} was not reviewed${slackReply ? `: ${slackReply}` : " (pre-check stopped it: my own PR, already reviewed, or closed/merged)"}\nNothing posted on the PR or in the Slack thread.`;
  }
  if (commentCount > 0) {
    return (
      `:white_check_mark: *PR review done* — posted ${commentCount} inline comment(s) on ${pr.url}` +
      (repliedInThread ? `\nReplied in the Slack thread.` : "\n:warning: Could not reply in the Slack thread — do it manually.")
    );
  }
  return (
    `:white_check_mark: *PR review done* — no real issues found on ${pr.url}.` +
    (repliedInThread ? ` Replied *LGTM!* in the Slack thread.` : ` (couldn't reply in the thread — do it manually.)`)
  );
}
