import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { handleCwalertFix } from "../handlers/cwalert-fix.js";
import { trim } from "../handlers/shared.js";

const MAX_ATTEMPT_KEYS = 500;
// Severities worth an auto-fix attempt. `fatal` comes from the Sentry producer (a crash the
// app itself classified); the CloudWatch alerter only ever emits `error`. Anything else
// (warn/info) is noise we must not open PRs for.
const FIXABLE_SEVERITIES = new Set(["error", "fatal"]);
// Severities that must reach the human FAST but must never open a PR. `flood` = the alerter saw
// an abnormal volume of a NON-error line (e.g. a bot hammering a public form so every lead is
// mailed out "successfully"). There is no stack trace to fix from and the call — block the
// sender, add a captcha, throttle — is the human's; a worker would only guess at code.
const ALERT_SEVERITIES = new Set(["flood"]);

export function loadCwalertState(stateFile) {
  if (!fs.existsSync(stateFile)) return { initialized: false, offset: 0, attempts: {} };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { initialized: s.initialized ?? false, offset: s.offset ?? 0, attempts: s.attempts ?? {} };
  } catch {
    return { initialized: false, offset: 0, attempts: {} };
  }
}

export function saveCwalertState(stateFile, state) {
  // Keep only the most recent attempt keys so the file can't grow without bound.
  const entries = Object.entries(state.attempts).sort((a, b) => b[1] - a[1]).slice(0, MAX_ATTEMPT_KEYS);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ initialized: true, offset: state.offset, attempts: Object.fromEntries(entries) }, null, 2),
  );
}

/**
 * Read new bytes from the event log since the stored offset. First run baselines to EOF so a
 * historical backlog is never replayed. A shrunk file (rotation/truncation) resets the offset.
 * @returns {{ lines: string[], offset: number, baselined: boolean }}
 */
export function readNewEvents(eventLog, state) {
  const exists = fs.existsSync(eventLog);
  const size = exists ? fs.statSync(eventLog).size : 0;
  // First run baselines at ENABLE time: a pre-existing backlog (log already had content) is
  // skipped, but a log that doesn't exist yet baselines at 0 — so the FIRST events written
  // after we're enabled are caught, not mistaken for backlog and dropped.
  if (!state.initialized) return { lines: [], offset: size, baselined: true };
  if (!exists) return { lines: [], offset: 0, baselined: false }; // log rotated/removed since
  let from = state.offset;
  if (size < from) from = 0; // file was rotated/truncated
  if (size === from) return { lines: [], offset: size, baselined: false };
  const fd = fs.openSync(eventLog, "r");
  try {
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    return { lines, offset: size, baselined: false };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pure selection: what to act on this poll. Dedupes by key (newest wins), drops signatures still
 * inside the cooldown, orders newest-first, then splits by lane — fixable errors are capped at
 * maxPerPoll (each one costs a worker + a PR), alert-only events are never capped (a DM is cheap,
 * and holding back an in-progress flood is exactly the failure we are fixing).
 * @returns {{ toFix: object[], overflow: object[], toAlert: object[] }}
 */
export function selectEvents(lines, attempts, { cooldownMs, maxPerPoll, nowMs }) {
  const byKey = new Map();
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || !e.key) continue;
    if (FIXABLE_SEVERITIES.has(e.severity) || ALERT_SEVERITIES.has(e.severity)) byKey.set(e.key, e); // later line = newer occurrence
  }
  const fresh = [...byKey.values()]
    .filter((e) => !attempts[e.key] || nowMs - attempts[e.key] >= cooldownMs)
    .sort((a, b) => (b.lastTs ?? b.ts ?? 0) - (a.lastTs ?? a.ts ?? 0));
  const toAlert = fresh.filter((e) => ALERT_SEVERITIES.has(e.severity));
  const fixable = fresh.filter((e) => FIXABLE_SEVERITIES.has(e.severity));
  return { toFix: fixable.slice(0, maxPerPoll), overflow: fixable.slice(maxPerPoll), toAlert };
}

/** Loud, self-contained DM for an alert-only event — everything needed to judge it without AWS. */
export function renderAlert(event) {
  const window =
    event.firstTs && event.lastTs && event.lastTs > event.firstTs
      ? `in ${Math.max(1, Math.round((event.lastTs - event.firstTs) / 60_000))} min`
      : "in one alert window";
  return trim(
    `:rotating_light: *FLOOD — ${event.pattern ?? event.severity}* in *${event.service}* (${event.env ?? "unknown"})\n` +
      `*${event.count ?? "?"}×* ${window} — these are NOT errors, so nothing auto-fixes them. Check now.\n` +
      `> ${String(event.sample ?? "").replace(/\s+/g, " ").slice(0, 400)}\n` +
      `Logs: ${event.consoleUrl ?? "n/a"}`,
  );
}

/**
 * One poll of the auto-fix source — the CloudWatch alerter and check-sentry.sh both append to
 * the same event log. Read new events, pick fresh error signatures, spawn a fix worker for up
 * to maxPerPoll of them, and note (but don't fix) the overflow.
 * Fixes run sequentially — the daemon already processes work one at a time.
 */
export async function pollCwalert(config, slack, selfId, nowMs = Date.now()) {
  const cfg = config.cwalert;
  const state = loadCwalertState(cfg.stateFile);

  const { lines, offset, baselined } = readNewEvents(cfg.eventLog, state);
  state.offset = offset;
  if (baselined) {
    saveCwalertState(cfg.stateFile, state);
    log(`cwalert source: first run — baselined at ${offset} bytes, backlog skipped`);
    return;
  }
  if (lines.length === 0) {
    if (offset !== state.offset) saveCwalertState(cfg.stateFile, state);
    return;
  }

  const { toFix, overflow, toAlert } = selectEvents(lines, state.attempts, {
    cooldownMs: cfg.cooldownMs,
    maxPerPoll: cfg.maxPerPoll,
    nowMs,
  });
  if (toFix.length === 0 && overflow.length === 0 && toAlert.length === 0) {
    saveCwalertState(cfg.stateFile, state); // still advance the offset
    return;
  }
  log(`cwalert source: ${toAlert.length} to alert, ${toFix.length} to fix, ${overflow.length} over the per-poll cap`);

  // Mark everything we picked as attempted up front so a crash mid-fix can't re-trigger it.
  for (const e of [...toAlert, ...toFix, ...overflow]) state.attempts[e.key] = nowMs;
  saveCwalertState(cfg.stateFile, state);

  if (config.dryRun) {
    const would = [...toAlert.map((e) => `alert ${e.service}`), ...toFix.map((e) => `fix ${e.service}`)];
    log(`cwalert source: DRY RUN — would ${would.join(", ") || "do nothing"}`);
    return;
  }

  // Alerts first: a flood is in progress right now, and a fix worker below can run for minutes.
  // No per-poll cap here. attempts[] was stamped above, so a capped alert would be silenced for
  // the whole cooldown and only ever mentioned in a log file — the exact "nobody told me"
  // failure this lane exists to fix. Volume is already bounded upstream (the alerter re-alerts a
  // signature at most once per REALERT_HOURS) and downstream (the cooldown).
  for (const event of toAlert) {
    await slack.postToSelf(selfId, renderAlert(event)).catch((err) => log(`cwalert source: alert DM failed for ${event.key}: ${err.message}`));
  }

  for (const event of toFix) {
    try {
      await handleCwalertFix({ event, config, slack, selfId });
    } catch (err) {
      log(`cwalert source: ERROR fixing ${event.key}: ${err.message}`);
      await slack
        .postToSelf(selfId, `:x: Auto-fix worker crashed on an alert in *${event.service}*: ${err.message}\nLogs: ${event.consoleUrl}`)
        .catch(() => {});
    }
  }

  if (overflow.length > 0) {
    await slack
      .postToSelf(
        selfId,
        trim(
          `:information_source: ${overflow.length} more distinct alert(s) this cycle — not auto-fixing (per-poll cap ${cfg.maxPerPoll}, cooldown ${Math.round(cfg.cooldownMs / 3_600_000)}h). Check #monitoring:\n` +
            overflow.map((e) => `• *${e.service}* — ${String(e.sample).replace(/\s+/g, " ").slice(0, 160)}`).join("\n"),
        ),
      )
      .catch(() => {});
  }
}
