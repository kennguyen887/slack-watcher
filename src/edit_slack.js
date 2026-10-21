#!/usr/bin/env node
// Edit a message you already sent — send.js cannot take one back, this rewrites it in place.
//
// CLI:
//   node src/edit_slack.js "https://x.slack.com/archives/C123/p1789368905765999" "fixed text"
//   printf '%s' "$MSG" | node src/edit_slack.js --cap 500 --last "#dev-channel" -
//   node src/edit_slack.js --dry-run --last "#dev-channel"      (print the message, edit nothing)
//
// Target: a message permalink, or --last "#channel" for your newest message there (found via
// search, so a message posted in the last few seconds may not be indexed yet). Only messages
// posted as you can be edited; a webhook post answers cant_update_message.
//
// Guards: the same --cap and SEND_ALLOWED_TARGETS as send.js, and the old text is printed
// before it is replaced so a wrong target is visible in the output.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createSlackClient } from "./slack.js";
import { DEFAULT_CAP, countChars, validateSend } from "./send.js";

const PERMALINK_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;

/** Permalink → { channel, ts }, or null when the string is not one. */
export function parsePermalink(link) {
  const match = PERMALINK_RE.exec(link ?? "");
  return match ? { channel: match[1], ts: `${match[2]}.${match[3]}` } : null;
}

export async function resolveTarget(slack, { permalink, last }) {
  if (last) return slack.findLastOwnMessage(last);
  const parsed = parsePermalink(permalink);
  if (!parsed) throw new Error(`not a Slack message permalink: ${permalink}`);
  return { ...parsed, text: null, permalink };
}

function takeOption(args, name, { hasValue = true } = {}) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = hasValue ? args[at + 1] : true;
  args.splice(at, hasValue ? 2 : 1);
  return value;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const args = process.argv.slice(2);
  const cap = Number.parseInt(takeOption(args, "--cap") ?? String(DEFAULT_CAP), 10);
  const dryRun = takeOption(args, "--dry-run", { hasValue: false }) === true;
  const last = takeOption(args, "--last");
  const permalink = last ? undefined : args.shift();
  let text = args.join(" ");
  if (text === "-" || (!text && !dryRun && !process.stdin.isTTY)) {
    text = fs.readFileSync(0, "utf8").trim();
  }
  if (!Number.isInteger(cap) || cap <= 0 || !(last || permalink) || (!text && !dryRun)) {
    console.error(
      'usage: edit_slack.js [--cap N] [--dry-run] <permalink | --last "#channel"> <message... | ->',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const slack = createSlackClient(config.slackToken, config.slackWebhooks);
  try {
    const target = await resolveTarget(slack, { permalink, last });
    // The allowlist names channels, so check the name the user gave when there is one.
    const refusal = dryRun
      ? null
      : validateSend(last ?? target.channel, text, { cap, allowedTargets: config.sendAllowedTargets });
    if (refusal) throw new Error(`refused: ${refusal}`);
    if (target.text) console.log(`current text (${target.permalink}):\n${target.text}\n`);
    if (dryRun) process.exit(0);
    await slack.update(target.channel, target.ts, text);
    console.log(`edited ${target.channel} ${target.ts} — ${countChars(text)} chars`);
  } catch (err) {
    console.error(`failed: ${err.message}`);
    process.exit(1);
  }
}
