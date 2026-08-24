import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { parseAllPrUrls, parsePrUrl } from "../github.js";
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
7. If you found real issues, that review is COMMENT-only: do NOT approve and do NOT request changes — the inline comments carry the message.
8. If the PR has no real issues, post NO inline comments and APPROVE it instead, so the author is unblocked and can merge: \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=APPROVE -f body='LGTM!'\`.

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

  // A "stop" reply aborts the running reviews AND every PR still queued after them.
  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, "review", controller);
  // Review workers run in parallel (cap), but git setup is serialized: several `git fetch` /
  // `worktree add` on the SAME repo at once race on git's lock files.
  const gitMutex = makeMutex();
  let results;
  try {
    results = await runPool(prs, config.reviewConcurrency, (pr) =>
      controller.signal.aborted
        ? { pr, status: "cancelled" }
        : reviewOnePr({ ctx, pr, controller, gitMutex }),
    );
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
    // threadTs + per-PR session info persist into history.jsonl, so a later "I updated it"
    // reply in this thread can find and RESUME the very session that reviewed each PR.
    threadTs: threadTsOf(mention),
    prs: results.map((r) => ({
      url: r.pr.url,
      status: r.status,
      comments: r.outcome && !Number.isNaN(r.outcome.commentCount) ? r.outcome.commentCount : null,
      sessionId: r.sessionId ?? null,
      worktreePath: r.worktreePath ?? null,
    })),
    repliedInThread,
  };
}

// ── Review follow-ups ─────────────────────────────────────────────────────────
// The author replying "I updated them" in a review thread used to die in the classifier
// ("status update" → ignore), and even a correct classification would then trip the worker's
// never-double-review pre-check. Follow-ups are therefore routed DETERMINISTICALLY, before
// classification: a thread reply whose thread we already reviewed resumes the recorded
// review session(s) so the worker re-checks the update with its own prior context.

/**
 * Match a mention against recorded reviews: non-null when it is a THREAD REPLY into a
 * conversation whose review sessions we recorded in history. Pure — history entries in,
 * decision out.
 *
 * Returns null (→ normal classification) when the reply is not in a thread, the thread has
 * no recorded resumable review, or the reply links a PR we did NOT review there (that is a
 * new review request, not a follow-up). A reply linking a SUBSET of the reviewed PRs narrows
 * the follow-up to those; a reply with no PR links re-checks every recorded PR — each worker
 * bails cheaply on its own if its PR saw no new commits.
 * @returns {{ threadTs: string, prs: Array<{url, sessionId, worktreePath}> }|null}
 */
export function matchReviewFollowup(mention, entries) {
  const threadTs = mention.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1];
  if (!threadTs || threadTs === mention.ts) return null; // not a thread reply
  const channelId = mention.channel?.id;
  if (!channelId) return null;

  // Latest entry for this thread wins — a follow-up round re-records the sessions it used,
  // so chained "I updated it again" replies keep resuming the freshest state.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e?.key?.startsWith(`${channelId}:`) || e.result?.threadTs !== threadTs) continue;
    const resumable = (e.result.prs ?? []).filter((p) => p.url && p.sessionId && p.worktreePath);
    if (!resumable.length) continue; // pre-feature or all-failed entry — keep looking back
    const linked = parseAllPrUrls(mention.text ?? "");
    if (!linked.length) return { threadTs, prs: resumable };
    const known = new Set(resumable.map((p) => p.url));
    if (linked.some((l) => !known.has(l.url))) return null; // new PR in the reply → classifier
    return { threadTs, prs: resumable.filter((p) => linked.some((l) => l.url === p.url)) };
  }
  return null;
}

/** File-reading wrapper for matchReviewFollowup: scans history.jsonl (bad lines tolerated). */
export function findReviewFollowup(mention, historyFile) {
  if (!fs.existsSync(historyFile)) return null;
  const entries = fs
    .readFileSync(historyFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return matchReviewFollowup(mention, entries);
}

function followupPrompt({ mention, contextBlock }, pr) {
  return `[slack] Re-review PR #${pr.number} — ${pr.repo}. The author replied in the review thread after my earlier review of this PR — usually meaning they pushed an update and want it re-checked (and approved if it is now clean).

PR: ${pr.url} (repo ${pr.owner}/${pr.repo}, PR #${pr.number})

Their reply (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}
Workflow:
1. Run \`git fetch origin\`, then \`gh pr checkout ${pr.number}\`. If the PR is closed or merged, STOP: report REVIEW_STATUS: skipped and say why in SLACK_REPLY.
2. Establish what changed since my last review: \`gh api user --jq .login\` (me), \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews\` and \`.../pulls/${pr.number}/comments\` (my earlier findings), \`gh pr view ${pr.number} --json commits\`. If there are NO new commits since my last review and their reply points at nothing specific to look at, STOP: REVIEW_STATUS: skipped, and say in SLACK_REPLY that I found no new commits to re-check.
3. Verify EACH of my earlier findings against the CURRENT code — is the problem actually fixed? Trace the code; never trust commit messages. Then review the new commits for NEW real problems with the same bar as the original review: bugs, regressions, lost data/functionality, broken API contracts, security issues, backward-compatibility breaks. SKIP minor issues entirely (style, naming, dead code, formatting). If unsure whether an issue is real, skip it.
4. If an earlier finding is still broken or the update introduces a new real issue: post inline comments on the exact changed lines (RIGHT side), all in ONE review call — \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` with a "comments" array of {path, line, side: "RIGHT", body}. Every comment includes the fix as a \`\`\`suggestion block or a short snippet; short basic English, prose under 200 characters per comment. Do NOT approve.
5. If everything I flagged is fixed and nothing new is broken: approve — \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=APPROVE -f body='LGTM!'\`. If I already approved AFTER their latest commit (an APPROVED review of mine newer than the head commit), do not approve again — just report reviewed with 0 comments.

End your final message with exactly these lines:
REVIEW_STATUS: <reviewed | skipped — "skipped" only if you did not actually evaluate the update (closed/merged, no new commits, or you could not review at all)>
REVIEW_COMMENTS: <number of NEW inline comments you posted this run, 0 if none>
SLACK_REPLY: <one short sentence in ${detectLang(mention.text) === "vi" ? "Vietnamese" : "English"}: what you found re-checking their update>`;
}

/**
 * Handle a follow-up reply in an already-reviewed thread: resume each recorded review
 * session so it re-checks the author's update. Mirrors handlePrReview's grace window,
 * stop watching, concurrency cap, single thread reply, and self-DM summary.
 */
export async function handlePrReviewFollowup(ctx) {
  const { mention, config, slack, selfId, followup } = ctx;
  // Recorded entries carry only the url — re-derive owner/repo/number for prompts and labels.
  const prs = followup.prs
    .map((p) => ({ ...(parsePrUrl(p.url) ?? {}), ...p }))
    .filter((p) => p.number);
  if (!prs.length) return { status: "no_pr_url" };

  const dmChannel = await slack.postToSelf(
    selfId,
    `:repeat: *PR review follow-up picked up* — @${mention.username ?? mention.user} replied in a reviewed thread:\n` +
      `> ${(mention.text ?? "").slice(0, 200)}\n` +
      prs.map((p) => `> ${p.url}`).join("\n") +
      "\n" +
      (config.workerGraceMs > 0
        ? `• *Starting in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel, before OR while it runs\n`
        : "") +
      `• Resuming the original review session${prs.length > 1 ? "s" : ""} to re-check the update\n` +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, "review-followup")) {
    return { status: "cancelled_by_user" };
  }

  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, "review-followup", controller);
  const gitMutex = makeMutex();
  let results;
  try {
    results = await runPool(prs, config.reviewConcurrency, (pr) =>
      controller.signal.aborted ? { pr, status: "cancelled" } : followupOnePr({ ctx, pr, controller, gitMutex }),
    );
  } finally {
    stopWatching();
  }

  const reviewed = results.filter((r) => r.status === "reviewed");
  const threadReply = buildFollowupThreadReply(reviewed);
  let repliedInThread = false;
  if (threadReply && mention.channel?.id) {
    await slack.replyInThread(mention.channel.id, followup.threadTs, threadReply);
    repliedInThread = true;
  }

  await slack.postToSelf(
    selfId,
    trim(buildSummaryDm({ results, mention, repliedInThread, title: "PR review follow-up done" })),
  );
  return {
    status: reviewed.length ? "reviewed" : (results[0]?.status ?? "skipped"),
    threadTs: followup.threadTs,
    prs: results.map((r) => ({
      url: r.pr.url,
      status: r.status,
      comments: r.outcome && !Number.isNaN(r.outcome.commentCount) ? r.outcome.commentCount : null,
      sessionId: r.sessionId ?? r.pr.sessionId ?? null,
      worktreePath: r.worktreePath ?? r.pr.worktreePath ?? null,
    })),
    repliedInThread,
  };
}

/**
 * Re-check one PR's update, preferring to RESUME its recorded session in its kept worktree
 * (the worker then remembers the root causes it traced). A pruned worktree falls back to a
 * fresh worktree + fresh session — the prompt is self-contained (it re-reads my earlier
 * comments from GitHub), so the fallback reviews just as correctly, only with less memory.
 */
async function followupOnePr({ ctx, pr, controller, gitMutex = (fn) => fn() }) {
  const { mention, config, slack, selfId } = ctx;
  const label = `review-followup:${pr.repo}#${pr.number}`;

  let worktreePath = pr.worktreePath;
  let resumeSessionId = pr.sessionId;
  let createdFresh = false;
  let repoPath = null;
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    try {
      ({ repoPath } = await gitMutex(() => ensureRepo({ reposRoot: config.reposRoot, repo: pr.repo, owner: pr.owner })));
    } catch (err) {
      log(`[${label}] no local checkout: ${err.message}`);
      await slack.postToSelf(selfId, `:warning: Can't re-review ${pr.url} — no local checkout of *${pr.repo}*: ${err.message}`);
      return { pr, status: "repo_missing", error: err.message };
    }
    try {
      worktreePath = await gitMutex(() =>
        createWorktree(repoPath, pr.repo, `${mention.ts}-pr${pr.number}`, config.worktreesDir, config.baseBranch),
      );
    } catch (err) {
      await slack.postToSelf(selfId, `:x: Could not prepare a worktree for re-reviewing ${pr.url}: ${err.message}`);
      return { pr, status: "worktree_failed", error: err.message };
    }
    createdFresh = true;
    resumeSessionId = null; // session transcripts are keyed by cwd — a new worktree needs a new session
  }

  let sessionId = resumeSessionId ?? newSessionId();
  const startedAt = Date.now();
  log(
    `[${label}] re-reviewing PR #${pr.number} (${resumeSessionId ? "resuming session" : "fresh session"} ${sessionId}, timeout ${minutes(config.reviewTimeoutMs)} min)`,
  );
  await slack.postToSelf(
    selfId,
    `:repeat: *Re-reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)\n:technologist: ${resumeHint(worktreePath, sessionId)}`,
  );

  const run = (resume) =>
    runClaude({
      bin: config.claudeBin,
      prompt: followupPrompt(ctx, pr),
      cwd: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.reviewModel,
      label,
      signal: controller.signal,
      ...(resume ? { resumeSessionId: resume } : { sessionId }),
    });

  let result;
  let discarded = false;
  try {
    try {
      result = await run(resumeSessionId);
    } catch (err) {
      // The worktree can outlive the session transcript (e.g. cleared ~/.claude). That exact
      // failure retries ONCE as a fresh session; any other error is a real one and propagates.
      if (resumeSessionId && !(err instanceof CancelledError) && /no conversation found/i.test(err.message)) {
        log(`[${label}] session ${resumeSessionId} not resumable (${err.message.slice(0, 120)}) — retrying fresh`);
        resumeSessionId = null;
        sessionId = newSessionId();
        result = await run(null);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      discarded = true;
      // Only a worktree WE created this round is ours to discard — the original review's
      // worktree must stay resumable.
      if (createdFresh && repoPath) removeWorktree(repoPath, worktreePath);
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* — killed the re-review of ${pr.url} after ${minutes(Date.now() - startedAt)} min. If some comments were already posted, check the PR.`,
      );
      return { pr, status: "cancelled" };
    }
    throw err;
  } finally {
    if (!discarded) {
      log(`[${label}] finished after ${minutes(Date.now() - startedAt)} min — resume: cd ${worktreePath} && claude --resume ${sessionId}`);
      showInDesktopApp(sessionId);
    }
  }

  const outcome = reviewOutcome(result);
  const status = !outcome.reviewed ? "skipped" : Number.isNaN(outcome.commentCount) ? "unparseable" : "reviewed";
  log(`[${label}] result: ${status}${status === "reviewed" ? ` (${outcome.commentCount} new comment(s))` : ""}`);
  return { pr, status, outcome, result, worktreePath, sessionId };
}

/** Thread reply for a follow-up round — same only-if-actually-reviewed rule as buildThreadReply. */
export function buildFollowupThreadReply(reviewed) {
  if (!reviewed.length) return null;
  const line = (c) => (c > 0 ? `left ${c} more comment${c === 1 ? "" : "s"} on the PR` : "LGTM!");
  if (reviewed.length === 1) {
    const c = reviewed[0].outcome.commentCount;
    return c > 0 ? `Re-checked — ${line(c)}.` : "Re-checked the update — LGTM!";
  }
  return `Re-checked ${reviewed.length} PRs:\n${reviewed
    .map((r) => `• #${r.pr.number} — ${r.outcome.commentCount > 0 ? `${r.outcome.commentCount} more comment${r.outcome.commentCount === 1 ? "" : "s"}` : "LGTM"}`)
    .join("\n")}`;
}

/**
 * Review a single PR in its own isolated worktree + session. Never throws for an expected
 * failure (missing checkout, worktree error, user stop) — returns a status the caller folds
 * into the batch summary. Only a truly unexpected error propagates.
 * @returns {Promise<{ pr, status: "reviewed"|"skipped"|"unparseable"|"cancelled"|"repo_missing"|"worktree_failed", outcome?, result?, worktreePath?, sessionId? }>}
 */
async function reviewOnePr({ ctx, pr, controller, gitMutex = (fn) => fn() }) {
  const { mention, config, slack, selfId } = ctx;
  const label = `review:${pr.repo}#${pr.number}`;

  let repoPath;
  try {
    // Serialized: a clone/fetch racing another on the same repo trips git's lock files.
    ({ repoPath } = await gitMutex(() => ensureRepo({ reposRoot: config.reposRoot, repo: pr.repo, owner: pr.owner })));
  } catch (err) {
    log(`[${label}] no local checkout: ${err.message}`);
    await slack.postToSelf(selfId, `:warning: Can't review ${pr.url} — no local checkout of *${pr.repo}*: ${err.message}`);
    return { pr, status: "repo_missing", error: err.message };
  }

  let worktreePath;
  try {
    // Suffix the PR number: several PRs from one message share mention.ts and would otherwise
    // collide on the same worktree path. Serialized via gitMutex (fetch + worktree add).
    worktreePath = await gitMutex(() =>
      createWorktree(repoPath, pr.repo, `${mention.ts}-pr${pr.number}`, config.worktreesDir, config.baseBranch),
    );
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

/**
 * A promise chain that runs the functions handed to it one at a time, in call order — a mutex.
 * Used to serialize git worktree setup across parallel reviews. A rejection in one job does not
 * break the chain for the next.
 */
function makeMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/**
 * Run `worker(item, i)` over items with at most `limit` in flight, preserving input order in the
 * returned results array. A worker that throws rejects the whole pool — callers keep worker
 * failures internal (reviewOnePr returns a status object, never throws for expected failures).
 */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, runner));
  return results;
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
function buildSummaryDm({ results, mention, repliedInThread, title = "PR review done" }) {
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
  const header = results.length > 1 ? `*${title} — ${results.length} PRs*` : `*${title}*`;
  return (
    `${header}\n${results.map(line).join("\n")}\n` +
    (repliedInThread
      ? `Replied in the Slack thread.`
      : `:information_source: No thread reply (nothing was actually reviewed).`) +
    `\nOriginal: ${mention.permalink ?? "n/a"}`
  );
}
