import { execFileSync } from "node:child_process";
import { log } from "./log.js";

// `ocr delegate` runs no LLM — it is file selection, exclusion and rule resolution only, so it
// finishes in seconds. Bounded anyway: an outbound call that hangs would stall the poll loop.
const OCR_TIMEOUT_MS = 120_000;
// A huge PR must not turn into a huge prompt. The list is what makes coverage deterministic, so
// it is long on purpose; past this the review is unreviewable anyway and the count carries it.
const MAX_LISTED_FILES = 100;
// Rules come back GROUPED by content, so a few dozen paths already surface every group.
const MAX_RULE_PATHS = 200;

function ocr(bin, args, cwd) {
  return execFileSync(bin, [...args, "--color", "never"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OCR_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function listFiles(files, { more = "review those too" } = {}) {
  const shown = files.slice(0, MAX_LISTED_FILES);
  const lines = shown.map(
    (f) => `  - ${f.path} [${f.status}] +${f.insertions}/-${f.deletions}${f.exclude_reason ? ` (${f.exclude_reason})` : ""}`,
  );
  if (files.length > shown.length) lines.push(`  - … and ${files.length - shown.length} more — ${more}`);
  return lines.join("\n");
}

function render(preview, files, rules) {
  const excluded = preview.excluded_files ?? [];
  return `
Open Code Review — review spec (deterministic, no model involved)
\`ocr delegate\` resolved this before you started: which files of this PR are in scope, which are
out, and the checklist that applies to each. THIS LIST IS AUTHORITATIVE for coverage — review every
file on it, because a large diff is exactly where a reviewer silently skips files. The checklist is
what to LOOK for; whether a finding earns a comment is decided by the workflow below, which
overrides the checklist whenever the two disagree.

Range: ${preview.mode}${preview.merge_base ? ` from merge-base ${preview.merge_base}` : ""} — ${files.length} file(s) to review, ${excluded.length} excluded, +${preview.total_insertions}/-${preview.total_deletions}.

Review these:
${listFiles(files)}
${excluded.length ? `\nNot review targets (tests, generated, vendored, lockfiles, unsupported types). Read them when they explain the change; do not spend review comments on them — unless one hides a real defect in the files above, e.g. a test that only asserts its own mock and so proves nothing about this diff:\n${listFiles(excluded, { more: "also not review targets" })}\n` : ""}
Checklist for these files:
${rules.trim()}
`;
}

/**
 * The deterministic half of a PR review: the file list and the per-file checklist that Open Code
 * Review resolves from `ocr/rule.json`, rendered as a prompt block.
 *
 * This is the half a language model is worst at and an engineering pipeline is best at. A worker
 * handed only "review this PR" quietly reads some files and not others on a big diff, and judges
 * every file against whatever bar it remembers; handed this block it has a closed list to cover
 * and the same checklist every time.
 *
 * Returns null — never throws — when `ocr` is missing, fails, or finds nothing reviewable. The
 * review then runs exactly as it did before this module existed: degraded, not broken, because an
 * unattended daemon must not lose a review over an optional tool.
 * @returns {{ block: string, reviewable: number, excluded: number } | null}
 */
export function reviewSpec({ bin = "ocr", ruleFile, cwd, from, to = "HEAD", label = "ocr" }) {
  try {
    const rule = ruleFile ? ["--rule", ruleFile] : [];
    const preview = JSON.parse(
      ocr(bin, ["delegate", "preview", "--from", from, "--to", to, "--format", "json", ...rule], cwd),
    );
    const files = preview.reviewable_files ?? [];
    if (!files.length) {
      log(`[${label}] ocr: nothing reviewable in ${from}..${to} (${preview.excluded_count ?? 0} excluded)`);
      return null;
    }
    const paths = files.slice(0, MAX_RULE_PATHS).map((f) => f.path);
    const rules = ocr(bin, ["delegate", "rule", ...rule, ...paths], cwd);
    log(`[${label}] ocr: ${files.length} file(s) to review, ${preview.excluded_count ?? 0} excluded`);
    return { block: render(preview, files, rules), reviewable: files.length, excluded: preview.excluded_count ?? 0 };
  } catch (err) {
    const why = (err.stderr?.toString() || err.message || "").split("\n")[0].slice(0, 200);
    log(`[${label}] ocr unavailable — reviewing the diff without a review spec: ${why}`);
    return null;
  }
}
