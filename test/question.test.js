// The auto-reply handler is the only one that says something SUBSTANTIVE in public under the
// user's own name — the review handler just reports a count — and Slack gives this tool no way
// to delete a message. So every gate that keeps a reply OUT of a channel is pinned here.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import { answerOutcome, deliverAnswer, handleQuestion } from "../src/handlers/question.js";
import { vietnameseScore, isVietnamese } from "../src/handlers/shared.js";
import { isMachineWritten, selectSamples, measure } from "../src/style-learn.js";

const NO_PROFILE = "/nonexistent/style/profile.md";

function stubCtx(overrides = {}) {
  const posted = [];
  const replied = [];
  const ctx = {
    mention: {
      ts: "100.5",
      text: "a ơi cái legacy-api này thì e sửa trên branch nào a nhỉ",
      username: "tai",
      channel: { id: "C1", name: "dev" },
      permalink: "https://slack/x",
      ...overrides.mention,
    },
    classification: { kind: "question", summary: "which branch to fix legacy-api on" },
    contextBlock: "",
    config: { questionAutoReply: true, styleProfileFile: NO_PROFILE, workerGraceMs: 0, ...overrides.config },
    slack: {
      postToSelf: async (_id, text) => (posted.push(text), "D1"),
      replyInThread: async (...args) => replied.push(args),
      fetchMessagesSince: async () => [],
      fetchContext: async () => ({ messages: [], kind: "none", error: null }),
    },
    selfId: "U1",
  };
  return { ctx, posted, replied };
}

// ── the language gate: who may be answered at all ────────────────────────────

test("the Vietnamese gate passes real teammate questions and refuses English ones", () => {
  // Verbatim from history.jsonl — the Vietnamese teammates the user wants answered.
  const vietnamese = [
    "a <@U1> ơi cái legacy-api này thì e sẽ sửa trên branch nào a nhỉ ?",
    "nhưng mà mình đang k có flow edit farm, ko biết có api support ko a <@U1>",
    "a <@U1> ơi mình có sửa đc config ở CloudFront k ạ",
    "dạ ở đây ạ <@U1>",
  ];
  for (const text of vietnamese) assert.ok(isVietnamese(text), `should be VI: ${text}`);

  // Also verbatim: the English-speaking client and a colleague from another team. These stay the
  // user's to answer — that is the whole point of the feature, not an edge case.
  const english = [
    "Hey <@U1>, it would be nice to also have a user's questionnaire answers populate in their hubspot contact page. Do you think this is feasible?",
    "Awesome tool! Quick question: Slack user tokens usually can't fetch file attachments directly. Have you tested this?",
    "can you check the invoice from Ngô Corp?", // one accented word is not a Vietnamese message
    "the da branch is broken",
  ];
  for (const text of english) assert.ok(!isVietnamese(text), `should be EN: ${text}`);
});

test("vietnameseScore counts adjacent markers, so diacritic-free Vietnamese still registers", () => {
  // A consumed separator used to hide every second word, which scored this real-shaped message
  // at 2 and dropped it into the English bucket.
  assert.ok(vietnameseScore("a oi cai nay em sua o branch nao a") >= 3);
  assert.equal(vietnameseScore("deploy the API to prod"), 0);
});

// ── the confidence gate: what may be posted once the worker is done ──────────

test("answerOutcome posts only a confident answer, and never an escalation", () => {
  const answered = answerOutcome("chatter\nANSWER_STATUS: answer\nANSWER_REASON: read the workflow file\nSLACK_REPLY: sửa trên rc nhé em");
  assert.equal(answered.postable, true);
  assert.equal(answered.reply, "sửa trên rc nhé em");

  // "needs your decision" must never reach the channel, however good the draft reads.
  const escalated = answerOutcome("ANSWER_STATUS: escalate\nANSWER_REASON: needs a priority call\nSLACK_REPLY: để anh check rồi báo lại");
  assert.equal(escalated.postable, false);
  assert.equal(escalated.reply, "để anh check rồi báo lại"); // still drafted privately

  // A worker that ignored the contract is not evidence of anything.
  assert.equal(answerOutcome("no markers at all").postable, false);
  assert.equal(answerOutcome("ANSWER_STATUS: answer\nSLACK_REPLY:   ").postable, false);
});

test("answerOutcome holds back an answer that ran long, and says why", () => {
  const essay = answerOutcome(`ANSWER_STATUS: answer\nSLACK_REPLY: ${"x".repeat(700)}`, { maxChars: 600 });
  assert.equal(essay.postable, false);
  assert.match(essay.heldBack, /700 chars, over the 600 cap/);
});

test("deliverAnswer posts a confident answer in the thread and keeps everything else private", async () => {
  const ok = stubCtx();
  const posted1 = await deliverAnswer(ok.ctx, answerOutcome("ANSWER_STATUS: answer\nANSWER_REASON: read it\nSLACK_REPLY: sửa trên rc nhé em"));
  assert.equal(posted1.status, "answered");
  assert.deepEqual(ok.replied, [["C1", "100.5", "sửa trên rc nhé em"]]);

  const held = stubCtx();
  const result = await deliverAnswer(held.ctx, answerOutcome("ANSWER_STATUS: escalate\nANSWER_REASON: needs you\nSLACK_REPLY: draft"));
  assert.equal(result.status, "answer_drafted");
  assert.deepEqual(held.replied, [], "an escalation must not reach the channel");
  assert.match(held.posted.at(-1), /Draft for you/);
});

// ── the entry path: the three refusals, driven for real ──────────────────────

test("handleQuestion refuses to post when off, when English, or when the voice was never learned", async () => {
  const off = stubCtx({ config: { questionAutoReply: false } });
  assert.equal((await handleQuestion(off.ctx)).status, "left_to_you");
  assert.deepEqual(off.replied, []);

  const english = stubCtx({ mention: { text: "Hey <@U1>, is this feasible soon?", username: "silas" } });
  const englishResult = await handleQuestion(english.ctx);
  assert.equal(englishResult.status, "left_to_you");
  assert.match(englishResult.why, /English teammates are yours/);
  assert.deepEqual(english.replied, [], "an English teammate is never answered automatically");

  // Vietnamese and enabled, but nothing has been learned about how the user writes: a fluent
  // generic reply under their name is worse than no reply at all.
  const unlearned = stubCtx();
  const unlearnedResult = await handleQuestion(unlearned.ctx);
  assert.equal(unlearnedResult.status, "left_to_you");
  assert.match(unlearnedResult.why, /learn-style/);
  assert.deepEqual(unlearned.replied, []);
});

// ── the learner: never learn from your own output ────────────────────────────

test("the style learner ignores this tool's own messages and the self-DM", () => {
  assert.ok(isMachineWritten(":white_check_mark: *Answered @tai* in #dev as you:"));
  assert.ok(isMachineWritten("*PR review done — 2 PRs*"));
  assert.ok(isMachineWritten("Original: <https://slack.com/archives/D1/p1>"));
  assert.ok(!isMachineWritten("sửa trên rc nhé em, xong cherry pick về main"));

  const samples = selectSamples(
    [
      { ts: "1", channel: { name: "U_ME", is_im: true }, text: ":x: Watcher failed on a mention", permalink: "" },
      { ts: "2", channel: { name: "U_ME", is_im: true }, text: "anh xong rồi nhé em, deploy luôn", permalink: "" },
      { ts: "3", channel: { name: "dev" }, text: "ok", permalink: "" },
      { ts: "4", channel: { name: "dev" }, text: "deploy the API to prod now", permalink: "" },
      { ts: "5", channel: { name: "dev" }, text: "cái này em cứ merge vào rc trước nhé", permalink: "?thread_ts=9" },
    ],
    { selfId: "U_ME" },
  );
  // The self-DM is where this tool talks to itself — dropped whole, including the human-looking
  // line at ts 2. What is left is Vietnamese prose with something to imitate.
  assert.deepEqual(samples.map((s) => s.ts), ["5"]);
  assert.equal(samples[0].inThread, true);
  assert.equal(measure(samples).count, 1);
});
