// Handler helpers that decide something durable. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import { toBranchName } from "../src/handlers/shared.js";

// The worker pushes this string, so a bad slug means a rejected push or an unreadable PR list.
// Pinned: accents must not survive (git refs are ASCII here), the classifier's own fix//feat
// prefix wins, and an untranslatable title must never produce a bare `fix/`.
test("toBranchName turns a request title into a readable, git-safe branch", () => {
  assert.equal(toBranchName("feat/dark mode for the dashboard"), "feat/dark-mode-for-the-dashboard");
  assert.equal(toBranchName("Sửa lỗi filter giá trên trang listing"), "fix/sua-loi-filter-gia-tren-trang-listing");
  assert.equal(
    toBranchName("TypeError: Cannot read properties of undefined (reading 'user') at /app/src/x.js:12"),
    "fix/typeerror-cannot-read-properties-of-undefined",
  );
  assert.equal(toBranchName("日本語のみ", { fallback: "slack-1785862152.195269" }), "fix/slack-1785862152-195269");
  assert.equal(toBranchName(""), "fix/slack-request");
});
