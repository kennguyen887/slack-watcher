import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { log } from "../log.js";

// Every handler receives a ctx object:
//   { mention, classification, contextBlock, config, slack, selfId }

const SLACK_TEXT_LIMIT = 3500;
const STOP_REPLY = /^(stop|cancel|skip|huỷ|hủy|dừng|thôi)\b/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VI_RE = /[ơưăđ]|[Ẁ-ỿ]/i;
/** Returns "vi" or "en" based on mention.text only — ignores context block. */
export const detectLang = (text = "") => (VI_RE.test(text) ? "vi" : "en");

// Vietnamese function words that survive being typed without diacritics, so a teammate who
// dropped their VN keyboard ("a oi cai nay em sua o branch nao") still reads as Vietnamese.
// Lookaround, not consuming boundaries: two Vietnamese words in a row ("cai nay em") must
// count as three markers, not two — a consumed separator hides every second word.
const VI_WORDS =
  /(?<=^|[\s,.?!:;()"'])(anh|em|ơi|oi|nhé|nhe|nha|nhen|dùm|dum|đc|dc|được|duoc|ko|không|khong|rồi|roi|này|nay|với|voi|dạ|ạ|vậy|vay|thì|của|cua|mình|minh|giúp|giup|hỏi|sao|nhỉ|nhi|luôn|luon|giùm)(?=$|[\s,.?!:;()"'])/giu;

/**
 * How strongly a message reads as Vietnamese: the number of distinct Vietnamese markers in it.
 *
 * detectLang answers "which language do I write the reply in" and one diacritic is enough for
 * that. This answers a different, riskier question — "may I post publicly under the user's name
 * without them reading it first" — so one stray accented word in an English message (a quoted
 * name, a pasted log line) must NOT be enough. Counting DISTINCT markers is what separates
 * "Ngô sent this CSV" from a real Vietnamese sentence.
 */
export function vietnameseScore(text = "") {
  const words = new Set((text.match(VI_WORDS) ?? []).map((w) => w.trim().toLowerCase()));
  const diacritics = new Set(text.match(/[ơưăđ]|[Ẁ-ỿ]/giu) ?? []);
  return words.size + Math.min(diacritics.size, 3);
}

/** The gate for replying publicly in Vietnamese. English-speaking teammates never pass it. */
export const isVietnamese = (text = "", threshold = 3) => vietnameseScore(text) >= threshold;

export const minutes = (ms) => Math.round(ms / 60_000);
export const trim = (text) =>
  text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n… (truncated)` : text;

/** Thread timestamp for replying to a mention: its own thread if it is a reply, else the message itself. */
export function threadTsOf(mention) {
  return mention.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1] ?? mention.ts;
}

/** Session id handed to `claude -p --session-id`, so the worker's run shows up in Claude Code and can be reopened. */
export const newSessionId = () => crypto.randomUUID();

/**
 * Display title for a worker session (`claude --name`): "<what> — <one-line detail>", cut to
 * one sidebar row. The detail is a Slack summary or an alert line, so it is squashed to one line.
 */
export function sessionTitle(what, detail = "", max = 80) {
  const line = String(detail).replace(/\s+/g, " ").trim();
  const title = line ? `${what} — ${line}` : what;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/**
 * Command that reopens a worker's session interactively. A transcript is keyed by the directory
 * the session STARTED in (the shared sessions dir; a worktree for sessions older than that), so
 * the `cd` goes there, and --add-dir brings the kept worktree back in reach.
 */
export const resumeCommand = (sessionCwd, sessionId, worktreePath) =>
  `cd ${sessionCwd} && claude --resume ${sessionId}${worktreePath && worktreePath !== sessionCwd ? ` --add-dir ${worktreePath}` : ""}`;

/** resumeCommand, formatted for a Slack DM. */
export const resumeHint = (...args) => `\`${resumeCommand(...args)}\``;

/**
 * Surface a finished worker session in the Claude desktop app (macOS): the app's
 * claude://resume deep link imports the CLI transcript from disk and lists the
 * session in its UI (idempotent — re-importing unarchives the same session).
 * Fire-and-forget: `-g` keeps the app from stealing focus, and a missing app or
 * handler must never affect the worker result — the DM still carries the
 * terminal resume command.
 */
export function showInDesktopApp(sessionId) {
  if (process.platform !== "darwin") return;
  try {
    spawn("open", ["-g", `claude://resume?session=${sessionId}`], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // DM fallback covers it
  }
}

/**
 * While a worker runs, poll the self-DM for a "stop" reply and abort the
 * controller when one arrives — lets the user kill a running Claude session.
 * Returns a cleanup function; always call it when the worker settles.
 */
export function watchForStop(ctx, dmChannel, label, controller, intervalMs = 20_000) {
  const since = Date.now() / 1000;
  const timer = setInterval(async () => {
    try {
      const replies = await ctx.slack.fetchMessagesSince(dmChannel, since);
      if (replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) {
        log(`[${label}] stop received — killing the running worker`);
        clearInterval(timer);
        controller.abort();
      }
    } catch {
      // transient Slack error — try again next tick
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Wait out the grace window; true = the task must be dropped, either because the
 * user replied "stop" in the self-DM, or because they answered the original
 * conversation themselves while we were waiting.
 */
export async function cancelledDuringGrace(ctx, dmChannel, label) {
  const { config, slack, selfId, mention } = ctx;
  if (config.workerGraceMs <= 0) return false;
  const graceStart = Date.now() / 1000;
  log(`[${label}] grace window ${minutes(config.workerGraceMs)} min — reply "stop" in self-DM to cancel`);
  await sleep(config.workerGraceMs);

  const replies = await slack.fetchMessagesSince(dmChannel, graceStart);
  if (replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) {
    log(`[${label}] cancelled by user during grace window`);
    await slack.postToSelf(selfId, `:no_entry: Cancelled — I won't touch this request. ${mention.permalink ?? ""}`);
    return true;
  }

  // The user may have answered the thread themselves instead of typing "stop".
  // Thread-only: a stray channel message must not count as handling the request.
  const context = await slack.fetchContext(mention, ctx.config.contextWindowSeconds);
  const replied =
    context.kind === "thread" &&
    context.messages.some((m) => m.user === selfId && Number.parseFloat(m.ts) > Number.parseFloat(mention.ts));
  if (replied) {
    log(`[${label}] cancelled — you already replied in the conversation`);
    await slack.postToSelf(
      selfId,
      `:no_entry: Skipped — you already replied in the conversation yourself, so I'm staying out of it. ${mention.permalink ?? ""}`,
    );
    return true;
  }
  return false;
}
