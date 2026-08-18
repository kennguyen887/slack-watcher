import { execFileSync } from "node:child_process";

export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/** First GitHub PR link in a text blob (Slack-wrapped <url|label> included), or null. */
export function parsePrUrl(text) {
  const m = (text ?? "").match(PR_URL_RE);
  return m ? { url: m[0], owner: m[1], repo: m[2], number: m[3] } : null;
}

/**
 * EVERY distinct GitHub PR link in a text blob, in first-seen order. One Slack message often
 * lists several PRs to review ("PRs for review: <a> <b> <c>"); reviewing only the first drops the
 * rest silently. Deduped by url so a link repeated in message + context is reviewed once.
 */
export function parseAllPrUrls(text) {
  const re = new RegExp(PR_URL_RE, "g");
  const seen = new Set();
  const prs = [];
  for (const m of (text ?? "").matchAll(re)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    prs.push({ url: m[0], owner: m[1], repo: m[2], number: m[3] });
  }
  return prs;
}

/** Run gh with an explicit timeout — an unbounded CLI call would stall the daemon's poll loop. */
function gh(args, timeoutMs = 60_000) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).trim();
}

const PR_FIELDS = "state,isDraft,mergeable,mergeStateStatus,changedFiles,additions,deletions,statusCheckRollup";

/**
 * Merge-readiness snapshot of a PR, straight from GitHub (never from the worker's own claims).
 * `checks` collapses the rollup: "none" when the repo runs no checks on PRs, "pending" while any
 * is still running, "failed" if any concluded badly, "green" only when all concluded successfully.
 */
export function prStatus(prUrl) {
  const pr = JSON.parse(gh(["pr", "view", prUrl, "--json", PR_FIELDS]));
  const runs = pr.statusCheckRollup ?? [];
  const concluded = (r) => r.status === "COMPLETED" || r.state != null;
  const ok = (r) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(r.conclusion ?? r.state);
  let checks = "green";
  if (runs.length === 0) checks = "none";
  else if (runs.some((r) => !concluded(r))) checks = "pending";
  else if (runs.some((r) => !ok(r))) checks = "failed";
  return {
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    changedFiles: pr.changedFiles ?? 0,
    changedLines: (pr.additions ?? 0) + (pr.deletions ?? 0),
    checks,
  };
}

/**
 * Poll until the PR's checks stop being pending, bounded by timeoutMs. Returns the final status.
 * A repo with no checks (checks: "none") returns immediately — there is nothing to wait for.
 */
export async function waitForChecks(prUrl, { timeoutMs = 10 * 60_000, pollMs = 30_000, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let status = prStatus(prUrl);
  while (status.checks === "pending" && Date.now() < deadline) {
    await wait(pollMs);
    status = prStatus(prUrl);
  }
  return status;
}

/** Squash-merge a PR. Throws with gh's stderr when GitHub refuses (protection, conflict, …). */
export function mergePr(prUrl) {
  try {
    gh(["pr", "merge", prUrl, "--squash", "--delete-branch"], 120_000);
  } catch (err) {
    throw new Error(err.stderr?.toString().trim() || err.message);
  }
  return JSON.parse(gh(["pr", "view", prUrl, "--json", "mergeCommit"])).mergeCommit?.oid ?? "";
}
