// The daily report is posted to a TEAM thread verbatim, so the gate between the worker's reply
// and Slack is pinned here. Regression (2026-10-08): the worker answered "Today:\n\nNONE"; the
// old check only looked at the header and the placeholder was posted as the day's report.
// Rule: no bullets = nothing to say = no post, however the model phrased it.
import test from "node:test";
import assert from "node:assert/strict";

import { parseReport, formatReport } from "../src/daily-report.js";

test("parseReport treats a header with only a placeholder as nothing to report", () => {
  assert.deepEqual(parseReport("Today:\n\nNONE"), []);
  assert.deepEqual(parseReport("Today:\n• None"), []);
  assert.deepEqual(parseReport("Today:\n\n• No tasks today."), []);
  assert.deepEqual(parseReport("Today:"), []);
  assert.deepEqual(parseReport("NONE"), []);
});

test("parseReport keeps real bullets, drops placeholder ones and normalises the marker", () => {
  const text = "Today:\n\n• COM-1234 Connect the SMS provider number (Done)\n- Claude Code push guard across 6 repos (Merged)\n• None\n";
  assert.deepEqual(parseReport(text), [
    "• COM-1234 Connect the SMS provider number (Done)",
    "• Claude Code push guard across 6 repos (Merged)",
  ]);
});

test("parseReport rejects prose and a missing header so the run retries instead of posting", () => {
  assert.equal(parseReport("No match — none of the 10 PRs map to a Linear ticket, so nothing qualifies."), null);
  assert.equal(parseReport("Today:\n• COM-1 x (Done)\nNote: skipped the release PRs."), null);
  assert.equal(parseReport("• COM-1 x (Done)"), null);
});

test("parseReport caps the report at five tasks, keeping the first ones", () => {
  const text = `Today:\n${Array.from({ length: 7 }, (_, i) => `• task ${i + 1} (Done)`).join("\n")}`;
  assert.deepEqual(parseReport(text), ["• task 1 (Done)", "• task 2 (Done)", "• task 3 (Done)", "• task 4 (Done)", "• task 5 (Done)"]);
});

test("formatReport owns the posted shape", () => {
  assert.equal(formatReport(["• a (Done)", "• b (In progress)"]), "Today:\n\n• a (Done)\n• b (In progress)");
});
