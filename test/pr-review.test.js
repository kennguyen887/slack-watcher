// The review worker's report decides what lands in a TEAM channel, so the mapping is pinned here.
// Regression (2026-07-30): a pre-check bail on an already-merged PR reports 0 comments exactly like
// a clean review does, and the handler answered "LGTM!" in the thread — telling the team a PR had
// been reviewed when nobody had read the diff. Only REVIEW_STATUS: reviewed may reply.
import test from "node:test";
import assert from "node:assert/strict";

import { reviewOutcome } from "../src/handlers/pr-review.js";

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
