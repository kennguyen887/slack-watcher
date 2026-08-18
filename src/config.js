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
    workerModel: env.WORKER_MODEL || "sonnet",
    reviewModel: env.REVIEW_MODEL || "opus",
    workerClaudeArgs: (env.WORKER_CLAUDE_ARGS ?? "--dangerously-skip-permissions")
      .split(" ")
      .filter(Boolean),
    contextWindowSeconds: intOption(env.CONTEXT_WINDOW_SECONDS, 900, { min: 0 }),
    workerTimeoutMs: intOption(env.WORKER_TIMEOUT_MINUTES, 45, { min: 1 }) * 60_000,
    workerGraceMs: intOption(env.WORKER_GRACE_MINUTES, 3, { min: 0 }) * 60_000,
    reviewTimeoutMs: intOption(env.REVIEW_TIMEOUT_MINUTES, 30, { min: 1 }) * 60_000,
    // How many PRs from ONE multi-PR review message to review at once. The git worktree
    // setup is serialized regardless; this caps the concurrent claude review workers.
    reviewConcurrency: intOption(env.REVIEW_CONCURRENCY, 3, { min: 1, max: 6 }),
    // Finished workers leave their worktree behind so the session can be resumed;
    // pruneWorktrees reaps them on startup once older than this.
    worktreeKeepDays: intOption(env.WORKTREE_KEEP_DAYS, 3, { min: 1 }),
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
  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }

  return config;
}
