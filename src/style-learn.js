#!/usr/bin/env node
// Learn how the user writes on Slack, from the user's own Slack messages.
//
// `npm run learn-style` — walks back through `from:@me` search results, throws away everything
// this tool itself wrote, keeps the Vietnamese ones, and has Claude distill them into
// style/profile.md. The auto-reply handler refuses to post publicly without that file: a reply
// in someone's name has to sound like them, and the only source of truth for that is what they
// actually type. Re-run it whenever the voice drifts.
//
// Nothing it writes is committed (style/ is gitignored) — it is a distillation of real
// conversations, and this repository is public.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createSlackClient } from "./slack.js";
import { runClaude } from "./claude.js";
import { vietnameseScore } from "./handlers/shared.js";
import { STYLE_DIR, PROFILE_FILE, SAMPLES_FILE } from "./style.js";
import { log } from "./log.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 12;
const MAX_SAMPLES = 320;

// Output this tool posted under the user's own account — self-DM status reports, monitoring
// alerts, review summaries. Learning from those would teach the model to imitate itself.
const MACHINE_WRITTEN =
  /^(:[a-z0-9_+-]+:|\*(PR review|Watcher))|\bclaude --resume\b|\bworktree\b|^Original: <http|REVIEW_STATUS:|Root-cause confidence:/;

/** True for a message the watcher (or another script) wrote, not the human. */
export function isMachineWritten(text = "") {
  return MACHINE_WRITTEN.test(text.trim());
}

/**
 * Pick the messages worth learning from.
 *
 * The self-DM is this tool talking to itself, so it is dropped WHOLE rather than pattern-matched:
 * its channel name is the user's own id. What is left is filtered to real Vietnamese prose —
 * one-word acks ("ok", "uh") carry no voice, and code blocks/links are noise.
 */
export function selectSamples(matches, { selfId, minScore = 2, limit = MAX_SAMPLES } = {}) {
  return matches
    .filter((m) => m.channel?.name !== selfId) // self-DM = this tool's own output
    .map((m) => ({
      ts: m.ts,
      channel: m.channel?.name ?? "?",
      isDm: !!m.channel?.is_im,
      inThread: /thread_ts=/.test(m.permalink ?? ""),
      text: (m.text ?? "").trim(),
    }))
    .filter((m) => m.text && !isMachineWritten(m.text))
    .filter((m) => !m.text.startsWith("```"))
    .filter((m) => m.text.split(/\s+/).length >= 3)
    .filter((m) => vietnameseScore(m.text) >= minScore)
    .slice(0, limit);
}

/** Hard numbers the model should not have to eyeball — they anchor "keep it short". */
export function measure(samples) {
  const chars = samples.map((s) => s.text.length).sort((a, b) => a - b);
  const words = samples.map((s) => s.text.split(/\s+/).length).sort((a, b) => a - b);
  const at = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
  const share = (fn) => Math.round((100 * samples.filter(fn).length) / (samples.length || 1));
  return {
    count: samples.length,
    medianChars: at(chars, 0.5),
    p90Chars: at(chars, 0.9),
    medianWords: at(words, 0.5),
    p90Words: at(words, 0.9),
    pctEmoji: share((s) => /:[a-z0-9_+-]+:/.test(s.text)),
    pctMultiline: share((s) => s.text.includes("\n")),
    pctEndPunctuation: share((s) => /[.!?]$/.test(s.text)),
    pctLowercaseStart: share((s) => /^[a-zà-ỹ]/.test(s.text)),
    pctMentionsSomeone: share((s) => /<@U/.test(s.text)),
    pctInThread: share((s) => s.inThread),
  };
}

function distillPrompt(samples, stats) {
  return `Below are ${samples.length} real Slack messages I wrote, in Vietnamese, to my dev team.
Write a STYLE PROFILE that another writer could follow to produce a new message indistinguishable
from mine.

Measured facts about these messages (use them, do not contradict them):
- median ${stats.medianChars} characters / ${stats.medianWords} words; 90th percentile ${stats.p90Chars} characters / ${stats.p90Words} words
- ${stats.pctEmoji}% contain an emoji, ${stats.pctMultiline}% span more than one line
- ${stats.pctEndPunctuation}% end with . ! or ?, ${stats.pctLowercaseStart}% start with a lowercase letter
- ${stats.pctMentionsSomeone}% address someone with an <@USER> mention, ${stats.pctInThread}% are thread replies

My messages:
"""
${samples.map((s) => s.text).join("\n---\n")}
"""

Produce Markdown with exactly these sections:

## Voice
How I come across and where I sit relative to the reader (seniority, directness, warmth). 4-6 bullets.

## Form
Length, sentence shape, capitalization, punctuation, emoji, line breaks, when I address someone by
mention. Be concrete and numeric — quote the measured facts above.

## Words
The Vietnamese register I use (regional flavour, particles, pronouns and how I refer to myself and
to the reader), my habitual abbreviations, and which words I always leave in English rather than
translating. List the actual tokens.

## Moves
The recurring shapes of my replies — how I confirm, how I correct someone, how I hand work back,
how I say I will do it myself, how I say no, how I ask for more information. One line each, with a
real example from above in backticks.

## Never
What would immediately read as "not him": constructions, politeness formulas, formatting habits and
vocabulary that never appear in my messages. Be specific.

## Examples
15-20 of my most characteristic messages, verbatim, one per line as a markdown list. Pick ones that
are answers or instructions to a teammate — those are the shape that gets generated.

Write the profile in English (it is read by a model), but keep every quoted Vietnamese example
exactly as I typed it — including the abbreviations, the missing diacritics and the lowercase.
Output only the Markdown, no preamble.`;
}

async function main() {
  const config = loadConfig();
  const slack = createSlackClient(config.slackToken, {});
  const { userId, userName } = await slack.whoAmI();
  log(`learning the Slack voice of @${userName} (${userId})`);

  const matches = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await slack.searchMentions(`from:@${userName}`, PAGE_SIZE, page);
    matches.push(...batch);
    log(`page ${page}: ${batch.length} message(s), ${matches.length} total`);
    if (batch.length < PAGE_SIZE) break;
  }

  const samples = selectSamples(matches, { selfId: userId });
  if (samples.length < 40) {
    throw new Error(
      `only ${samples.length} usable Vietnamese message(s) found — too few to learn a voice from. ` +
        "Write more, or lower the bar in selectSamples().",
    );
  }
  const stats = measure(samples);
  log(`${samples.length} sample(s) kept — median ${stats.medianChars} chars / ${stats.medianWords} words`);

  const profile = await runClaude({
    bin: config.claudeBin,
    prompt: distillPrompt(samples, stats),
    cwd: config.reposRoot,
    timeoutMs: 10 * 60_000,
    model: config.reviewModel,
    label: "style",
  });

  fs.mkdirSync(STYLE_DIR, { recursive: true });
  fs.writeFileSync(SAMPLES_FILE, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  fs.writeFileSync(PROFILE_FILE, `${profile.trim()}\n`);
  log(`wrote ${path.relative(process.cwd(), PROFILE_FILE)} (${profile.length} chars) and ${samples.length} samples`);
  log("auto-reply will now speak in this voice — re-run this any time it drifts");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`style-learn failed: ${err.message}`);
    process.exit(1);
  });
}
