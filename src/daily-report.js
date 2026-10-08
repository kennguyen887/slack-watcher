#!/usr/bin/env node
// Reply to the weekday "post your daily updates" bot thread with a short "Today:" report,
// at a RANDOM time after the thread opens — a fixed minute would read as a bot.
//
// Run every few minutes (launchd, see launchd/com.slack-watcher-daily.plist.template); each
// run is a cheap no-op until today's random post time arrives. Per run:
//   1. Mon–Fri only, inside DAILY_REPORT_WINDOW (local time, default 14-21).
//   2. Find today's reminder thread in DAILY_REPORT_CHANNEL; stop if you already replied in it.
//   3. First sighting of a thread fixes today's post time = thread open + random(min..max) minutes
//      (persisted, so every run agrees on it).
//   4. At that time, `claude -p` builds the report from today's PRs (gh) + my Linear issues; the
//      code parses it into bullets (at most MAX_TASKS) and posts them. No bullets = nothing to say =
//      no post, ever.
//
// `node src/daily-report.js --preview` builds and prints today's report without touching Slack or
// the state file — for iterating on the prompt.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_DIR, loadConfig } from "./config.js";
import { runClaude } from "./claude.js";
import { log } from "./log.js";

const STATE_FILE = path.join(BASE_DIR, "daily-report-state.json");
const MAX_ATTEMPTS = 3;
const MAX_REPORT_CHARS = 1500;
const MAX_TASKS = 5;
const REMINDER_RE = /daily updates/i;
const HEADER = "Today:";
const BULLET_RE = /^[•\-*]\s+(.+)$/;
// A "nothing to report" placeholder, alone or as a bullet. The 2026-10-08 post was literally
// "Today:\n\nNONE": the header passed the old shape check and the placeholder went to the team.
const EMPTY_RE = /^(none|nothing|n\/a|no (tasks?|prs?|tickets?)( today)?)\.?$/i;

/** Random post time (epoch seconds): thread open + uniform(minMin..maxMin) minutes. */
export function pickPostTime(threadTs, minMin, maxMin, rand = Math.random) {
  return Math.floor(Number(threadTs) + (minMin + rand() * (maxMin - minMin)) * 60);
}

export function inWindow(now, [from, to]) {
  const day = now.getDay();
  return day >= 1 && day <= 5 && now.getHours() >= from && now.getHours() < to;
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};

async function slack(token, method, params, post = false) {
  const res = await fetch(`https://slack.com/api/${method}${post ? "" : `?${new URLSearchParams(params)}`}`, {
    method: post ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(post && { "Content-Type": "application/json" }) },
    ...(post && { body: JSON.stringify(params) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`slack ${method}: ${body.error}`);
  return body;
}

export function reportPrompt(today) {
  return `Today is ${today} (local time). Build my short daily report for Slack.
Your reply is posted to a team thread VERBATIM: it contains the report and nothing else — no reasoning, no notes, no explanation of what you skipped.

Collect BOTH sources:
1. PRs I authored that were created, merged or updated today:
   gh search prs --author @me --updated ">=${today}" --json number,title,state,repository,url,createdAt,updatedAt
2. Linear issues assigned to me that were created or updated today (linear_getViewer for my id, then linear_searchIssues with assigneeId; keep updatedAt >= today local).

At most ${MAX_TASKS} lines, most important first (merged / done / in progress before todo); one line per TASK, not per PR or ticket:
- A PR with a ticket (COM-xxxx in its title, branch or body) belongs to that ticket; several PRs of one ticket = one line.
- A PR WITHOUT a ticket is still my work: just its title (the PR title without the "fix(scope):" / "chore(scope):" prefix), no ID. The same PR title in several repos = ONE line, say how many repos ("across 6 repos").
- A Linear issue I created or moved today with no PR = one line: its ID + title.
- Skip only: bot-generated release PRs ("chore(main): release x.y.z") and work that is not mine.
- Status = what is true NOW, from the PR/ticket: Done, Merged, PR open (in review), In progress, Todo, RC done / prod pending. Do not copy a stale Linear state.

Output exactly this shape, plain "•" bullets, one short line each, no links, nothing before or after:

Today:

• COM-1234 <ticket title> (<status>)
• <task title> (<status>)

If there is truly no task today, output the single word NONE and nothing else.`;
}

/**
 * The worker's reply as bullet lines, [] when it says there is nothing to report, null when it is
 * not a report at all (prose, wrong header). Placeholder bullets ("• None") are dropped, so an
 * empty report can never reach Slack no matter how the model phrased it; the rest is capped at
 * MAX_TASKS in the order the model gave (it is told to put the important ones first).
 */
export function parseReport(text) {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && EMPTY_RE.test(lines[0])) return [];
  const [header, ...rest] = lines;
  if (header !== HEADER) return null;
  const content = (line) => line.replace(BULLET_RE, "$1");
  if (rest.some((line) => !BULLET_RE.test(line) && !EMPTY_RE.test(line))) return null;
  return rest
    .filter((line) => BULLET_RE.test(line) && !EMPTY_RE.test(content(line)))
    .map((line) => `• ${content(line)}`)
    .slice(0, MAX_TASKS);
}

export const formatReport = (bullets) => `${HEADER}\n\n${bullets.join("\n")}`;

/** Run the worker once and return today's report, or null when there is nothing to post. */
async function buildReport(config, today) {
  const text = (
    await runClaude({
      bin: config.claudeBin,
      prompt: reportPrompt(today),
      cwd: BASE_DIR,
      timeoutMs: 5 * 60_000,
      model: config.workerModel,
      extraArgs: config.workerClaudeArgs,
      label: "daily-report",
    })
  ).trim();
  const bullets = parseReport(text);
  if (bullets === null) throw new Error(`unexpected report shape: ${text.slice(0, 200)}`);
  if (bullets.length === 0) return null;
  const report = formatReport(bullets);
  if (report.length > MAX_REPORT_CHARS) throw new Error(`report too long (${report.length} chars): ${report.slice(0, 200)}`);
  return report;
}

export async function preview(config = loadConfig(), now = new Date()) {
  const report = await buildReport(config, localDate(now));
  console.log(report === null ? "[daily-report] preview: nothing to report, would NOT post" : `[daily-report] preview, would post:\n${report}`);
}

export async function main(config = loadConfig(), now = new Date()) {
  const channel = process.env.DAILY_REPORT_CHANNEL || config.dailyReport.channel;
  if (!config.dailyReport.enabled || !channel) return;
  if (!inWindow(now, config.dailyReport.window)) return;

  const today = localDate(now);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const state = readState();
  const day = state.date === today ? state : { date: today };
  if (day.done) return;

  const { user_id: userId } = await slack(config.slackToken, "auth.test", {});
  const { messages = [] } = await slack(config.slackToken, "conversations.history", {
    channel,
    oldest: String(startOfDay),
    limit: "50",
  });
  const thread = messages.filter((m) => REMINDER_RE.test(m.text ?? "") && (m.bot_id || m.user === "USLACKBOT")).pop();
  if (!thread) return;

  const { messages: replies = [] } = await slack(config.slackToken, "conversations.replies", { channel, ts: thread.ts, limit: "50" });
  if (replies.some((m) => m.user === userId)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...day, done: true }));
    return;
  }

  if (day.threadTs !== thread.ts) {
    day.threadTs = thread.ts;
    day.postAt = pickPostTime(thread.ts, config.dailyReport.minMinutes, config.dailyReport.maxMinutes);
    day.attempts = 0;
    fs.writeFileSync(STATE_FILE, JSON.stringify(day));
    log(`[daily-report] thread ${thread.ts}: will post at ${new Date(day.postAt * 1000).toString()}`);
  }
  if (now.getTime() / 1000 < day.postAt) return;
  if (day.attempts >= MAX_ATTEMPTS) return;

  day.attempts += 1;
  fs.writeFileSync(STATE_FILE, JSON.stringify(day));
  const report = await buildReport(config, today);

  if (report === null) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...day, done: true }));
    return log("[daily-report] nothing to report today — skipped");
  }
  if (config.dryRun) return log(`[daily-report] DRY_RUN would post:\n${report}`);

  await slack(config.slackToken, "chat.postMessage", { channel, thread_ts: thread.ts, text: report, unfurl_links: false }, true);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...day, done: true }));
  log(`[daily-report] posted to thread ${thread.ts}`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  (process.argv.includes("--preview") ? preview() : main()).catch((err) => {
    log(`[daily-report] failed: ${err.message}`);
    process.exit(1);
  });
}
