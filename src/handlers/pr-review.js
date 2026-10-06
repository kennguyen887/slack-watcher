import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { approvePr, checkoutPr, myReviewState, parseAllPrUrls, parsePrUrl, waitForChecks } from "../github.js";
import { log } from "../log.js";
import { reviewSpec } from "../ocr.js";
import { cancelledDuringGrace, detectLang, minutes, newSessionId, resumeCommand, resumeHint, showInDesktopApp, threadTsOf, trim, watchForStop } from "./shared.js";

function reviewPrompt({ mention, contextBlock }, pr, attachmentsBlock, ocrBlock = "") {
  // The first line becomes the session's title in the Claude desktop app (it copies the opening
  // line of an imported CLI session verbatim), so lead with a "[slack]" tag + what/where.
  return `[slack] Review PR #${pr.number} — ${pr.repo}. A teammate asked me to review this pull request and post inline comments under MY GitHub account.

PR: ${pr.url} (repo ${pr.owner}/${pr.repo}, PR #${pr.number})

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}${attachmentsBlock}${ocrBlock}
Workflow:
1. PRE-CHECK first: run \`gh api user --jq .login\` and \`gh pr view ${pr.number} --json author,state,isDraft,reviews,comments\`. STOP immediately and post nothing (report REVIEW_STATUS: skipped, REVIEW_COMMENTS: 0, and say why in SLACK_REPLY) if ANY of these holds:
   - the PR author is me (never review my own PR),
   - I already submitted a review or comments on this PR (never double-review),
   - the PR is closed or merged.
2. You are in an isolated git worktree of this repository, already checked out at this PR's head (re-run \`gh pr checkout ${pr.number}\` if that is not the case). Run \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\`.${ocrBlock ? ` Work through the review spec above file by file and cover EVERY file it lists — say in your report how many you covered. Its checklist tells you what to LOOK for; whether a finding is worth a comment is decided by step 3 alone.` : ""} Read surrounding source files and callers for full context and trace each suspicion to its ROOT CAUSE — do not judge from the diff alone, and do not report a symptom when the real defect is one level deeper.
3. Many of these PRs are AI-generated: they read plausible and confident while hiding subtle wrongness (invented APIs, half-applied renames, tests that assert the mock). Never rubber-stamp — verify the diff's claims against the real code and docs. Review ONLY for real problems: bugs, regressions, lost data/functionality, broken API contracts, security issues, backward-compatibility breaks. SKIP minor issues entirely — style nits, naming, dead code, duplication notes, formatting, log wording. A prop/field/variable that is declared but never read is DEAD CODE: skip it, even when you can imagine a consumer being surprised. Comment only where a user or caller gets a wrong result. If unsure whether an issue is real, skip it. FRONTEND TESTS: a frontend app (React/Next pages, components, hooks, stores) ships no unit tests on purpose, so never ask for one there and never treat "this is untested" as a finding — and when the PR ADDS a frontend test file (\`*.test.*\`, \`*.spec.*\`, anything under \`__tests__/\`), post ONE comment on its first added line asking for the file to be deleted, with no \`\`\`suggestion block and nothing said about its contents. A frontend test file the PR only MODIFIES is left alone, and a BACKEND test suite (a repo's own \`test/\` or \`tests/\` directory) is never touched by this rule.
4. Post findings as INLINE comments on the exact changed line (RIGHT side of the diff), all in ONE review call:
   \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` where the JSON has a "comments" array of {path, line, side: "RIGHT", body}. Never post a single big summary comment instead of inline comments. Each \`line\` must be a line this PR actually adds or changes — check it against the file's patch (\`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files\`) BEFORE posting, because GitHub rejects the WHOLE review with 422 over one out-of-diff line and then nothing lands. If it still 422s, fix the offending line and re-post the review — never fall back to a summary comment.
5. Every comment MUST include the fix as code: a \`\`\`suggestion block when the fix fits within the commented line(s); otherwise a short code snippet showing the fix. The one exception is the "delete this frontend test file" comment from step 3 — there is no code to suggest for deleting a file.
6. Comment style: English with basic vocabulary, short clear sentences. State the problem, the impact, then the fix. No long paragraphs — each comment's prose must stay under 200 characters (\`\`\`suggestion\`\`\`/code blocks do not count toward the limit).
7. If you found real issues, that review is COMMENT-only: do NOT approve and do NOT request changes — the inline comments carry the message.
8. CI: run \`gh pr checks ${pr.number}\`. For EVERY failed check (lint, typecheck/tsc, tests, build) read its log (\`gh run view <run-id> --log-failed\`) and find the root cause. A failure caused by this PR is a real issue: post it as an inline comment on the offending changed line with the fix. A failure the diff did not cause (flaky test, base branch already red, infra) gets no comment — name it in SLACK_REPLY instead. A green diff with red CI is NOT clean: I never approve while any check is failing or still running.
9. If the PR has no real issues, post NOTHING and simply report REVIEW_COMMENTS: 0 — I submit the approving review myself from your report, so the author is unblocked either way. Do NOT run an approve command.

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
  // status is the raw contract word; only follow-ups use values beyond reviewed/skipped
  // ("resolved" — see followupPrompt). Initial reviews keep the reviewed-or-silent rule.
  const status = result.match(/^REVIEW_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase() ?? null;
  const reviewed = status === "reviewed";
  const slackReply = result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  let threadReply = null;
  if (reviewed && !Number.isNaN(commentCount)) {
    threadReply =
      commentCount > 0
        ? `Reviewed — left ${commentCount} comment${commentCount === 1 ? "" : "s"} on the PR.`
        : "LGTM!";
  }
  return { commentCount, reviewed, status, slackReply, threadReply };
}

/**
 * What GitHub proves about a reported review, and what still has to happen.
 *
 * The worker DECIDES (clean, or N inline comments); submitting the approval is boilerplate, so the
 * decision stays with the worker and the ACTION lives here. Anything the worker claims that GitHub
 * does not hold is a mismatch — the team must never hear about a review that never landed.
 * @returns {{ needsApprove: boolean, verified: boolean, mismatch: string|null }}
 */
export function verifyOutcome(outcome, state) {
  if (!outcome.reviewed || Number.isNaN(outcome.commentCount)) {
    return { needsApprove: false, verified: false, mismatch: null };
  }
  if (outcome.commentCount > 0) {
    return state.comments > 0
      ? { needsApprove: false, verified: true, mismatch: null }
      : {
          needsApprove: false,
          verified: false,
          mismatch: `reported ${outcome.commentCount} inline comment(s), GitHub has none from ${state.login}`,
        };
  }
  if (state.approved) return { needsApprove: false, verified: true, mismatch: null };
  // Closed or merged mid-review: the diff WAS read, there is just nothing left to approve.
  if (state.state !== "OPEN") return { needsApprove: false, verified: true, mismatch: null };
  return { needsApprove: true, verified: false, mismatch: null };
}

/**
 * Why a clean diff must NOT be approved yet, or null when CI allows it.
 *
 * A reviewer who reads only the diff approves PRs whose lint / tsc pipeline is red, and the author
 * merges on that approval. Pending checks are waited on (bounded); still pending, failed, or
 * unreadable → hold the approval. A repo that runs no checks has nothing to gate on.
 * @returns {Promise<{ checks: "failed"|"pending"|"unknown", names: string } | null>}
 */
async function ciGate(pr, label) {
  try {
    const status = await waitForChecks(pr.url, { timeoutMs: CI_WAIT_MS });
    if (status.checks === "green" || status.checks === "none") return null;
    log(`[${label}] holding approval — CI ${status.checks} ${status.failedChecks.join(", ")}`);
    return { checks: status.checks, names: status.failedChecks.join(", ") };
  } catch (err) {
    log(`[${label}] could not read CI status, holding approval: ${err.message}`);
    return { checks: "unknown", names: "" };
  }
}

const CI_WAIT_MS = 10 * 60_000;

/** The thread line for a clean diff whose approval CI is holding back. */
export function ciHoldReply(ci) {
  if (ci.checks === "failed") return `Code looks good, but CI is failing (${ci.names}) — reply here once it's green and I'll approve.`;
  if (ci.checks === "pending") return "Code looks good, but CI is still running — reply here once it's green and I'll approve.";
  return "Code looks good, but I couldn't read the CI status — not approving yet.";
}

/** Only comments from this run count, with slack for clock skew between this Mac and GitHub. */
const sinceIso = (startedAt) => new Date(startedAt - 5 * 60_000).toISOString();

/**
 * Reconcile one finished review with GitHub, and submit the approval when the diff came back clean.
 *
 * Regression (2026-08-26, commonground#2306): the worker ended with "no bugs found — approved" and
 * REVIEW_COMMENTS: 0 without ever running the approve call, so the thread answered "LGTM!" over a
 * PR that carried no review at all and the author merged it unreviewed. Failing to READ GitHub is
 * not evidence that nothing landed, so an unreachable gh keeps the worker's word.
 * @returns {{ status: string, note: string|null }}
 */
async function landReview({ pr, outcome, label, since }) {
  let state;
  try {
    state = myReviewState(pr, { since });
  } catch (err) {
    log(`[${label}] could not read my review state on GitHub: ${err.message}`);
    return { status: "reviewed", note: null };
  }
  let check = verifyOutcome(outcome, state);
  if (check.needsApprove) {
    const ci = await ciGate(pr, label);
    if (ci) return { status: "reviewed", note: `not approved — CI ${ci.checks}${ci.names ? `: ${ci.names}` : ""}`, ci };
    try {
      approvePr(pr);
      log(`[${label}] approved the PR — worker reported it clean but submitted no review`);
      return { status: "reviewed", note: "approved by the watcher (the worker had not)" };
    } catch (err) {
      check = { ...check, mismatch: `no review on the PR, and approving it failed: ${err.message}` };
    }
  }
  if (check.mismatch) log(`[${label}] MISMATCH — ${check.mismatch}`);
  return check.mismatch ? { status: "unverified", note: check.mismatch } : { status: "reviewed", note: null };
}

/**
 * The PRs ONE mention asks me to review. The thread reply lands under that mention, so the set
 * must be what that conversation is about — never a PR somebody else posted nearby in the
 * channel. Precedence:
 *   1. PR links in the mention's own text (one message often lists several — review EVERY one).
 *   2. None there and it is a thread reply → the PRs linked anywhere in that thread (the link in
 *      the root, "@me review please" as a reply).
 *   3. None there and it is a top-level message → the REQUESTER's own messages in the context
 *      window (they often split one request over several short messages); other people's
 *      messages never count.
 * The classifier's prUrl is deliberately NOT a fallback: it reads the same context block, so
 * its pick can be another teammate's PR — the exact leak this guards against. No link anywhere
 * → the "no PR link found" self-DM, which is visible and recoverable; a review posted into the
 * wrong thread is not.
 * Regression (2026-10-05): the set was parsed from the WHOLE context block, so a top-level
 * "PR for review: #2527" swept up two other teammates' PRs posted minutes earlier in the
 * channel, reviewed all three under that mention, and answered its thread with "Reviewed 2 PRs:
 * #2527, #70" — while #70's own message got no reply at all. Every later "I updated them" in
 * that thread then re-checked all three.
 */
export function prsRequestedBy(mention, context) {
  const own = parseAllPrUrls(mention.text ?? "");
  if (own.length) return own;
  const messages = context?.messages ?? [];
  const scoped = context?.kind === "thread" ? messages : messages.filter((m) => m.user === mention.user);
  return parseAllPrUrls(scoped.map((m) => m.text ?? "").join("\n"));
}

export async function handlePrReview(ctx) {
  const { mention, classification, context, config, slack, selfId } = ctx;
  const prs = prsRequestedBy(mention, context);
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
      sessionCwd: r.sessionCwd ?? null,
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
1. Run \`git fetch origin\`, then \`gh pr view ${pr.number} --json state,commits\` (and \`gh pr checkout ${pr.number}\` when it is still open). If the PR is already MERGED: check my reviews (\`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews\`) — when I approved it, or my findings were addressed before the merge, STOP with REVIEW_STATUS: resolved and a SLACK_REPLY that confirms the closure (e.g. "Already approved and merged — LGTM."). Closed WITHOUT merging, or merged with my real findings ignored: STOP with REVIEW_STATUS: skipped and say why.
2. Establish what changed since my last review: \`gh api user --jq .login\` (me), \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews\` and \`.../pulls/${pr.number}/comments\` (my earlier findings), \`gh pr view ${pr.number} --json commits\`. If there are NO new commits since my last review, their reply points at nothing specific to look at, and my last round did not withhold approval over red/pending CI, STOP: REVIEW_STATUS: skipped, and say in SLACK_REPLY that I found no new commits to re-check.
3. Verify EACH of my earlier findings against the CURRENT code — is the problem actually fixed? Trace the code; never trust commit messages. Then review the new commits for NEW real problems with the same bar as the original review: bugs, regressions, lost data/functionality, broken API contracts, security issues, backward-compatibility breaks. SKIP minor issues entirely (style, naming, dead code, formatting). If unsure whether an issue is real, skip it.
4. If an earlier finding is still broken or the update introduces a new real issue: post inline comments on the exact changed lines (RIGHT side), all in ONE review call — \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` with a "comments" array of {path, line, side: "RIGHT", body}. Every comment includes the fix as a \`\`\`suggestion block or a short snippet; short basic English, prose under 200 characters per comment. Do NOT approve.
5. CI: run \`gh pr checks ${pr.number}\`. For EVERY failed check (lint, typecheck/tsc, tests, build) read its log (\`gh run view <run-id> --log-failed\`) and find the root cause. A failure caused by this PR is a real issue: post it as an inline comment on the offending changed line with the fix. A failure the diff did not cause (flaky test, base branch already red, infra) gets no comment — name it in SLACK_REPLY instead. A green diff with red CI is NOT clean: I never approve while any check is failing or still running.
6. If everything I flagged is fixed and nothing new is broken: post nothing and report REVIEW_COMMENTS: 0 — I submit the approving review myself from your report. Do NOT run an approve command. If I already approved AFTER their latest commit, report REVIEW_STATUS: resolved with a SLACK_REPLY confirming it is already approved.

End your final message with exactly these lines:
REVIEW_STATUS: <reviewed | resolved | skipped — "reviewed" only if you evaluated the update's diff this run; "resolved" when there is nothing left to review AND the outcome is final and positive for the author (already approved, already merged with my findings addressed) — your SLACK_REPLY is then posted to the thread; "skipped" when you could not or should not act (closed without merge, no new commits, cannot review) — then SLACK_REPLY stays a private DM>
REVIEW_COMMENTS: <number of NEW inline comments you posted this run, 0 if none>
SLACK_REPLY: <one short sentence in ${detectLang(mention.text) === "vi" ? "Vietnamese" : "English"}: what you found re-checking their update — for "resolved" this exact sentence goes to the thread, keep it plain and final>`;
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

  // The author is literally waiting on their reply, so a POSITIVE closure answers the thread
  // even when there was nothing left to re-review ("resolved": already approved / already
  // merged with the findings addressed) — a silent LGTM reads as "review never happened".
  // Only murky outcomes (closed unmerged, no new commits, failures) stay a private DM.
  const answered = results.filter((r) => r.status === "reviewed" || r.status === "resolved");
  const threadReply = buildFollowupThreadReply(answered);
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
    status: answered.length
      ? (results.some((r) => r.status === "reviewed") ? "reviewed" : "resolved")
      : (results[0]?.status ?? "skipped"),
    threadTs: followup.threadTs,
    prs: results.map((r) => ({
      url: r.pr.url,
      status: r.status,
      comments: r.outcome && !Number.isNaN(r.outcome.commentCount) ? r.outcome.commentCount : null,
      sessionId: r.sessionId ?? r.pr.sessionId ?? null,
      sessionCwd: r.sessionCwd ?? r.pr.sessionCwd ?? null,
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
  // Where the transcript lives: recorded for sessions started in the shared sessions dir; an
  // older session started inside its worktree.
  const sessionCwd = pr.sessionCwd ?? pr.worktreePath;
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
      ({ worktreePath } = await gitMutex(() =>
        createWorktree(repoPath, pr.repo, `${mention.ts}-pr${pr.number}`, config.worktreesDir, config.baseBranch),
      ));
    } catch (err) {
      await slack.postToSelf(selfId, `:x: Could not prepare a worktree for re-reviewing ${pr.url}: ${err.message}`);
      return { pr, status: "worktree_failed", error: err.message };
    }
    createdFresh = true;
    // A transcript is keyed by the dir its session started in. One started in the shared dir
    // resumes from there with the NEW worktree; an older one lived in the pruned worktree.
    if (!pr.sessionCwd) resumeSessionId = null;
  }

  let sessionId = resumeSessionId ?? newSessionId();
  // A fresh session always starts in the shared dir; a resumed one where it first started.
  const cwdFor = (resume) => (resume ? sessionCwd : config.workerSessionsDir);
  const startedAt = Date.now();
  log(
    `[${label}] re-reviewing PR #${pr.number} (${resumeSessionId ? "resuming session" : "fresh session"} ${sessionId}, timeout ${minutes(config.reviewTimeoutMs)} min)`,
  );
  await slack.postToSelf(
    selfId,
    `:repeat: *Re-reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)\n:technologist: ${resumeHint(cwdFor(resumeSessionId), sessionId, worktreePath)}`,
  );

  const run = (resume) =>
    runClaude({
      bin: config.claudeBin,
      prompt: followupPrompt(ctx, pr),
      cwd: cwdFor(resume),
      workdir: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.reviewModel,
      label,
      signal: controller.signal,
      ...(resume ? { resumeSessionId: resume } : { sessionId, name: `Re-review ${pr.repo} PR #${pr.number}` }),
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
      log(`[${label}] finished after ${minutes(Date.now() - startedAt)} min — resume: ${resumeCommand(cwdFor(resumeSessionId), sessionId, worktreePath)}`);
      showInDesktopApp(sessionId);
    }
  }

  const outcome = reviewOutcome(result);
  let status = outcome.reviewed
    ? Number.isNaN(outcome.commentCount)
      ? "unparseable"
      : "reviewed"
    : outcome.status === "resolved"
      ? "resolved"
      : "skipped";
  let note = null;
  // "resolved" already read GitHub to reach its verdict; a fresh re-review still has to be proven.
  let ci = null;
  if (status === "reviewed") ({ status, note, ci = null } = await landReview({ pr, outcome, label, since: sinceIso(startedAt) }));
  log(
    `[${label}] result: ${status}${status === "reviewed" ? ` (${outcome.commentCount} new comment(s))` : status === "resolved" ? ` — ${outcome.slackReply.slice(0, 120)}` : ""}`,
  );
  return { pr, status, outcome, result, worktreePath, sessionId, sessionCwd: cwdFor(resumeSessionId), note, ci };
}

/**
 * Thread reply for a follow-up round. "reviewed" wording states the new-comment count;
 * "resolved" posts the worker's own verified one-liner (already approved / already merged) —
 * the author asked a direct question, so a positive closure must never stay silent.
 */
export function buildFollowupThreadReply(answered) {
  if (!answered.length) return null;
  const resolvedText = (r) => (r.outcome.slackReply || "Already approved — LGTM!").slice(0, 300);
  if (answered.length === 1) {
    const r = answered[0];
    if (r.status === "resolved") return resolvedText(r);
    if (r.ci) return ciHoldReply(r.ci);
    const c = r.outcome.commentCount;
    return c > 0 ? `Re-checked — left ${c} more comment${c === 1 ? "" : "s"} on the PR.` : "Re-checked the update — LGTM!";
  }
  return `Re-checked ${answered.length} PRs:\n${answered
    .map((r) => {
      if (r.status === "resolved") return `• #${r.pr.number} — ${resolvedText(r).slice(0, 120)}`;
      const c = r.outcome.commentCount;
      return `• #${r.pr.number} — ${c > 0 ? `${c} more comment${c === 1 ? "" : "s"}` : r.ci ? `code OK, CI ${r.ci.checks}` : "LGTM"}`;
    })
    .join("\n")}`;
}

/**
 * Review a single PR in its own isolated worktree + session. Never throws for an expected
 * failure (missing checkout, worktree error, user stop) — returns a status the caller folds
 * into the batch summary. Only a truly unexpected error propagates.
 * @returns {Promise<{ pr, status: "reviewed"|"skipped"|"unparseable"|"cancelled"|"repo_missing"|"worktree_failed", outcome?, result?, worktreePath?, sessionId? }>}
 */
/**
 * Check the PR out and resolve its review spec, or "" when anything in that chain is unavailable.
 *
 * Never throws: a review that still works without the spec must not be lost to it. The checkout
 * is the only part that can fail loudly (a deleted branch, a fork with no access) and it is the
 * worker's own first step anyway, so a failure here just leaves it to the worker.
 *
 * The checkout runs under gitMutex for the same reason worktree setup does: a worktree shares its
 * repo's refs, so concurrent reviews of two PRs in one repo would race on git's lock files. The
 * `ocr delegate` calls below need no mutex — they only read, through the worktree's own index.
 * @returns {Promise<string>} the prompt block, or "" to review the diff the old way
 */
async function prepareReviewSpec({ config, pr, cwd, label, gitMutex }) {
  if (!config.ocrEnabled) return "";
  let base;
  try {
    base = await gitMutex(() => checkoutPr(pr, cwd));
  } catch (err) {
    log(`[${label}] could not check the PR out for the review spec: ${err.stderr?.toString().trim() || err.message}`);
    return "";
  }
  const spec = reviewSpec({
    bin: config.ocrBin,
    ruleFile: config.ocrRuleFile,
    cwd,
    from: `origin/${base}`,
    label,
  });
  return spec ? spec.block : "";
}

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
    ({ worktreePath } = await gitMutex(() =>
      createWorktree(repoPath, pr.repo, `${mention.ts}-pr${pr.number}`, config.worktreesDir, config.baseBranch),
    ));
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
      `:technologist: ${resumeHint(config.workerSessionsDir, sessionId, worktreePath)}`,
  );

  const { block: attachmentsBlock } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir: worktreePath,
    label,
  });

  // Resolve WHAT to review before the worker starts. Open Code Review's own finding: the part of
  // a review a model is worst at is picking the files — on a large diff it quietly reads some and
  // not others. `ocr delegate` is pure engineering (no model, seconds) and hands the worker a
  // closed file list plus the checklist from ocr/rule.json. Best-effort throughout: a repo it
  // cannot check out, or a missing `ocr`, leaves the review exactly as it was before.
  const ocrBlock = await prepareReviewSpec({ config, pr, cwd: worktreePath, label, gitMutex });

  let result;
  let discarded = false;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: reviewPrompt(ctx, pr, attachmentsBlock, ocrBlock),
      cwd: config.workerSessionsDir,
      workdir: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.reviewModel,
      label,
      signal: controller.signal,
      sessionId,
      name: `Review ${pr.repo} PR #${pr.number}`,
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
      log(`[${label}] finished after ${minutes(Date.now() - startedAt)} min — resume: ${resumeCommand(config.workerSessionsDir, sessionId, worktreePath)}`);
      showInDesktopApp(sessionId);
    }
  }

  const outcome = reviewOutcome(result);
  let status = !outcome.reviewed ? "skipped" : Number.isNaN(outcome.commentCount) ? "unparseable" : "reviewed";
  let note = null;
  // Never take the worker's word for a public action — reconcile it with GitHub first.
  let ci = null;
  if (status === "reviewed") ({ status, note, ci = null } = await landReview({ pr, outcome, label, since: sinceIso(startedAt) }));
  log(`[${label}] result: ${status}${status === "reviewed" ? ` (${outcome.commentCount} comment(s))` : ""}`);
  return { pr, status, outcome, result, worktreePath, sessionId, sessionCwd: config.workerSessionsDir, note, ci };
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
  if (reviewed.length === 1) return reviewed[0].ci ? ciHoldReply(reviewed[0].ci) : reviewed[0].outcome.threadReply;
  const lines = reviewed.map((r) => {
    const c = r.outcome.commentCount;
    return `• #${r.pr.number} — ${c > 0 ? `${c} comment${c === 1 ? "" : "s"}` : r.ci ? `code OK, CI ${r.ci.checks}${r.ci.names ? ` (${r.ci.names})` : ""}` : "LGTM"}`;
  });
  return `Reviewed ${reviewed.length} PRs:\n${lines.join("\n")}`;
}

/** Self-DM: one line per PR with its real outcome — a skipped/failed one must never read as reviewed. */
function buildSummaryDm({ results, mention, repliedInThread, title = "PR review done" }) {
  const line = (r) => {
    const c = r.outcome?.commentCount;
    switch (r.status) {
      case "reviewed":
        return `:white_check_mark: ${r.pr.url} — ${c > 0 ? `${c} inline comment${c === 1 ? "" : "s"}` : "no issues (LGTM)"}${r.note ? ` — ${r.note}` : ""}`;
      case "unverified":
        return `:warning: ${r.pr.url} — the worker reported a review that is NOT on the PR (${r.note}); nothing said in the thread, check it manually`;
      case "resolved":
        return `:white_check_mark: ${r.pr.url} — resolved${r.outcome?.slackReply ? `: ${r.outcome.slackReply}` : " (already approved/merged)"}`;
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
