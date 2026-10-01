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
function gh(args, timeoutMs = 60_000, cwd = undefined) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).trim();
}

/**
 * Check a PR out inside `cwd` and return the branch it targets.
 *
 * The worker does this itself as its first step; doing it here too is what lets the deterministic
 * half of the review run BEFORE the worker starts — `ocr delegate` needs the PR's head and its
 * base ref present to resolve the merge-base range. `gh pr checkout` is idempotent, so the
 * worker repeating it costs nothing.
 * @returns {string} the PR's base branch (e.g. "rc")
 */
export function checkoutPr(pr, cwd) {
  const base = JSON.parse(gh(["pr", "view", pr.url, "--json", "baseRefName"])).baseRefName;
  gh(["pr", "checkout", String(pr.number)], 180_000, cwd);
  // The base ref itself may be absent in a worktree created from a different branch.
  execFileSync("git", ["-C", cwd, "fetch", "origin", base], { stdio: "ignore", timeout: 180_000 });
  return base;
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
    // CheckRun carries `name`, a legacy StatusContext carries `context`.
    failedChecks: runs.filter((r) => concluded(r) && !ok(r)).map((r) => r.name ?? r.context ?? "?"),
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

/** My GitHub login (gh's own auth), resolved once per process. */
let cachedLogin = null;
function myLogin() {
  if (!cachedLogin) cachedLogin = gh(["api", "user", "--jq", ".login"]);
  return cachedLogin;
}

/**
 * What I have ACTUALLY landed on a PR — my reviews and my inline comments, straight from GitHub.
 *
 * A worker reports what it believes it did, and a review it wrote about but never submitted reads
 * exactly like one it posted (commonground#2306: "no bugs found — approved", REVIEW_COMMENTS: 0,
 * zero reviews on the PR). Every public claim is reconciled against this before the team hears it.
 *
 * `since` (ISO) counts only comments posted after it, so a follow-up round sees its NEW comments
 * rather than the ones its first review left behind.
 */
export function myReviewState(pr, { since = null } = {}) {
  const me = myLogin();
  const view = JSON.parse(gh(["pr", "view", pr.url, "--json", "state,reviews"]));
  const mine = (view.reviews ?? []).filter((r) => r.author?.login === me);
  const inline = JSON.parse(gh(["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, "--paginate"]));
  return {
    login: me,
    state: view.state,
    approved: mine.at(-1)?.state === "APPROVED",
    comments: inline.filter((c) => c.user?.login === me && (!since || c.created_at > since)).length,
  };
}

/** Submit the approving review. Kept in code — a worker can report an approve it never ran. */
export function approvePr(pr, body = "LGTM!") {
  try {
    gh(["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, "-f", "event=APPROVE", "-f", `body=${body}`]);
  } catch (err) {
    throw new Error(err.stderr?.toString().trim() || err.message);
  }
}
