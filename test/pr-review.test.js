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

  const commented = reviewOutcome(
    report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 3\nSLACK_REPLY: Mình đã comment vài chỗ trên PR."),
  );
  assert.equal(commented.threadReply, "Mình đã comment vài chỗ trên PR.");
  assert.equal(commented.commentCount, 3);

  // A worker that ignored the contract must not get a thread reply either.
  assert.equal(reviewOutcome("no markers at all").threadReply, null);
  assert.equal(reviewOutcome(report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: oops")).threadReply, null);
});

// The coverage lines were added between REVIEW_STATUS and SLACK_REPLY. If they broke the
// surrounding parsing the bot would go silent in the thread on every review, so the full
// current report shape is pinned here.
test("reviewOutcome parses the coverage lines without disturbing the reply contract", () => {
  const outcome = reviewOutcome(
    report(
      [
        "REVIEW_STATUS: reviewed",
        "REVIEW_FILES: 85/85",
        "REVIEW_CANDIDATES: 11/3",
        "REVIEW_TESTS: 1/18",
        "REVIEW_COMMENTS: 3",
        "SLACK_REPLY: Mình đã comment vài chỗ trên PR.",
      ].join("\n"),
    ),
  );
  assert.equal(outcome.coverage, "read 85/85 files, 11/3 candidates verified, flagged 1/18 test files");
  assert.equal(outcome.commentCount, 3);
  assert.equal(outcome.threadReply, "Mình đã comment vài chỗ trên PR.");

  // A worker that omits them still parses — coverage is reporting detail, never a gate.
  const bare = reviewOutcome(report("REVIEW_STATUS: reviewed\nREVIEW_COMMENTS: 0\nSLACK_REPLY: Looks good."));
  assert.equal(bare.coverage, "");
  assert.equal(bare.threadReply, "LGTM!");

  // A PR that added no test files must not push "flagged 0/0" noise into every clean DM.
  const noTests = reviewOutcome(
    report("REVIEW_STATUS: reviewed\nREVIEW_FILES: 3/3\nREVIEW_TESTS: 0/0\nREVIEW_COMMENTS: 0\nSLACK_REPLY: Looks good."),
  );
  assert.equal(noTests.coverage, "read 3/3 files");
});
