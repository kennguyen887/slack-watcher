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

// ── webhook routing ──────────────────────────────────────────────────────────
// The point of the routing is WHO the message appears to be from, so what these
// pin is the transport choice: which URL was hit, and that the user token never
// travels to the hook.

const HOOK = "https://hooks.slack.com/services/T1/B1/secret";
const webhooks = { "#commonground-monitoring": HOOK };

test("a mapped channel posts through the webhook, never as the user", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response("ok", { status: 200 });
  });

  const slack = createSlackClient("xoxp-test", webhooks);
  // Matched however the sender spells it — "#chan", bare name, different case.
  assert.equal(await slack.post("#commonground-monitoring", "alert"), "#commonground-monitoring");
  assert.equal(await slack.post("CommonGround-Monitoring", "alert"), "CommonGround-Monitoring");

  assert.deepEqual(calls.map((c) => c.url), [HOOK, HOOK]);
  assert.deepEqual(calls.map((c) => c.auth), [undefined, undefined]);
  assert.equal(calls[0].body.text, "alert");
});

test("an unmapped channel still posts as the user", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return jsonResponse(okBody);
  });

  assert.equal(await createSlackClient("xoxp-test", webhooks).post("#other", "hi"), "C123");
  assert.deepEqual(urls, ["https://slack.com/api/chat.postMessage"]);
});

test("a thread reply in a mapped channel goes through the webhook, carrying thread_ts", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response("ok", { status: 200 });
  });

  await createSlackClient("xoxp-test", webhooks).replyInThread(
    "#commonground-monitoring",
    "1789368905.765999",
    "on it",
  );
  assert.equal(sent.url, HOOK);
  assert.equal(sent.body.thread_ts, "1789368905.765999");
});

test("a webhook 5xx retries, and a revoked hook (4xx) fails once with Slack's reason", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return new Response("server_error", { status: 503 });
  });
  t.mock.method(globalThis, "setTimeout");
  globalThis.setTimeout.mock.mockImplementation((fn) => fn());

  const slack = createSlackClient("xoxp-test", webhooks);
  await assert.rejects(
    slack.post("#commonground-monitoring", "hi"),
    /Slack webhook failed after 4 attempts: HTTP 503/,
  );
  assert.equal(attempts, 4);

  // A revoked/deleted hook answers 4xx forever — retrying it only delays the error.
  globalThis.fetch.mock.mockImplementation(async () => new Response("no_service", { status: 404 }));
  const before = globalThis.fetch.mock.callCount();
  await assert.rejects(
    slack.post("#commonground-monitoring", "hi"),
    /Slack webhook failed: HTTP 404 no_service/,
  );
  assert.equal(globalThis.fetch.mock.callCount() - before, 1);
});

test("sendSlackMessage leaves DM resolution alone — a webhook cannot reach a DM", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url).split("?")[0]);
    return jsonResponse({ ...okBody, members: [{ id: "U123", name: "ken" }] });
  });

  await sendSlackMessage(createSlackClient("xoxp-test", webhooks), "@ken", "hello");
  assert.deepEqual(urls, ["https://slack.com/api/users.list", "https://slack.com/api/chat.postMessage"]);
});
