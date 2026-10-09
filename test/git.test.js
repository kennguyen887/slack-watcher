// Integration test for createWorktree: proves a fix always starts from the LATEST origin/<base>
// tip. No HTTP layer exists here, so the git binary + filesystem IS the outermost boundary.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { clonedRepoOwners, createWorktree, ensureRepo, pruneWorktrees } from "../src/git.js";

const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A bare "origin" with one clone that can push to it, on branch <base>. */
function makeRemoteAndClone(base) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitwt-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", base, origin]);
  execFileSync("git", ["clone", origin, work]);
  g(work, "config", "user.email", "t@t.dev");
  g(work, "config", "user.name", "T");
  return { root, origin, work };
}

test("createWorktree checks out the latest origin/<base>, picking up new commits after fetch", () => {
  const base = "rc";
  const { root, work } = makeRemoteAndClone(base);
  const worktreesDir = path.join(root, "worktrees");

  fs.writeFileSync(path.join(work, "app.txt"), "v1");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", base);

  const { worktreePath: wt1, base: base1 } = createWorktree(work, "repo", "1.0", worktreesDir, base);
  assert.equal(base1, base);
  assert.equal(fs.readFileSync(path.join(wt1, "app.txt"), "utf8"), "v1");

  // A NEW commit lands on origin/rc after the first worktree was made.
  fs.writeFileSync(path.join(work, "app.txt"), "v2");
  g(work, "commit", "-am", "c2"); g(work, "push", "origin", base);

  // A fresh worktree must reflect the newest tip — this is the "fix on latest source" guarantee.
  const { worktreePath: wt2 } = createWorktree(work, "repo", "2.0", worktreesDir, base);
  assert.equal(fs.readFileSync(path.join(wt2, "app.txt"), "utf8"), "v2");
  assert.equal(g(wt2, "rev-parse", "HEAD"), g(work, "rev-parse", `origin/${base}`));
});

// A PR-review request for a repo that ships from main must not die on BASE_BRANCH=rc —
// this exact failure silently dropped a commonground-mapping review (2026-08-25).
test("createWorktree falls back to the repo's default branch when the configured base is missing", () => {
  const { root, work } = makeRemoteAndClone("main");
  fs.writeFileSync(path.join(work, "f"), "x");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", "main");

  const { worktreePath, base } = createWorktree(work, "repo", "1.0", path.join(root, "wt"), "rc");
  assert.equal(base, "main");
  assert.equal(g(worktreePath, "rev-parse", "HEAD"), g(work, "rev-parse", "origin/main"));
});

test("createWorktree still throws a clear error when no base can be resolved at all", () => {
  const { root, origin, work } = makeRemoteAndClone("main");
  fs.writeFileSync(path.join(work, "f"), "x");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", "main");
  // Point the remote's HEAD at a branch that doesn't exist and drop the local symref:
  // now neither origin/<base> nor a default branch is resolvable.
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/gone"]);
  g(work, "remote", "set-head", "origin", "--delete");
  assert.throws(
    () => createWorktree(work, "repo", "1.0", path.join(root, "wt"), "does-not-exist"),
    /base branch origin\/does-not-exist not found/,
  );
});

// Worktrees are kept after a run so the worker's session stays resumable; the startup prune
// must reap ONLY stale worktrees — deleting a fresh one kills a session the user may be in,
// and deleting a non-worktree directory would be plain data loss.
test("pruneWorktrees removes only old linked worktrees, never fresh ones or foreign dirs", () => {
  const base = "rc";
  const { root, work } = makeRemoteAndClone(base);
  const worktreesDir = path.join(root, "worktrees");
  fs.writeFileSync(path.join(work, "app.txt"), "v1");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", base);

  const { worktreePath: oldWt } = createWorktree(work, "repo", "1.0", worktreesDir, base);
  const { worktreePath: freshWt } = createWorktree(work, "repo", "2.0", worktreesDir, base);
  const foreign = path.join(worktreesDir, "not-a-worktree");
  fs.mkdirSync(foreign);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  fs.utimesSync(oldWt, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(foreign, tenDaysAgo, tenDaysAgo);

  assert.equal(pruneWorktrees(worktreesDir, 3, 10, () => "OPEN"), 1);
  assert.equal(fs.existsSync(oldWt), false, "stale worktree should be pruned");
  assert.equal(fs.existsSync(freshWt), true, "fresh worktree must survive");
  assert.equal(fs.existsSync(foreign), true, "non-worktree dirs must never be touched");
  // git's own bookkeeping no longer lists the pruned tree
  assert.doesNotMatch(g(work, "worktree", "list"), /auto-repo-1-0/);
});

// Age alone cannot bound disk: reviews run ~10x a day and a checkout whose worker installed
// node_modules is GBs, so a few days inside the age window filled this disk once already.
// The count cap is the real ceiling — it must reap the oldest even when nothing is stale yet.
test("pruneWorktrees caps kept worktrees at the newest N even when none are stale", () => {
  const base = "rc";
  const { root, work } = makeRemoteAndClone(base);
  const worktreesDir = path.join(root, "worktrees");
  fs.writeFileSync(path.join(work, "app.txt"), "v1");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", base);

  // Three fresh worktrees, minutes apart so "newest" is unambiguous.
  const wts = ["1.0", "2.0", "3.0"].map((ts, i) => {
    const { worktreePath } = createWorktree(work, "repo", ts, worktreesDir, base);
    const when = new Date(Date.now() - (3 - i) * 60_000);
    fs.utimesSync(worktreePath, when, when);
    return worktreePath;
  });

  assert.equal(pruneWorktrees(worktreesDir, 30, 2, () => "OPEN"), 1);
  assert.equal(fs.existsSync(wts[0]), false, "the oldest is over the cap and must go");
  assert.equal(fs.existsSync(wts[1]), true, "the newest N must survive the cap");
  assert.equal(fs.existsSync(wts[2]), true, "the newest N must survive the cap");
  assert.doesNotMatch(g(work, "worktree", "list"), /auto-repo-1-0/);
});

// A finished PR leaves nothing to resume, so its checkout must not sit on disk until the age/cap
// rules catch up — but a PR still open, or one GitHub cannot report on, keeps its worktree.
test("pruneWorktrees removes a worktree as soon as its PR is merged or closed", () => {
  const base = "rc";
  const { root, work } = makeRemoteAndClone(base);
  const worktreesDir = path.join(root, "worktrees");
  fs.writeFileSync(path.join(work, "app.txt"), "v1");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", base);

  const states = { "pr1": "MERGED", "pr2": "CLOSED", "pr3": "OPEN", "pr4": null };
  const wts = Object.keys(states).map((suffix) => createWorktree(work, "repo", `1.0-${suffix}`, worktreesDir, base).worktreePath);
  const prState = (wt) => states[wt.match(/pr\d+$/)[0]];

  assert.equal(pruneWorktrees(worktreesDir, 30, 10, prState), 2);
  assert.deepEqual(wts.map((wt) => fs.existsSync(wt)), [false, false, true, true]);
});

// ensureRepo clones a repo the team just created, so a review/fix request for it stops failing
// silently. The guard that matters: it must never clone an owner we don't already work with.
test("ensureRepo returns an existing checkout, and refuses to clone an unknown owner", () => {
  const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repos-"));
  const { work } = makeRemoteAndClone("main");
  const cloned = path.join(reposRoot, "known-repo");
  fs.cpSync(work, cloned, { recursive: true });
  g(cloned, "remote", "set-url", "origin", "git@github.com:Acme-Org/known-repo.git");

  // already cloned → no network, same path back
  assert.deepEqual(ensureRepo({ reposRoot, repo: "known-repo", owner: "Acme-Org" }), { repoPath: cloned, cloned: false });
  assert.deepEqual([...clonedRepoOwners(reposRoot)], ["Acme-Org"]);

  // a stranger's repo is never cloned, however the link got into Slack
  assert.throws(() => ensureRepo({ reposRoot, repo: "evil", owner: "Someone-Else" }), /refusing to clone/);

  // a stale non-git folder is reported, not clobbered
  fs.mkdirSync(path.join(reposRoot, "half-copy"));
  assert.throws(() => ensureRepo({ reposRoot, repo: "half-copy", owner: "Acme-Org" }), /not a git checkout/);
});
