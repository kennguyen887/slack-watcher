import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordUsage } from "../src/claude.js";
import { leanWorkerArgs } from "../src/config.js";
import { summarize } from "../src/usage.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));

test("recordUsage appends one line with tokens, cost and the prompt", () => {
  const file = path.join(tmp(), "logs", "usage.jsonl");
  const event = {
    type: "result", subtype: "success", is_error: false, session_id: "s1", num_turns: 3, duration_ms: 900,
    total_cost_usd: 0.42, modelUsage: { "claude-opus-5-5": {} },
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 50 },
  };
  recordUsage(event, { role: "review:repo#1", model: "opus", effort: "medium", prompt: "hello" }, file);
  const [line] = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(line.role, "review:repo#1");
  assert.equal(line.model, "claude-opus-5-5");
  assert.equal(line.costUsd, 0.42);
  assert.equal(line.cacheReadTokens, 3000);
  assert.equal(line.prompt, "hello");
  assert.equal(line.ok, true);
});

test("summarize groups by day and role prefix", () => {
  const row = (ts, role, cost) => ({ ts, role, costUsd: cost, inputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 5, outputTokens: 2 });
  const out = summarize([row("2026-10-22T10", "review:a#1", 1), row("2026-10-22T11", "review:b#2", 2), row("2026-10-22T12", "classify", 0.01)]);
  assert.deepEqual(out.map(([key, g]) => [key, g.runs, g.cost]), [["2026-10-22  classify", 1, 0.01], ["2026-10-22  review", 2, 3]]);
});

test("leanWorkerArgs restricts tools and MCP servers, and keeps variadic flags off the end", () => {
  const dir = tmp();
  const cfg = path.join(dir, "claude.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { "linear-api": { command: "x" }, playwright: { command: "y" } } }));
  const args = leanWorkerArgs({ tools: ["Bash", "Read"], mcpServers: ["linear-api", "missing"] }, cfg, path.join(dir, "mcp.json"));
  assert.deepEqual(args.slice(0, 2), ["--tools", "Bash,Read"]);
  const mcpFile = args[args.indexOf("--mcp-config") + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(mcpFile, "utf8")), { mcpServers: { "linear-api": { command: "x" } } });
  assert.equal(fs.statSync(mcpFile).mode & 0o077, 0);
  assert.equal(args.at(-1), "--disable-slash-commands");
  assert.deepEqual(leanWorkerArgs({ tools: null, mcpServers: null }), ["--disable-slash-commands"]);
});
