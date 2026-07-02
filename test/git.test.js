// Integration test for createWorktree: proves a fix always starts from the LATEST origin/<base>
// tip. No HTTP layer exists here, so the git binary + filesystem IS the outermost boundary.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createWorktree } from "../src/git.js";

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

  const wt1 = createWorktree(work, "repo", "1.0", worktreesDir, base);
  assert.equal(fs.readFileSync(path.join(wt1, "app.txt"), "utf8"), "v1");

  // A NEW commit lands on origin/rc after the first worktree was made.
  fs.writeFileSync(path.join(work, "app.txt"), "v2");
  g(work, "commit", "-am", "c2"); g(work, "push", "origin", base);

  // A fresh worktree must reflect the newest tip — this is the "fix on latest source" guarantee.
  const wt2 = createWorktree(work, "repo", "2.0", worktreesDir, base);
  assert.equal(fs.readFileSync(path.join(wt2, "app.txt"), "utf8"), "v2");
  assert.equal(g(wt2, "rev-parse", "HEAD"), g(work, "rev-parse", `origin/${base}`));
});

test("createWorktree throws a clear error when the base branch does not exist on origin", () => {
  const { root, work } = makeRemoteAndClone("main");
  fs.writeFileSync(path.join(work, "f"), "x");
  g(work, "add", "."); g(work, "commit", "-m", "c1"); g(work, "push", "-u", "origin", "main");
  assert.throws(
    () => createWorktree(work, "repo", "1.0", path.join(root, "wt"), "does-not-exist"),
    /base branch origin\/does-not-exist not found/,
  );
});
