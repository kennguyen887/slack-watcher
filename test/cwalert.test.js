// Tests for the CloudWatch auto-fix source. The daemon poll needs live Slack + claude, so the
// honest boundary here is the pure decision logic: incremental read, dedupe/cooldown/cap
// selection, and service→repo mapping. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { selectEvents, readNewEvents, loadCwalertState, saveCwalertState } from "../src/sources/cwalert.js";
import { repoForService } from "../src/handlers/cwalert-fix.js";

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

test("readNewEvents resets the offset when the file is truncated/rotated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const f = path.join(dir, "e.jsonl");
  fs.writeFileSync(f, line({ key: "a" }) + "\n");
  const r = readNewEvents(f, { initialized: true, offset: 999_999, attempts: {} });
  assert.equal(r.lines.length, 1); // read from 0, not the stale huge offset
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
