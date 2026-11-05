import fs from "node:fs";
import path from "node:path";
import { BASE_DIR } from "./config.js";

// Where `npm run learn-style` writes what it learned. Gitignored: it is a distillation of
// real Slack messages — the team's words and the user's own voice — and this repo is public.
export const STYLE_DIR = path.join(BASE_DIR, "style");
export const PROFILE_FILE = path.join(STYLE_DIR, "profile.md");
export const SAMPLES_FILE = path.join(STYLE_DIR, "samples.jsonl");

/**
 * The learned voice, or null when it was never learned.
 *
 * null is a REFUSAL, not a default: without a profile the answerer has no idea how the user
 * writes, and a fluent-but-generic reply posted under their name reads as a bot to the exact
 * people who know them best. Callers fall back to a private draft instead of posting.
 */
export function loadStyleProfile(file = PROFILE_FILE) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  return text.length ? text : null;
}

/** Prompt block carrying the learned voice. Empty string when there is nothing learned. */
export function styleBlock(profile) {
  if (!profile) return "";
  return `
HOW I WRITE ON SLACK — this reply goes out under MY name, so it has to sound like me, not like an
assistant. The profile below was distilled from my own real Slack messages; follow it over any
instinct you have about "good" chat writing.
"""
${profile}
"""
`;
}
