import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { log } from "./log.js";
import { listRepos } from "./repos.js";
import { worktreePrState } from "./github.js";

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
 *
 * Not every repo has the configured integration branch (mapping/docs/tool repos
 * ship straight from main), so a missing origin/<baseBranch> falls back to the
 * repo's own default branch instead of failing the whole task.
 * @returns {{ worktreePath: string, base: string }} base = the branch actually checked out
 */
export function createWorktree(repoPath, repoName, ts, worktreesDir, baseBranch) {
  // "auto-" marks the directory as watcher-spawned (git worktree list, the DM's resume hint,
  // and the Claude desktop app, which groups sessions by their folder). The session's own
  // title comes from `claude --name` (runClaude), not from this name.
  const worktreePath = path.join(worktreesDir, `auto-${repoName}-${ts.replace(".", "-")}`);
  // Pull the latest for ALL branches (+prune deleted remotes) so the fix always starts from
  // the CURRENT tip of the base branch (RC/master). We check the worktree out DETACHED at
  // origin/<base> — never a local branch — so a stale local RC/master can't leak in.
  git(repoPath, "fetch", "--all", "--prune");
  let base = baseBranch;
  if (!branchExists(repoPath, baseBranch)) {
    const fallback = defaultBranch(repoPath);
    if (!fallback) {
      throw new Error(
        `base branch origin/${baseBranch} not found in ${repoName} after fetch, and its default branch could not be resolved — check BASE_BRANCH / the repo's origin`,
      );
    }
    base = fallback;
    log(`[${repoName}] no origin/${baseBranch} — falling back to the repo's default branch origin/${base}`);
  }
  const tip = git(repoPath, "rev-parse", "--short", `origin/${base}`);
  // A retry of a run that died mid-way (crash, reboot) lands on the same path. Clear the
  // leftover, or `worktree add` fails on "already exists" and burns every retry attempt.
  if (fs.existsSync(worktreePath)) {
    log(`[${repoName}] replacing leftover worktree ${path.basename(worktreePath)}`);
    discardWorktree(worktreePath);
  }
  git(repoPath, "worktree", "prune");
  git(repoPath, "worktree", "add", "--detach", worktreePath, `origin/${base}`);
  let subject = "";
  try {
    subject = git(repoPath, "log", "-1", "--format=%s", `origin/${base}`);
  } catch {
    // best-effort log detail only
  }
  log(`[${repoName}] worktree at latest origin/${base} @ ${tip}${subject ? ` — ${subject.slice(0, 72)}` : ""}`);
  return { worktreePath, base };
}

function branchExists(repoPath, branch) {
  try {
    git(repoPath, "rev-parse", "--verify", "--quiet", `origin/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repo's default branch, read from the origin/HEAD symref. A checkout can lack the
 * symref (older clones, manual remotes) — one `remote set-head --auto` refresh fixes that;
 * the network is known good here because createWorktree just fetched.
 * @returns {string|null}
 */
function defaultBranch(repoPath) {
  for (const attempt of [1, 2]) {
    try {
      const ref = git(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD");
      const name = ref.replace(/^refs\/remotes\/origin\//, "");
      if (name && name !== ref && branchExists(repoPath, name)) return name;
    } catch {
      // symref unset — refresh below
    }
    if (attempt === 1) {
      try {
        git(repoPath, "remote", "set-head", "origin", "--auto");
      } catch {
        return null;
      }
    }
  }
  return null;
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

function prDoneReason(state) {
  return state === "MERGED" || state === "CLOSED" ? `PR ${state.toLowerCase()}` : null;
}

/** Remove a linked worktree through its main repo so git's own bookkeeping stays consistent. */
function discardWorktree(worktreePath) {
  try {
    const commonDir = git(worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    git(path.dirname(commonDir), "worktree", "remove", "--force", worktreePath);
  } catch {
    // main repo gone or git refused — the directory itself still has to go
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Reap kept worktrees: everything past the newest `maxKept`, anything older than maxAgeDays,
 * and any whose PR is merged or closed — nothing is left to resume once the PR is done, so
 * there is no reason to hold its checkout (and node_modules) until the age/cap rules catch up. The count cap is what actually bounds disk — age alone does not, because
 * retention scales with review volume (a busy day is ~10 checkouts, and one that installed
 * node_modules is GBs), so a few days of reviews fills the disk well inside the age window.
 * Age = last write, so a worktree the user is still working in keeps renewing itself.
 * Touches ONLY directories that are linked git worktrees (a `.git` FILE);
 * anything else found under worktreesDir is left alone.
 * @returns {number} how many were removed
 */
export function pruneWorktrees(worktreesDir, maxAgeDays, maxKept, prState = worktreePrState) {
  if (!fs.existsSync(worktreesDir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;

  const worktrees = fs
    .readdirSync(worktreesDir)
    .map((name) => {
      const wt = path.join(worktreesDir, name);
      try {
        if (!fs.statSync(wt).isDirectory()) return null;
        if (!fs.statSync(path.join(wt, ".git")).isFile()) return null;
        return { name, path: wt, mtimeMs: fs.statSync(wt).mtimeMs };
      } catch {
        return null; // a foreign dir, a plain file, or it vanished mid-scan
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first — the tail is what goes

  let pruned = 0;
  for (const [i, wt] of worktrees.entries()) {
    const reason = i >= maxKept ? `beyond the newest ${maxKept}` : wt.mtimeMs <= cutoff ? `>${maxAgeDays}d old` : prDoneReason(prState(wt.path));
    if (!reason) continue;
    discardWorktree(wt.path);
    pruned += 1;
    log(`pruned worktree ${wt.name} (${reason})`);
  }
  return pruned;
}
