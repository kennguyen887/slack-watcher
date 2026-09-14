// A mention whose processing threw used to be consumed anyway, so one bad poll dropped the
// request for good (2026-09-14: the CLI's OAuth had gone, and a two-PR review request was
// swallowed silently). The retry queue is what keeps it. The poll itself needs live Slack, so
// the honest boundaries here are the re-admission gate and the requeue CLI. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findNewMentions } from "../src/index.js";
import { loadState, saveState } from "../src/state.js";

const SELF = "U1";
const msg = (ts, over = {}) => ({ ts, user: "U2", text: `<@${SELF}> please review`, channel: { id: "C1" }, ...over });

test("findNewMentions re-admits a pending mention that lastTs has already passed", () => {
  const mention = msg("100.5");
  const state = { lastTs: 200, processed: [], pending: {} };

  // Without a retry entry the mention sits below the search window and is gone.
  assert.deepEqual(findNewMentions([mention], state, SELF), []);

  // Queued for retry, it comes back even though lastTs moved past it.
  state.pending["C1:100.5"] = { ts: "100.5", attempts: 1, lastError: "claude failed" };
  assert.deepEqual(
    findNewMentions([mention], state, SELF).map((m) => m.ts),
    ["100.5"],
  );

  // Dedupe still wins: once consumed it never comes back, retry entry or not.
  state.processed.push("C1:100.5");
  assert.deepEqual(findNewMentions([mention], state, SELF), []);
});

test("state round-trips the retry queue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-state-"));
  const file = path.join(dir, "state.json");

  saveState(file, { lastTs: 5, processed: ["C1:1"], pending: { "C1:2": { ts: "2", attempts: 3 } } });
  const back = loadState(file);
  assert.equal(back.pending["C1:2"].attempts, 3);

  // A state file written before the queue existed must still load.
  fs.writeFileSync(file, JSON.stringify({ lastTs: 5, processed: [] }));
  assert.deepEqual(loadState(file).pending, {});
});
