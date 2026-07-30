import path from "node:path";
import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, removeWorktree } from "../git.js";
import { log } from "../log.js";
import { minutes, trim, watchForStop } from "./shared.js";

const HEARTBEAT_MS = 5 * 60_000;

/** Map an alerter service name to a repo folder under REPOS_ROOT. */
export function repoForService(service, serviceRepos = {}) {
  if (serviceRepos[service]) return serviceRepos[service];
  // "listings-api (rc scheduler)" / "legacy-api (rc)" → base service name.
  return String(service || "").replace(/\s*\(.*\)\s*$/, "").trim();
}

/** Where the event came from — the two producers carry different context fields. */
function originOf(event) {
  return event.source === "sentry" ? "Sentry" : "CloudWatch";
}

/** Producer-specific context lines: a Sentry issue has no log group / pattern / occurrence count. */
function eventContext(event) {
  const lines = [`• Service: ${event.service}`, `• Severity: ${event.severity}`];
  if (event.source === "sentry") {
    lines.push(`• Sentry project: ${event.project}`, `• Sentry issue: ${event.consoleUrl}`);
  } else {
    lines.push(
      `• Log group: ${event.group} (${event.region})`,
      `• Pattern matched: ${event.pattern}`,
      `• Occurrences in the alert window: ${event.count}`,
      `• CloudWatch logs: ${event.consoleUrl}`,
    );
  }
  return lines.join("\n");
}

function fixPrompt(event, branchName, base, draft) {
  const prCmd = `gh pr create --base ${base}${draft ? " --draft" : ""}`;
  const origin = originOf(event);
  return `A production error was detected in ${origin} and needs a code fix. Investigate the ROOT CAUSE and open a pull request.

${origin} error:
"""
${event.sample}
"""
${eventContext(event)}

Mandatory workflow for this repository:
1. You are already in an ISOLATED git worktree checked out at the latest \`origin/${base}\` (detached). The user's main working copy lives elsewhere — never cd into it or touch it. Branch from here.
2. Create a branch named \`${branchName}\`.
3. DUPLICATE-WORK CHECK before writing any code:
   - Run \`gh pr list --state all --limit 20\` and \`git log origin/${base} --oneline -20\`; search for this error, the files involved, and keywords from the message.
   - If existing work already fixes this error (open/merged PR, recent commit), STOP, make no changes, and put that PR/commit link in SLACK_DRAFT.
4. Find the ROOT CAUSE of THIS error — trace from the log message/stack to the offending code. Do NOT ship a symptom patch (a blind try/catch or guard) unless that is genuinely the correct fix. If you cannot name the root cause, you do not have a fix — go to step 6.
5. NEVER "fix" this by silencing the signal. All of these are FORBIDDEN as the fix: lowering a log level (error→warn/info), deleting or commenting out the log line, widening a try/catch to swallow the error, adding an ignore/suppress/eslint-disable rule, or raising an alert threshold. Same for scope creep: no refactors, no cleanups, no "improvement while I'm here", no dependency bumps or test/doc-only PRs unless that IS the root-cause fix. If the message turns out to be benign noise that a human should simply stop alerting on, open NO PR — write that recommendation in SLACK_DRAFT and let the human decide.
6. IMPORTANT — bail out cleanly if this is NOT a fixable code bug. Many alerts are integration outages (HubSpot/CustomerIO/DTN down), config/credential problems, transient network errors, or data issues with no code fix, and some can't be located from the message alone. In any of those cases: STOP, make NO changes, open NO PR, and explain in SLACK_DRAFT what the error is and why it isn't auto-fixable (e.g. "upstream HubSpot 5xx — no code change"). A wrong PR is worse than none.
7. If you do fix it: implement the smallest correct change, follow existing code style and the repo's own rules (CLAUDE.md / CONTRIBUTING.md if present).
8. Run the project's tests and lint; fix failures you introduced. A fresh worktree has no node_modules — install dependencies first (pnpm/npm per the repo's lockfile).
9. Commit with a plain message describing the fix. NEVER add AI attribution (no Co-Authored-By, no "Generated with" lines).
10. Push the branch and open the pull request targeting \`${base}\`: \`${prCmd}\`. The PR body must describe the error, the root cause, the fix, how you verified it, and anything left unverified.

End your final message with exactly these lines:
PR_URL: <the pull request URL, or "none" if you opened no PR>
SLACK_DRAFT: <a short status line for me (English) — the fix summary, or why this wasn't auto-fixable>`;
}

/**
 * Handle one alert event (CloudWatch alerter or Sentry): isolated worktree → claude fix worker → PR → self-DM.
 * @param {{ event: object, config: object, slack: object, selfId: string }} ctx
 */
export async function handleCwalertFix({ event, config, slack, selfId }) {
  const cfg = config.cwalert;
  const repo = repoForService(event.service, cfg.serviceRepos);
  const repoPath = repo ? path.join(config.reposRoot, repo) : null;

  // Require an actual git checkout under REPOS_ROOT — a bare folder (e.g. a service that was
  // never cloned) would only fail later at `git fetch`. existsSync covers both a .git dir and
  // a .git file (worktrees/submodules), matching listRepos().
  if (!repoPath || !fs.existsSync(path.join(repoPath, ".git"))) {
    await slack.postToSelf(
      selfId,
      `:warning: *${originOf(event)} ${event.severity}* in *${event.service}* — no git checkout for repo \`${repo || "?"}\` under REPOS_ROOT, can't auto-fix. Clone it there or map it via CWALERT_SERVICE_REPOS.\n> ${trim(event.sample)}\nLogs: ${event.consoleUrl}`,
    );
    return { status: "needs_repo", repo };
  }

  const branchName = `auto/cwalert-${String(event.ts)}`;
  const dmChannel = await slack.postToSelf(
    selfId,
    `:rotating_light: *Auto-fix picked up a ${originOf(event)} ${event.severity}*\n` +
      `> ${trim(event.sample)}\n` +
      `• Service: *${event.service}* → repo *${repo}* (branch \`${branchName}\`, isolated worktree)\n` +
      `• Base: fresh \`origin/${cfg.baseBranch}\` — your working copy is untouched\n` +
      `• Reply \`stop\` here to cancel while it runs. Timeout ${minutes(config.workerTimeoutMs)} min — I'll DM the result (PR or reason).\n` +
      `Logs: ${event.consoleUrl}`,
  );

  let worktreePath;
  try {
    worktreePath = createWorktree(repoPath, repo, String(event.ts), config.worktreesDir, cfg.baseBranch);
    log(`[cwalert:${repo}] worktree ready: ${worktreePath}`);
  } catch (err) {
    await slack.postToSelf(
      selfId,
      `:x: Could not prepare a worktree for *${repo}* (${err.message}). Handle this ${originOf(event)} error manually.\nLogs: ${event.consoleUrl}`,
    );
    return { status: "worktree_failed", error: err.message };
  }

  const startedAt = Date.now();
  const heartbeat = setInterval(
    () => log(`[cwalert:${repo}] worker still running (${minutes(Date.now() - startedAt)} min elapsed)`),
    HEARTBEAT_MS,
  );
  const controller = new AbortController();
  const stopWatching = watchForStop({ slack }, dmChannel, `cwalert:${repo}`, controller);

  let result;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: fixPrompt(event, branchName, cfg.baseBranch, cfg.draft),
      cwd: worktreePath,
      timeoutMs: config.workerTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      model: config.workerModel,
      label: `cwalert:${repo}`,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* the auto-fix worker for *${repo}* after ${minutes(Date.now() - startedAt)} min. Worktree discarded; if a branch/PR was pushed, close it manually.`,
      );
      return { status: "cancelled_mid_task" };
    }
    throw err;
  } finally {
    stopWatching();
    clearInterval(heartbeat);
    removeWorktree(repoPath, worktreePath);
  }

  const elapsedMin = minutes(Date.now() - startedAt);
  const prUrl = result.match(/^PR_URL:\s*(\S+)/m)?.[1] ?? "none";
  const slackDraft = result.match(/SLACK_DRAFT:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  log(`[cwalert:${repo}] result: ${prUrl !== "none" ? `PR ${prUrl}` : "no PR"}`);

  const header =
    prUrl !== "none"
      ? `:white_check_mark: *Auto-fix PR opened* for *${repo}* in ${elapsedMin} min: ${prUrl}`
      : `:information_source: *No auto-fix PR* for the ${originOf(event)} error in *${repo}* (${elapsedMin} min) — likely not a code bug (see below):`;

  await slack.postToSelf(
    selfId,
    trim(
      `${header}\n> ${event.sample}\nLogs: ${event.consoleUrl}` +
        (slackDraft ? `\n\n${slackDraft}` : "") +
        (prUrl === "none" ? `\n\nWorker output:\n${result}` : ""),
    ),
  );
  return { status: prUrl !== "none" ? "pr_opened" : "no_pr", prUrl };
}
