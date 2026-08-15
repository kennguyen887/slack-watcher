import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { log } from "./log.js";
import { listRepos } from "./repos.js";

export function git(repoPath, ...args) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Bounded like every other outbound call: a fetch against a dead remote
      // must fail the one task, not wedge the whole poll.
      timeout: 300_000,
    }).trim();
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/**
 * Workers must NEVER run inside the user's working copy — it may hold
 * uncommitted work on another branch. Give them a disposable worktree
 * checked out at the latest origin/<baseBranch> instead.
 */
export function createWorktree(repoPath, repoName, ts, worktreesDir, baseBranch) {
  // "auto-" marks the session as watcher-spawned in the Claude desktop app's
  // session list: imported CLI sessions have no title (the app exposes no way
  // to set one from outside), so the list shows this directory name instead.
  const worktreePath = path.join(worktreesDir, `auto-${repoName}-${ts.replace(".", "-")}`);
  // Pull the latest for ALL branches (+prune deleted remotes) so the fix always starts from
  // the CURRENT tip of the base branch (RC/master). We check the worktree out DETACHED at
  // origin/<base> — never a local branch — so a stale local RC/master can't leak in.
  git(repoPath, "fetch", "--all", "--prune");
  let tip;
  try {
    tip = git(repoPath, "rev-parse", "--short", `origin/${baseBranch}`);
  } catch {
    throw new Error(
      `base branch origin/${baseBranch} not found in ${repoName} after fetch — check BASE_BRANCH / the repo's default branch`,
    );
  }
  git(repoPath, "worktree", "add", "--detach", worktreePath, `origin/${baseBranch}`);
  let subject = "";
  try {
    subject = git(repoPath, "log", "-1", "--format=%s", `origin/${baseBranch}`);
  } catch {
    // best-effort log detail only
  }
  log(`[${repoName}] worktree at latest origin/${baseBranch} @ ${tip}${subject ? ` — ${subject.slice(0, 72)}` : ""}`);
  return worktreePath;
}

/**
 * GitHub owners of the repos already cloned under REPOS_ROOT, from their origin remotes.
 * Auto-cloning is limited to these: a PR link for some stranger's repo pasted in Slack must
 * never make the daemon clone it. Self-maintaining — no allowlist to keep updated.
 */
export function clonedRepoOwners(reposRoot) {
  const owners = new Set();
  for (const name of listRepos(reposRoot)) {
    try {
      const url = git(path.join(reposRoot, name), "remote", "get-url", "origin");
      const owner = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/)?.[1];
      if (owner) owners.add(owner);
    } catch {
      // a checkout without an origin tells us nothing about ownership
    }
  }
  return owners;
}

/**
 * Local checkout for owner/repo, cloning it on demand. The team creates repos all the time, and
 * requiring a manual clone per repo meant a review request for a brand-new one failed silently.
 * @returns {{ repoPath: string, cloned: boolean }}
 * @throws when the repo may not be cloned, or a non-git folder already occupies the path
 */
export function ensureRepo({ reposRoot, repo, owner, timeoutMs = 300_000 }) {
  const repoPath = path.join(reposRoot, repo);
  if (fs.existsSync(path.join(repoPath, ".git"))) return { repoPath, cloned: false };
  // A stale non-git copy (an unpacked download, a checkout that lost its .git) would make the
  // clone fail with a confusing "directory not empty" — name the real problem instead.
  if (fs.existsSync(repoPath)) {
    throw new Error(`${repoPath} exists but is not a git checkout — remove it, or clone the repo there yourself`);
  }
  const owners = clonedRepoOwners(reposRoot);
  const resolvedOwner = owner || (owners.size === 1 ? [...owners][0] : null);
  if (!resolvedOwner) {
    throw new Error(`cannot tell which GitHub owner \`${repo}\` belongs to (cloned repos span ${owners.size} owners)`);
  }
  if (!owners.has(resolvedOwner)) {
    throw new Error(`refusing to clone ${resolvedOwner}/${repo} — no repo from that owner is cloned under REPOS_ROOT`);
  }
  log(`[${repo}] not cloned yet — cloning ${resolvedOwner}/${repo}...`);
  try {
    execFileSync("gh", ["repo", "clone", `${resolvedOwner}/${repo}`, repoPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (err) {
    throw new Error(`gh repo clone ${resolvedOwner}/${repo} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
  log(`[${repo}] cloned into ${repoPath}`);
  return { repoPath, cloned: true };
}

export function removeWorktree(repoPath, worktreePath) {
  // Fire-and-forget: deleting a worktree's node_modules takes minutes and must
  // never delay result reporting. Only used when a run is cancelled — finished
  // runs KEEP their worktree so the session can be resumed; pruneWorktrees
  // reaps those (and crash leftovers) later.
  try {
    spawn("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // never mask the worker result
  }
}

/**
 * Reap kept worktrees older than maxAgeDays (age = last write, so a worktree
 * the user is still working in keeps renewing itself). Runs on watcher startup.
 * Touches ONLY directories that are linked git worktrees (a `.git` FILE);
 * anything else found under worktreesDir is left alone.
 * @returns {number} how many were removed
 */
export function pruneWorktrees(worktreesDir, maxAgeDays) {
  if (!fs.existsSync(worktreesDir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let pruned = 0;
  for (const name of fs.readdirSync(worktreesDir)) {
    const wt = path.join(worktreesDir, name);
    let isStaleWorktree;
    try {
      isStaleWorktree =
        fs.statSync(wt).isDirectory() &&
        fs.statSync(wt).mtimeMs <= cutoff &&
        fs.existsSync(path.join(wt, ".git")) &&
        fs.statSync(path.join(wt, ".git")).isFile();
    } catch {
      continue; // vanished mid-scan
    }
    if (!isStaleWorktree) continue;
    try {
      // The worktree's .git file points back at the main repo — remove through
      // it so git's worktree bookkeeping stays consistent.
      const commonDir = git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
      git(path.dirname(commonDir), "worktree", "remove", "--force", wt);
    } catch {
      // main repo gone or git refused — the directory itself still has to go
      fs.rmSync(wt, { recursive: true, force: true });
    }
    pruned += 1;
    log(`pruned stale worktree ${name} (>${maxAgeDays}d old)`);
  }
  return pruned;
}
