// Tests for the send path. A real send needs a live Slack token, so the honest
// boundaries here are (1) the pure validateSend/countChars gates that run before
// any network, and (2) createSlackClient's retry behavior with global fetch
// stubbed — the transport is the thing being tested, so faking it is the point.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import { validateSend, countChars, DEFAULT_CAP, sendSlackMessage } from "../src/send.js";
import { createSlackClient } from "../src/slack.js";

test("countChars counts code points like wc -m, not bytes", () => {
  assert.equal(countChars("abc"), 3);
  assert.equal(countChars("dài — thế"), 9); // em dash is 1 char, 3 bytes
});

test("validateSend refuses a message over the cap and says by how much", () => {
  const refusal = validateSend("#chan", "x".repeat(301), { cap: 300 });
  assert.match(refusal, /301 chars, over the 300 cap/);
});

test("validateSend allows exactly the cap, and defaults to the report ceiling", () => {
  assert.equal(validateSend("#chan", "x".repeat(300), { cap: 300 }), null);
  assert.equal(validateSend("#chan", "x".repeat(DEFAULT_CAP)), null);
  assert.match(validateSend("#chan", "x".repeat(DEFAULT_CAP + 1)), /over the 2000 cap/);
});

test("validateSend enforces the allowlist case-insensitively, and only when set", () => {
  const allowed = ["#commonground", "#commonground-dev"];
  assert.equal(validateSend("#CommonGround", "hi", { allowedTargets: allowed }), null);
  assert.match(
    validateSend("#random", "hi", { allowedTargets: allowed }),
    /not in SEND_ALLOWED_TARGETS/,
  );
  assert.equal(validateSend("#random", "hi", { allowedTargets: [] }), null);
});

test("sendSlackMessage resolves @handles to a user id and posts to raw targets as-is", async () => {
  const calls = [];
  const fake = {
    resolveUserId: async (h) => {
      calls.push(["resolve", h]);
      return "U123";
    },
    post: async (channel, text) => {
      calls.push(["post", channel, text]);
      return channel;
    },
  };
  assert.equal(await sendSlackMessage(fake, "@ken", "hello"), "U123");
  assert.equal(await sendSlackMessage(fake, "#chan", "hello"), "#chan");
  assert.deepEqual(calls, [
    ["resolve", "@ken"],
    ["post", "U123", "hello"],
    ["post", "#chan", "hello"],
  ]);
});

// ── call() retry, via a stubbed global fetch ─────────────────────────────────

const okBody = { ok: true, channel: "C123" };
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("post retries a connection failure instead of losing the message", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return jsonResponse(okBody);
  });
  t.mock.method(globalThis, "setTimeout"); // keep backoff sleeps from slowing the test
  globalThis.setTimeout.mock.mockImplementation((fn) => fn());

  const channel = await createSlackClient("xoxp-test").post("#chan", "hi");
  assert.equal(channel, "C123");
  assert.equal(attempts, 2);
});

test("post retries a 5xx and gives up with the last failure named", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return jsonResponse({ ok: false }, 503);
  });
  t.mock.method(globalThis, "setTimeout");
  globalThis.setTimeout.mock.mockImplementation((fn) => fn());

  await assert.rejects(
    createSlackClient("xoxp-test").post("#chan", "hi"),
    /failed after 4 attempts: HTTP 503/,
  );
  assert.equal(attempts, 4);
});

test("post does not retry a Slack API error (channel_not_found is final)", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return jsonResponse({ ok: false, error: "channel_not_found" });
  });

  await assert.rejects(createSlackClient("xoxp-test").post("#nope", "hi"), /channel_not_found/);
  assert.equal(attempts, 1);
});
