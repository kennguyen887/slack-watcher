import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBHOOK_URL_RE } from "./slack.js";

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce((acc, line) => {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      acc[key] = value;
      return acc;
    }, {});
}

function parseJsonEnv(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function intOption(raw, fallback, { min, max } = {}) {
  const value = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) return fallback;
  const floored = min !== undefined ? Math.max(min, value) : value;
  return max !== undefined ? Math.min(max, floored) : floored;
}

export function loadConfig() {
  const fileEnv = parseEnvFile(path.join(BASE_DIR, ".env"));
  const env = { ...fileEnv, ...process.env };

  const config = {
    slackToken: env.SLACK_USER_TOKEN || "",
    pollIntervalSeconds: intOption(env.POLL_INTERVAL_SECONDS, 45, { min: 30 }),
    reposRoot: path.resolve(env.REPOS_ROOT || path.join(BASE_DIR, "..", "..")),
    searchQueryOverride: env.SLACK_SEARCH_QUERY || "",
    prSearchQuery: env.PR_SEARCH_QUERY || "",
    baseBranch: env.BASE_BRANCH || "main",
    // channel → incoming-webhook URL, as JSON. A listed channel is posted to through its
    // webhook (as the webhook's app) instead of as you; everything else is unchanged.
    slackWebhooks: parseJsonEnv(env.SLACK_WEBHOOKS),
    // send.js target allowlist; empty means every target is allowed.
    sendAllowedTargets: (env.SEND_ALLOWED_TARGETS || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    docsContextDir: env.DOCS_CONTEXT_DIR || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    classifierModel: env.CLASSIFIER_MODEL || "haiku",
    workerModel: env.WORKER_MODEL || "sonnet",
    reviewModel: env.REVIEW_MODEL || "opus",
    workerClaudeArgs: (env.WORKER_CLAUDE_ARGS ?? "--dangerously-skip-permissions")
      .split(" ")
      .filter(Boolean),
    // ── Open Code Review (github.com/alibaba/open-code-review) ──
    // `ocr delegate` picks the PR's reviewable files and resolves a checklist per file; the
    // review itself still runs on REVIEW_MODEL. Off switch only — a missing `ocr` already
    // degrades to the plain diff review on its own (see src/ocr.js).
    ocrEnabled: env.OCR_ENABLED !== "0" && env.OCR_ENABLED !== "false",
    ocrBin: env.OCR_BIN || "ocr",
    ocrRuleFile: env.OCR_RULE_FILE || path.join(BASE_DIR, "ocr", "rule.json"),
    contextWindowSeconds: intOption(env.CONTEXT_WINDOW_SECONDS, 900, { min: 0 }),
    workerTimeoutMs: intOption(env.WORKER_TIMEOUT_MINUTES, 45, { min: 1 }) * 60_000,
    workerGraceMs: intOption(env.WORKER_GRACE_MINUTES, 3, { min: 0 }) * 60_000,
    reviewTimeoutMs: intOption(env.REVIEW_TIMEOUT_MINUTES, 30, { min: 1 }) * 60_000,
    // ── answering teammates' questions ──
    // OFF by default: this is the one handler that says something substantive in PUBLIC under
    // your name, and Slack has no delete — opting in has to be deliberate.
    questionAutoReply: env.QUESTION_AUTO_REPLY === "1" || env.QUESTION_AUTO_REPLY === "true",
    answerModel: env.ANSWER_MODEL || env.REVIEW_MODEL || "opus",
    answerTimeoutMs: intOption(env.ANSWER_TIMEOUT_MINUTES, 10, { min: 1 }) * 60_000,
    // A chat answer that runs long is a sign the worker wrote an essay instead of a reply;
    // over the cap it becomes a private draft rather than a wall of text in the channel.
    answerMaxChars: intOption(env.ANSWER_MAX_CHARS, 600, { min: 80, max: 3000 }),
    // How many PRs from ONE multi-PR review message to review at once. The git worktree
    // setup is serialized regardless; this caps the concurrent claude review workers.
    reviewConcurrency: intOption(env.REVIEW_CONCURRENCY, 3, { min: 1, max: 6 }),
    // Finished workers leave their worktree behind so the session can be resumed;
    // pruneWorktrees reaps them on startup once their PR is merged/closed, once older than this,
    // OR once a newer review pushes them past the cap. The cap is the one that bounds disk — retention by age
    // alone grows with review volume, which is what filled this disk once already.
    // A mention whose processing throws is retried on later polls instead of being
    // swallowed; this bounds that, so a permanently poisoned one cannot loop forever.
    mentionMaxAttempts: intOption(env.MENTION_MAX_ATTEMPTS, 5, { min: 1 }),
    worktreeKeepDays: intOption(env.WORKTREE_KEEP_DAYS, 1, { min: 1 }),
    worktreeKeepMax: intOption(env.WORKTREE_KEEP_MAX, 6, { min: 1 }),
    dryRun: env.DRY_RUN === "1" || env.DRY_RUN === "true",
    // ── CloudWatch error → auto-fix source (off unless CWALERT_ENABLED) ──
    cwalert: {
      enabled: env.CWALERT_ENABLED === "1" || env.CWALERT_ENABLED === "true",
      eventLog: env.CWALERT_EVENT_LOG || path.join(BASE_DIR, "events", "cwalert.jsonl"),
      baseBranch: env.CWALERT_BASE_BRANCH || env.BASE_BRANCH || "main",
      draft: env.CWALERT_DRAFT === "1" || env.CWALERT_DRAFT === "true",
      cooldownMs: intOption(env.CWALERT_COOLDOWN_HOURS, 12, { min: 0 }) * 3_600_000,
      maxPerPoll: intOption(env.CWALERT_MAX_PER_POLL, 2, { min: 1 }),
      // service (from the alerter) → repo folder under REPOS_ROOT. Fallback strips a
      // trailing " (...)" suffix, e.g. "listings-api (rc scheduler)" → "listings-api".
      serviceRepos: parseJsonEnv(env.CWALERT_SERVICE_REPOS),
      stateFile: path.join(BASE_DIR, "cwalert-state.json"),
      // ── auto-merge (RC only) ──
      // A fix for a service that is DOWN on RC may merge itself; prod never does. Every gate
      // below must hold — see autoMergeDecision() in handlers/cwalert-fix.js.
      autoMerge: env.CWALERT_AUTOMERGE === "1" || env.CWALERT_AUTOMERGE === "true",
      autoMergeEnvs: (env.CWALERT_AUTOMERGE_ENVS || "rc").split(",").map((s) => s.trim()).filter(Boolean),
      autoMergeMinConfidence: intOption(env.CWALERT_AUTOMERGE_MIN_CONFIDENCE, 9, { min: 1, max: 10 }),
      autoMergeMaxFiles: intOption(env.CWALERT_AUTOMERGE_MAX_FILES, 5, { min: 1 }),
      autoMergeMaxLines: intOption(env.CWALERT_AUTOMERGE_MAX_LINES, 200, { min: 1 }),
      autoMergeChecksTimeoutMs: intOption(env.CWALERT_AUTOMERGE_CHECKS_TIMEOUT_MIN, 10, { min: 1 }) * 60_000,
    },
    dailyReport: {
      enabled: env.DAILY_REPORT_ENABLED === "1" || env.DAILY_REPORT_ENABLED === "true",
      channel: env.DAILY_REPORT_CHANNEL || "",
      // Post time = thread open + uniform(min..max) minutes: never a fixed minute.
      minMinutes: intOption(env.DAILY_REPORT_MIN_MINUTES, 10, { min: 0 }),
      maxMinutes: intOption(env.DAILY_REPORT_MAX_MINUTES, 120, { min: 1 }),
      // Local-time hours [from, to) in which the job may act (Mon–Fri only).
      window: (env.DAILY_REPORT_WINDOW || "14-21").split("-").map((n) => Number.parseInt(n, 10)),
    },
    worktreesDir: path.join(BASE_DIR, "worktrees"),
    // Where every worker session STARTS (its worktree comes in via --add-dir). One folder = one
    // sidebar group in the Claude desktop app. Must sit outside any git repo, so a command run
    // before the worker's `cd` fails loudly instead of touching another checkout.
    workerSessionsDir: path.resolve(env.WORKER_SESSIONS_DIR || path.join(BASE_DIR, "..", "slack-bot")),
    attachmentsDir: path.join(BASE_DIR, "attachments"),
    stateFile: path.join(BASE_DIR, "state.json"),
    historyFile: path.join(BASE_DIR, "history.jsonl"),
    logDir: path.join(BASE_DIR, "logs"),
  };

  const errors = [];
  if (!config.slackToken) {
    errors.push("SLACK_USER_TOKEN is required (set it in slack-watcher/.env)");
  } else if (!config.slackToken.startsWith("xoxp-")) {
    errors.push("SLACK_USER_TOKEN must be a user token (xoxp-...) — bot tokens cannot use search.messages");
  }
  // A typo here must not fall back to posting as you: that is the one outcome this
  // setting exists to prevent, and it would be invisible until someone reads the channel.
  if (env.SLACK_WEBHOOKS && Object.keys(config.slackWebhooks).length === 0) {
    errors.push("SLACK_WEBHOOKS is set but is not a JSON object of {\"#channel\": \"https://hooks.slack.com/...\"}");
  }
  for (const [channel, url] of Object.entries(config.slackWebhooks)) {
    if (typeof url !== "string" || !WEBHOOK_URL_RE.test(url)) {
      errors.push(`SLACK_WEBHOOKS["${channel}"] must be an https://hooks.slack.com/... URL`);
    }
    // A webhook is bound to a channel and cannot reach a DM. Keyed by a DM target it would
    // silently divert that DM into the webhook's channel — a wrong-channel send, in public.
    if (/^[@UD]/.test(channel)) {
      errors.push(`SLACK_WEBHOOKS["${channel}"] looks like a DM target — webhooks post to a channel only`);
    }
  }
  if (!fs.existsSync(config.reposRoot)) {
    errors.push(`REPOS_ROOT does not exist: ${config.reposRoot}`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }

  return config;
}
