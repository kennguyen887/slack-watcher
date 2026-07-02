import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { log } from "./log.js";

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
