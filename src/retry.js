/*
 * Requeue a mention the watcher gave up on, so the next poll processes it again.
 * The give-up DM names this command; without it, recovery means hand-editing state.json.
 *   npm run retry -- C0123456789:1700000000.000100
 */
import { loadConfig } from "./config.js";
import { loadState, saveState } from "./state.js";

const key = process.argv[2];
if (!key) {
  console.error("usage: npm run retry -- <channelId>:<messageTs>");
  process.exit(1);
}

const ts = key.split(":")[1];
if (!ts || Number.isNaN(Number.parseFloat(ts))) {
  console.error(`not a mention key: ${key}`);
  process.exit(1);
}

const config = loadConfig();
const state = loadState(config.stateFile);
const wasProcessed = state.processed.includes(key);
state.processed = state.processed.filter((k) => k !== key);
// pending re-admits the mention whatever lastTs says, so the window needs no surgery.
state.pending[key] = { ts, attempts: 0, requeuedAt: new Date().toISOString() };
saveState(config.stateFile, state);
console.log(`requeued ${key}${wasProcessed ? " (cleared its dedupe entry)" : ""} — the next poll picks it up`);
