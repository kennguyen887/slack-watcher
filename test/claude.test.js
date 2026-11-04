// Tests the Fable-first / Opus-fallback contract in runClaude. Exercises the real
// spawn path through a fake `claude` binary that succeeds or fails based on --model.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runClaude } from "../src/claude.js";

// Fake claude: exits 1 for model "FAIL", otherwise emits a success result event
// echoing back the model it was invoked with, so tests can see which one ran.
const FAKE = `#!/usr/bin/env bash
model=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--model" ]; then model="$a"; fi
  prev="$a"
done
if [ "$model" = "FAIL" ]; then
  echo "no access to model $model" >&2
  exit 1
fi
echo '{"type":"result","subtype":"success","result":"ran:'"$model"'"}'
exit 0
`;

function fakeBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fake-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  return bin;
}

const base = { prompt: "hi", cwd: process.cwd(), timeoutMs: 10_000 };

test("falls back to the fallback model when the primary fails", async () => {
  const result = await runClaude({ ...base, bin: fakeBin(), model: "FAIL", fallbackModel: "claude-opus-4-8" });
  assert.equal(result, "ran:claude-opus-4-8");
});

test("uses only the primary model when it succeeds (no fallback call)", async () => {
  const result = await runClaude({ ...base, bin: fakeBin(), model: "claude-fable-5", fallbackModel: "claude-opus-4-8" });
  assert.equal(result, "ran:claude-fable-5");
});

test("does not retry when no fallback model is configured", async () => {
  await assert.rejects(
    runClaude({ ...base, bin: fakeBin(), model: "FAIL" }),
    /claude exited 1/,
  );
});
