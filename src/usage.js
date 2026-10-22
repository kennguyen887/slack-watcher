#!/usr/bin/env node
// Summarize logs/usage.jsonl (one line per `claude -p` run, written by runClaude):
//   npm run usage              last 7 days, per day × role, plus the 5 costliest runs
//   npm run usage -- --days 30
// A role is the run's label up to the first ":" — "review:repo#12" counts as "review".
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { USAGE_LOG } from "./claude.js";

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;

export function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.ts.slice(0, 10)}  ${(r.role ?? "?").split(":")[0]}`;
    const g = groups.get(key) ?? { runs: 0, cost: 0, input: 0, cacheRead: 0, output: 0 };
    g.runs += 1;
    g.cost += r.costUsd ?? 0;
    g.input += r.inputTokens + r.cacheWriteTokens;
    g.cacheRead += r.cacheReadTokens;
    g.output += r.outputTokens;
    groups.set(key, g);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function main() {
  const i = process.argv.indexOf("--days");
  const days = i > -1 ? Number(process.argv[i + 1]) : 7;
  if (!fs.existsSync(USAGE_LOG)) return console.log(`no runs logged yet (${USAGE_LOG})`);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = fs
    .readFileSync(USAGE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.ts.slice(0, 10) >= since);

  console.log("day         role        runs   cost     in+cacheW  cacheRead  out");
  for (const [key, g] of summarize(rows)) {
    console.log(`${key.padEnd(24)}${String(g.runs).padStart(4)}  ${usd(g.cost).padStart(7)}  ${k(g.input).padStart(9)}  ${k(g.cacheRead).padStart(9)}  ${k(g.output).padStart(5)}`);
  }
  const total = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  console.log(`\ntotal ${rows.length} runs, ${usd(total)} over ${days} day(s)\n\ncostliest runs:`);
  for (const r of [...rows].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 5)) {
    console.log(`  ${usd(r.costUsd ?? 0).padStart(6)}  ${r.ts.slice(0, 16)}  ${r.role}  ${r.turns} turns  prompt ${k(r.promptChars)} chars  session ${r.sessionId}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
