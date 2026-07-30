// Tests for the CloudWatch auto-fix source. The daemon poll needs live Slack + claude, so the
// honest boundary here is the pure decision logic: incremental read, dedupe/cooldown/cap
// selection, and service→repo mapping. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { selectEvents, readNewEvents, loadCwalertState, saveCwalertState } from "../src/sources/cwalert.js";
import { repoForService, handleCwalertFix, autoMergeDecision } from "../src/handlers/cwalert-fix.js";

const HOUR = 3_600_000;
const ev = (over = {}) => ({ v: 1, ts: 1000, key: "k1", severity: "error", service: "listings-api", sample: "boom", lastTs: 1000, ...over });
const line = (o) => JSON.stringify(ev(o));

test("repoForService: identity, override, and suffix stripping", () => {
  assert.equal(repoForService("listings-api"), "listings-api");
  assert.equal(repoForService("listings-api (rc scheduler)"), "listings-api");
  assert.equal(repoForService("legacy-api (rc)"), "legacy-api");
  assert.equal(repoForService("api-prod", { "api-prod": "legacy-api" }), "legacy-api");
});

test("selectEvents keeps only severity:error and dedupes by key (newest wins)", () => {
  const lines = [
    line({ key: "a", sample: "old", lastTs: 1 }),
    line({ key: "a", sample: "new", lastTs: 2 }),
    line({ key: "b", severity: "warn" }),
  ];
  const { toFix } = selectEvents(lines, {}, { cooldownMs: HOUR, maxPerPoll: 5, nowMs: 10_000 });
  assert.equal(toFix.length, 1);
  assert.equal(toFix[0].sample, "new");
});

// Regression (2026-07-29): a Sentry-emitted crash carries severity "fatal" and no lastTs. The
// old error-only filter dropped it, so a crash-looping RC service was alerted but never fixed.
test("selectEvents picks up a fatal event from the Sentry producer", () => {
  const sentry = JSON.stringify({
    v: 1,
    ts: 5_000,
    source: "sentry",
    key: "sentry:LISTINGS-API-RC-F",
    severity: "fatal",
    service: "listings-api",
    project: "listings-api-rc",
    sample: "Error: Cannot find package '@fn/shared'",
    consoleUrl: "https://sentry.io/issues/1/",
  });
  const { toFix } = selectEvents([sentry], {}, { cooldownMs: HOUR, maxPerPoll: 5, nowMs: 10_000 });
  assert.deepEqual(toFix.map((e) => e.key), ["sentry:LISTINGS-API-RC-F"]);
  assert.equal(repoForService(toFix[0].service), "listings-api");
});

// Auto-merge lands unreviewed code on a shared branch, so the gates are pinned: an RC crash with
// a confident, small, green fix merges — every other combination must wait for a human.
const MERGE_CFG = {
  autoMerge: true,
  autoMergeEnvs: ["rc"],
  autoMergeMinConfidence: 9,
  autoMergeMaxFiles: 5,
  autoMergeMaxLines: 200,
};
const CLEAN_PR = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "none", changedFiles: 2, changedLines: 40 };
const decide = (over = {}) =>
  autoMergeDecision({
    event: { env: "rc", severity: "fatal" },
    confidence: 9,
    tests: "pass",
    pr: CLEAN_PR,
    cfg: MERGE_CFG,
    ...over,
  });

test("autoMergeDecision merges only an RC crash with a confident, tested, small, clean PR", () => {
  assert.equal(decide().merge, true);

  const blocked = [
    ["prod is never auto-merged", { event: { env: "prod", severity: "fatal" } }],
    ["unknown env is never auto-merged", { event: { env: undefined, severity: "fatal" } }],
    ["a non-crash error is not auto-merged", { event: { env: "rc", severity: "error" } }],
    ["low confidence blocks", { confidence: 8 }],
    ["missing confidence blocks", { confidence: NaN }],
    ["failing tests block", { tests: "fail" }],
    ["unrun tests block", { tests: "none" }],
    ["failing CI blocks", { pr: { ...CLEAN_PR, checks: "failed" } }],
    ["pending CI blocks", { pr: { ...CLEAN_PR, checks: "pending" } }],
    ["conflicts block", { pr: { ...CLEAN_PR, mergeable: "CONFLICTING" } }],
    ["a draft blocks", { pr: { ...CLEAN_PR, isDraft: true } }],
    ["a sprawling diff blocks", { pr: { ...CLEAN_PR, changedFiles: 9 } }],
    ["too many changed lines block", { pr: { ...CLEAN_PR, changedLines: 500 } }],
    ["the kill switch blocks", { cfg: { ...MERGE_CFG, autoMerge: false } }],
  ];
  for (const [label, over] of blocked) {
    const d = decide(over);
    assert.equal(d.merge, false, label);
    assert.ok(d.reason.length > 0, `${label} states a reason`);
  }
});

test("selectEvents suppresses signatures inside the cooldown window", () => {
  const attempts = { a: 10_000 };
  const lines = [line({ key: "a" }), line({ key: "b" })];
  const within = selectEvents(lines, attempts, { cooldownMs: HOUR, maxPerPoll: 5, nowMs: 10_000 + HOUR / 2 });
  assert.deepEqual(within.toFix.map((e) => e.key), ["b"]);
  const after = selectEvents(lines, attempts, { cooldownMs: HOUR, maxPerPoll: 5, nowMs: 10_000 + HOUR + 1 });
  assert.equal(after.toFix.length, 2);
});

test("selectEvents caps at maxPerPoll (newest first) and spills the rest to overflow", () => {
  const lines = [line({ key: "a", lastTs: 1 }), line({ key: "b", lastTs: 3 }), line({ key: "c", lastTs: 2 })];
  const { toFix, overflow } = selectEvents(lines, {}, { cooldownMs: HOUR, maxPerPoll: 1, nowMs: 10_000 });
  assert.deepEqual(toFix.map((e) => e.key), ["b"]); // highest lastTs
  assert.deepEqual(overflow.map((e) => e.key).sort(), ["a", "c"]);
});

test("selectEvents ignores malformed JSON lines", () => {
  const { toFix } = selectEvents(["{bad", line({ key: "a" })], {}, { cooldownMs: HOUR, maxPerPoll: 5, nowMs: 1 });
  assert.deepEqual(toFix.map((e) => e.key), ["a"]);
});

test("readNewEvents baselines to EOF on first run (backlog skipped)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "e.jsonl");
  fs.writeFileSync(f, line({ key: "old" }) + "\n");
  const r = readNewEvents(f, { initialized: false, offset: 0, attempts: {} });
  assert.equal(r.baselined, true);
  assert.equal(r.lines.length, 0);
  assert.equal(r.offset, fs.statSync(f).size);
});

test("readNewEvents returns only bytes appended since the stored offset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "e.jsonl");
  fs.writeFileSync(f, line({ key: "a" }) + "\n");
  const off = fs.statSync(f).size;
  fs.appendFileSync(f, line({ key: "b" }) + "\n");
  const r = readNewEvents(f, { initialized: true, offset: off, attempts: {} });
  assert.equal(r.lines.length, 1);
  assert.equal(JSON.parse(r.lines[0]).key, "b");
});

test("readNewEvents baselines at 0 when the log does not exist yet, so the FIRST batch is caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "e.jsonl"); // not created yet
  const first = readNewEvents(f, { initialized: false, offset: 0, attempts: {} });
  assert.equal(first.baselined, true);
  assert.equal(first.offset, 0); // baseline at enable time, not at first-sighting-of-content

  // Alerter later creates the log with the first real events.
  fs.writeFileSync(f, line({ key: "a" }) + "\n" + line({ key: "b" }) + "\n");
  const next = readNewEvents(f, { initialized: true, offset: 0, attempts: {} });
  assert.equal(next.lines.length, 2); // both first-batch events are read, not skipped
});

test("readNewEvents resets the offset when the file is truncated/rotated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "e.jsonl");
  fs.writeFileSync(f, line({ key: "a" }) + "\n");
  const r = readNewEvents(f, { initialized: true, offset: 999_999, attempts: {} });
  assert.equal(r.lines.length, 1); // read from 0, not the stale huge offset
});

test("handleCwalertFix bails out (no worktree) when the target repo isn't a git checkout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  fs.mkdirSync(path.join(dir, "legacy-api")); // folder exists but has no .git
  const dms = [];
  const slack = { postToSelf: async (_, t) => { dms.push(t); return "D1"; } };
  const config = { reposRoot: dir, cwalert: { serviceRepos: {}, baseBranch: "rc" } };
  const res = await handleCwalertFix({
    event: { service: "legacy-api", sample: "boom", consoleUrl: "http://x", ts: 1 },
    config, slack, selfId: "U1",
  });
  assert.equal(res.status, "needs_repo");
  assert.equal(dms.length, 1);
  assert.match(dms[0], /no git checkout/);
});

test("state round-trips and prunes to the most recent attempt keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "state.json");
  saveCwalertState(f, { offset: 42, attempts: { a: 1, b: 2 } });
  const s = loadCwalertState(f);
  assert.equal(s.initialized, true);
  assert.equal(s.offset, 42);
  assert.deepEqual(s.attempts, { a: 1, b: 2 });
});
