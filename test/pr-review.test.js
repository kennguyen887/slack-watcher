// The review worker's report decides what lands in a TEAM channel, so the mapping is pinned here.
// Regression (2026-07-30): a pre-check bail on an already-merged PR reports 0 comments exactly like
// a clean review does, and the handler answered "LGTM!" in the thread — telling the team a PR had
// been reviewed when nobody had read the diff. Only REVIEW_STATUS: reviewed may reply.
import test from "node:test";
import assert from "node:assert/strict";

import { reviewOutcome, buildThreadReply, runPool } from "../src/handlers/pr-review.js";
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
