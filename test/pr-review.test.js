// The review worker's report decides what lands in a TEAM channel, so the mapping is pinned here.
// Regression (2026-07-30): a pre-check bail on an already-merged PR reports 0 comments exactly like
// a clean review does, and the handler answered "LGTM!" in the thread — telling the team a PR had
// been reviewed when nobody had read the diff. Only REVIEW_STATUS: reviewed may reply.
import test from "node:test";
import assert from "node:assert/strict";

import {
  reviewOutcome,
  verifyOutcome,
  buildThreadReply,
  runPool,
  handlePrReview,
  matchReviewFollowup,
  buildFollowupThreadReply,
  handlePrReviewFollowup,
} from "../src/handlers/pr-review.js";
import { parseAllPrUrls } from "../src/github.js";

const report = (lines) => `some worker chatter\n${lines}`;

test("reviewOutcome replies in the thread only when the diff was actually reviewed", () => {
  const skipped = reviewOutcome(
    report("REVIEW_STATUS: skipped\nREVIEW_COMMENTS: 0\nSLACK_REPLY: PR #4 is already merged, skipping."),
  );
  assert.equal(skipped.threadReply, null);
  assert.equal(skipped.reviewed, false);

  const clean = reviewOutcome(report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 0\nSLACK_REPLY: Looks good."));
  assert.equal(clean.threadReply, "LGTM!");

  // The thread reply states the COUNT from commentCount, not the worker's free-text SLACK_REPLY
  // (the team wants the number at a glance).
  const commented = reviewOutcome(
    report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 3\nSLACK_REPLY: Mình đã comment vài chỗ trên PR."),
  );
  assert.equal(commented.threadReply, "Reviewed — left 3 comments on the PR.");
  assert.equal(commented.commentCount, 3);

  // Singular grammar for a single comment.
  const one = reviewOutcome(report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 1\nSLACK_REPLY: x"));
  assert.equal(one.threadReply, "Reviewed — left 1 comment on the PR.");

  // A worker that ignored the contract must not get a thread reply either.
  assert.equal(reviewOutcome("no markers at all").threadReply, null);
  assert.equal(reviewOutcome(report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: oops")).threadReply, null);
});

// Regression (2026-08-26, commonground#2306): the worker ended with "no bugs found — approved" and
// REVIEW_COMMENTS: 0 but never ran the approve call. GitHub held no review at all, yet the thread
// answered "LGTM!" and the author merged it unreviewed. A reported review is now proven against
// GitHub: the watcher approves a clean PR itself, and an unbacked claim never reaches the thread.
test("verifyOutcome: the watcher approves a clean PR, and an unlanded review is a mismatch", () => {
  const clean = reviewOutcome("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 0\nSLACK_REPLY: Looks good.");
  const commented = reviewOutcome("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 2\nSLACK_REPLY: Commented.");
  const state = (over) => ({ login: "me", state: "OPEN", approved: false, comments: 0, ...over });

  // The #2306 case: clean diff, nothing on the PR — the watcher submits the approval.
  assert.deepEqual(verifyOutcome(clean, state()), { needsApprove: true, verified: false, mismatch: null });
  // The worker approved it already (or an earlier round did) — do not approve twice.
  assert.equal(verifyOutcome(clean, state({ approved: true })).needsApprove, false);
  // Merged or closed while we were reading it: the diff WAS reviewed, nothing left to approve.
  assert.deepEqual(verifyOutcome(clean, state({ state: "MERGED" })), { needsApprove: false, verified: true, mismatch: null });

  // Claimed inline comments must exist on the PR before the team is told about them.
  assert.equal(verifyOutcome(commented, state({ comments: 2 })).verified, true);
  const lied = verifyOutcome(commented, state());
  assert.equal(lied.verified, false);
  assert.match(lied.mismatch, /reported 2 inline comment\(s\), GitHub has none from me/);

  // A skipped or unparseable report is not a claim to verify — it never reached the thread anyway.
  const skipped = reviewOutcome("REVIEW_STATUS: skipped\nREVIEW_COMMENTS: 0\nSLACK_REPLY: already merged");
  assert.deepEqual(verifyOutcome(skipped, state()), { needsApprove: false, verified: false, mismatch: null });
  assert.equal(verifyOutcome(reviewOutcome("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: nope"), state()).needsApprove, false);
});

test("parseAllPrUrls returns every distinct PR in a multi-PR message, deduped", () => {
  const text =
    "PRs for review:\n<https://github.com/Org/repo/pull/2250|a>\n<https://github.com/Org/repo/pull/2249|b>\n" +
    "https://github.com/Org/repo/pull/2246\nand again https://github.com/Org/repo/pull/2250";
  const prs = parseAllPrUrls(text);
  assert.deepEqual(prs.map((p) => p.number), ["2250", "2249", "2246"]); // first-seen order, 2250 once
  assert.equal(prs[0].owner, "Org");
  assert.equal(prs[0].repo, "repo");
  assert.equal(parseAllPrUrls("no pr links here").length, 0);
});

test("runPool caps concurrency and preserves input order", async () => {
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const items = [0, 1, 2, 3, 4, 5, 6];
  const out = await runPool(items, 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(n);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50, 60]); // order preserved despite parallelism
  assert.ok(peak <= 3, `peak concurrency ${peak} must be <= 3`);
  assert.ok(peak > 1, "should actually run in parallel");
  assert.equal(order.length, 7); // every item ran exactly once
});

test("buildThreadReply: one PR keeps prose, several become a per-PR list, none → null", () => {
  assert.equal(buildThreadReply([]), null);

  // Single reviewed PR keeps the exact single-PR wording (from reviewOutcome.threadReply).
  const one = [{ pr: { number: "10" }, outcome: { commentCount: 2, threadReply: "Reviewed — left 2 comments on the PR." } }];
  assert.equal(buildThreadReply(one), "Reviewed — left 2 comments on the PR.");

  // Several PRs → one list, each line stating its own count / LGTM (singular grammar respected).
  const many = [
    { pr: { number: "2250" }, outcome: { commentCount: 3 } },
    { pr: { number: "2249" }, outcome: { commentCount: 0 } },
    { pr: { number: "2246" }, outcome: { commentCount: 1 } },
  ];
  assert.equal(
    buildThreadReply(many),
    "Reviewed 3 PRs:\n• #2250 — 3 comments\n• #2249 — LGTM\n• #2246 — 1 comment",
  );
});

// Regression (2026-08-24): the author replying "I updated them" in a review thread was classified
// as a status update → ignore, so the review never continued — the author waited on an approval
// that was never coming. Follow-ups must be detected DETERMINISTICALLY from recorded review
// threads, before the classifier can drop them.
test("matchReviewFollowup: thread reply into a recorded review resumes it, everything else falls through", () => {
  const wt = "/tmp/wt-pr7";
  const entry = (key, threadTs, prs) => ({ key, classification: { kind: "pr_review" }, result: { threadTs, prs } });
  const recorded = [
    entry("C1:100.1", "100.1", [
      { url: "https://github.com/Org/repo/pull/7", status: "reviewed", comments: 2, sessionId: "s-7", worktreePath: wt },
      { url: "https://github.com/Org/repo/pull/8", status: "reviewed", comments: 0, sessionId: "s-8", worktreePath: wt },
    ]),
  ];
  const reply = (text, { ts = "100.9", channel = "C1", threadTs = "100.1" } = {}) => ({
    ts,
    text,
    channel: { id: channel },
    permalink: `https://x.slack.com/archives/${channel}/p1009?thread_ts=${threadTs}`,
  });

  // Reply with no PR link → every recorded PR is re-checked.
  const all = matchReviewFollowup(reply("<@U0> I updated them"), recorded);
  assert.equal(all.threadTs, "100.1");
  assert.deepEqual(all.prs.map((p) => p.sessionId), ["s-7", "s-8"]);

  // Reply linking a SUBSET narrows the follow-up to those PRs.
  const subset = matchReviewFollowup(reply("updated <https://github.com/Org/repo/pull/8|pr8>"), recorded);
  assert.deepEqual(subset.prs.map((p) => p.sessionId), ["s-8"]);

  // Reply linking a PR we never reviewed there is a NEW request → classifier path.
  assert.equal(matchReviewFollowup(reply("also https://github.com/Org/repo/pull/9 please"), recorded), null);

  // A thread ROOT (no thread_ts in the permalink) is never a follow-up.
  assert.equal(
    matchReviewFollowup({ ts: "200.1", text: "hi", channel: { id: "C1" }, permalink: "https://x.slack.com/archives/C1/p2001" }, recorded),
    null,
  );
  // Unknown thread / other channel → null.
  assert.equal(matchReviewFollowup(reply("updated", { threadTs: "999.9" }), recorded), null);
  assert.equal(matchReviewFollowup(reply("updated", { channel: "C2" }), recorded), null);

  // Pre-feature history rows (no sessionId/worktreePath) cannot be resumed → classifier path.
  const legacy = [entry("C1:100.1", "100.1", [{ url: "https://github.com/Org/repo/pull/7", status: "reviewed", comments: 2 }])];
  assert.equal(matchReviewFollowup(reply("I updated them"), legacy), null);

  // The LATEST entry for the thread wins — chained follow-ups resume the freshest sessions.
  const chained = [
    ...recorded,
    entry("C1:100.5", "100.1", [
      { url: "https://github.com/Org/repo/pull/7", status: "reviewed", comments: 1, sessionId: "s-7b", worktreePath: wt },
    ]),
  ];
  assert.deepEqual(matchReviewFollowup(reply("fixed again"), chained).prs.map((p) => p.sessionId), ["s-7b"]);
});

// Standing order (Ken, 2026-08-24): "nếu đã LGTM cũng reply slack" — a follow-up whose outcome
// is a positive closure (already approved / already merged) must ANSWER the thread, not stay
// silent; the author is waiting on their reply. Only murky outcomes stay a private DM.
test("buildFollowupThreadReply: re-check wording, resolved closures answer the thread too", () => {
  assert.equal(buildFollowupThreadReply([]), null);
  const one = (c) => [{ pr: { number: "7" }, status: "reviewed", outcome: { commentCount: c } }];
  assert.equal(buildFollowupThreadReply(one(0)), "Re-checked the update — LGTM!");
  assert.equal(buildFollowupThreadReply(one(1)), "Re-checked — left 1 more comment on the PR.");

  // "resolved" posts the worker's own verified one-liner; empty falls back to a fixed LGTM.
  assert.equal(
    buildFollowupThreadReply([
      { pr: { number: "7" }, status: "resolved", outcome: { commentCount: 0, slackReply: "Already approved and merged — LGTM." } },
    ]),
    "Already approved and merged — LGTM.",
  );
  assert.equal(
    buildFollowupThreadReply([{ pr: { number: "7" }, status: "resolved", outcome: { commentCount: 0, slackReply: "" } }]),
    "Already approved — LGTM!",
  );

  assert.equal(
    buildFollowupThreadReply([
      { pr: { number: "7" }, status: "reviewed", outcome: { commentCount: 2 } },
      { pr: { number: "8" }, status: "reviewed", outcome: { commentCount: 0 } },
      { pr: { number: "9" }, status: "resolved", outcome: { commentCount: 0, slackReply: "Already merged with the fixes in." } },
    ]),
    "Re-checked 3 PRs:\n• #7 — 2 more comments\n• #8 — LGTM\n• #9 — Already merged with the fixes in.",
  );
});

test("reviewOutcome exposes the raw status — resolved never counts as reviewed for the INITIAL flow", () => {
  const resolved = reviewOutcome(
    report("REVIEW_STATUS: resolved\nREVIEW_COMMENTS: 0\nSLACK_REPLY: Already approved and merged — LGTM."),
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.reviewed, false);
  // The 2026-07-30 pin stands: initial reviews reply only on an actually-reviewed diff.
  assert.equal(resolved.threadReply, null);
  assert.equal(resolved.slackReply, "Already approved and merged — LGTM.");
});

// Same undefined-free-variable net as the handlePrReview entry test below: drive the follow-up
// handler's real entry path up to the git boundary (worktree gone + no repos root → repo_missing)
// with zero network. A missing import or typo anywhere on that path throws here.
test("handlePrReviewFollowup runs its entry path — vanished worktree + missing repo degrades, does not throw", async () => {
  const posted = [];
  const replied = [];
  const ctx = {
    mention: { ts: "100.9", text: "I updated them", username: "nam", channel: { id: "C1", name: "dev" }, permalink: "https://slack/x?thread_ts=100.1" },
    classification: { kind: "pr_review_followup" },
    contextBlock: "",
    config: { workerGraceMs: 0, reviewConcurrency: 2, reposRoot: "/nonexistent-repos-root", worktreesDir: "/tmp/wt", baseBranch: "main" },
    slack: {
      postToSelf: async (_id, text) => (posted.push(text), "D1"),
      replyInThread: async (...args) => replied.push(args),
      fetchMessagesSince: async () => [],
      fetchContext: async () => ({ messages: [], kind: "none", error: null }),
    },
    selfId: "U1",
    followup: {
      threadTs: "100.1",
      prs: [{ url: "https://github.com/Org/repo/pull/7", sessionId: "s-7", worktreePath: "/nonexistent-worktree-pr7" }],
    },
  };
  const result = await handlePrReviewFollowup(ctx);
  assert.equal(result.status, "repo_missing");
  assert.equal(result.repliedInThread, false); // nothing was reviewed → the thread must stay silent
  assert.deepEqual(replied, []);
  assert.match(posted.at(-1), /follow-up/i);
});

// Regression (2026-08-19): the handler called parseAllPrUrls but the module still imported only
// parsePrUrl, so EVERY review request died with "parseAllPrUrls is not defined" — 7 PRs silently
// dropped over a day. Driving the handler's entry (the no-PR-link bail is the one path that stops
// before claude/git) is what catches an undefined free variable; the pure-function tests cannot.
test("handlePrReview runs its entry path — a message with no PR link bails, it does not throw", async () => {
  const posted = [];
  const ctx = {
    mention: { text: "please review this", permalink: "https://slack/x", channel: { id: "C1" } },
    classification: { prUrl: null, summary: "review please" },
    contextBlock: "",
    config: {},
    slack: { postToSelf: async (_id, text) => (posted.push(text), "D1") },
    selfId: "U1",
  };
  assert.deepEqual(await handlePrReview(ctx), { status: "no_pr_url" });
  assert.match(posted[0], /no GitHub PR link found/);
});
