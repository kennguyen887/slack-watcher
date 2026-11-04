import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    docsContextDir: env.DOCS_CONTEXT_DIR || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    classifierModel: env.CLASSIFIER_MODEL || "haiku",
    // Prefer Fable for the heavy workers/review; fall back to Opus when Fable is
    // restricted on the account (see runClaude's fallback in claude.js).
    workerModel: env.WORKER_MODEL || "claude-fable-5",
    workerFallbackModel: env.WORKER_FALLBACK_MODEL || "claude-opus-4-8",
    reviewModel: env.REVIEW_MODEL || "claude-fable-5",
    reviewFallbackModel: env.REVIEW_FALLBACK_MODEL || "claude-opus-4-8",
    // Hunt list injected into every review prompt. A markdown file so the team can tune
    // what the reviewer looks for without touching code. Point it at a shared docs repo
    // to share one list across machines.
    reviewChecklistFile: path.resolve(BASE_DIR, env.REVIEW_CHECKLIST_FILE || "docs/review-checklist.md"),
    workerClaudeArgs: (env.WORKER_CLAUDE_ARGS ?? "--dangerously-skip-permissions")
      .split(" ")
      .filter(Boolean),
    contextWindowSeconds: intOption(env.CONTEXT_WINDOW_SECONDS, 900, { min: 0 }),
    workerTimeoutMs: intOption(env.WORKER_TIMEOUT_MINUTES, 45, { min: 1 }) * 60_000,
    workerGraceMs: intOption(env.WORKER_GRACE_MINUTES, 3, { min: 0 }) * 60_000,
    // 45 min: a review that reads every changed file (and fans out on a big PR) needs
    // more than the 30 min a single skim took.
    reviewTimeoutMs: intOption(env.REVIEW_TIMEOUT_MINUTES, 45, { min: 1 }) * 60_000,
    answerTimeoutMs: intOption(env.ANSWER_TIMEOUT_MINUTES, 10, { min: 1 }) * 60_000,
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
    worktreesDir: path.join(BASE_DIR, "worktrees"),
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
  if (!fs.existsSync(config.reposRoot)) {
    errors.push(`REPOS_ROOT does not exist: ${config.reposRoot}`);
  }
  // Fail loud: without the hunt list the reviewer silently falls back to a plausibility
  // skim, which is exactly the 0-comment failure this file exists to prevent.
  if (!fs.existsSync(config.reviewChecklistFile)) {
    errors.push(`REVIEW_CHECKLIST_FILE does not exist: ${config.reviewChecklistFile}`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }

  return config;
}
