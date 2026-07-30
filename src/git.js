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
  const worktreePath = path.join(worktreesDir, `${repoName}-${ts.replace(".", "-")}`);
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
  // never delay result reporting. Leftovers from a crash are cleaned manually
  // (`git worktree list` + `git worktree remove --force`).
  try {
    spawn("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // never mask the worker result
  }
}
