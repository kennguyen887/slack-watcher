// The instant thread ack is public under the user's name: pin its language and which asks get it.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import { ACK_KINDS, ackText } from "../src/handlers/shared.js";

test("Vietnamese ask gets the Vietnamese ack", () => {
  assert.equal(ackText("<@U1> anh check giúp em phần gửi mail COM-1266 với"), "để anh check");
});

test("English ask gets the English ack", () => {
  assert.equal(ackText("<@U1> can you check why the invite email is not sent?"), "Let me check.");
});

test("PR reviews and ignored mentions get no ack; asks do", () => {
  for (const kind of ["code_request", "needs_clarification", "question"]) assert.ok(ACK_KINDS.has(kind));
  for (const kind of ["pr_review", "pr_review_followup", "ignore", "skipped"]) assert.ok(!ACK_KINDS.has(kind));
});
