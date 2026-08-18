import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, ensureRepo, removeWorktree } from "../git.js";
import { waitForChecks, mergePr } from "../github.js";
import { log } from "../log.js";
import { minutes, newSessionId, resumeHint, showInDesktopApp, trim, watchForStop } from "./shared.js";

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
  const lines = [`• Service: ${event.service}`, `• Environment: ${event.env ?? "unknown"}`, `• Severity: ${event.severity}`];
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
  // The first line becomes the session's title in the Claude desktop app, so lead with "[slack]".
  return `[slack] Auto-fix ${event.service} (${event.severity}) — a production error was detected in ${origin} and needs a code fix. Investigate the ROOT CAUSE and open a pull request.

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
ROOT_CAUSE_CONFIDENCE: <1-10 — how sure you are this is THE root cause, not a plausible story. Be honest: an unreproduced hypothesis is <=5 however tidy it looks. This number can auto-merge the PR on RC, so overclaiming ships unreviewed code>
TESTS: <pass | fail | none — did the repo's own test suite run green in the worktree?>
SLACK_DRAFT: <a short status line for me (English) — the fix summary, or why this wasn't auto-fixable>`;
}

/** Could this event's PR merge itself at all? The env/severity half of the gate, known up front. */
export function armedForAutoMerge(event, cfg) {
  return Boolean(cfg.autoMerge) && cfg.autoMergeEnvs.includes(event.env) && event.severity === "fatal";
}

/**
 * Should this PR merge itself? Every gate must hold. Returns the first blocking reason instead of
 * a bare false so the DM can say WHY a fix is waiting on a human.
 * @returns {{ merge: boolean, reason: string }}
 */
export function autoMergeDecision({ event, confidence, tests, pr, cfg }) {
  if (!cfg.autoMerge) return { merge: false, reason: "auto-merge is off (CWALERT_AUTOMERGE)" };
  // prod (and any env we can't identify) is never merged by a machine.
  if (!cfg.autoMergeEnvs.includes(event.env)) return { merge: false, reason: `env \`${event.env ?? "unknown"}\` is review-only` };
  // "killed the service", not "logged an error": only a crash the app itself called fatal.
  if (event.severity !== "fatal") return { merge: false, reason: `severity \`${event.severity}\` is not a crash` };
  if (!(confidence >= cfg.autoMergeMinConfidence)) {
    return { merge: false, reason: `root-cause confidence ${confidence ?? "?"}/10 < ${cfg.autoMergeMinConfidence}` };
  }
  if (tests !== "pass") return { merge: false, reason: `tests: ${tests ?? "unknown"}` };
  if (pr.state !== "OPEN" || pr.isDraft) return { merge: false, reason: `PR is ${pr.isDraft ? "a draft" : pr.state.toLowerCase()}` };
  if (pr.mergeable !== "MERGEABLE") return { merge: false, reason: `GitHub says ${pr.mergeable} (${pr.mergeStateStatus})` };
  if (pr.checks === "failed" || pr.checks === "pending") return { merge: false, reason: `CI checks ${pr.checks}` };
  // A root-cause fix for a crash is small. A sprawling diff means it grew into something else.
  if (pr.changedFiles > cfg.autoMergeMaxFiles || pr.changedLines > cfg.autoMergeMaxLines) {
    return { merge: false, reason: `diff too large (${pr.changedFiles} files / ${pr.changedLines} lines)` };
  }
  return { merge: true, reason: pr.checks === "none" ? "gates passed (repo runs no CI — worker's own tests only)" : "gates passed, CI green" };
}

/**
 * Handle one alert event (CloudWatch alerter or Sentry): isolated worktree → claude fix worker → PR → self-DM.
 * @param {{ event: object, config: object, slack: object, selfId: string }} ctx
 */
export async function handleCwalertFix({ event, config, slack, selfId }) {
  const cfg = config.cwalert;
  const repo = repoForService(event.service, cfg.serviceRepos);

  // Needs a real checkout under REPOS_ROOT — clone it if the service's repo isn't there yet.
  // The alerter carries no GitHub owner, so ensureRepo infers it from the repos already cloned.
  let repoPath;
  try {
    if (!repo) throw new Error("could not derive a repo name from the service");
    ({ repoPath } = ensureRepo({ reposRoot: config.reposRoot, repo }));
  } catch (err) {
    log(`[cwalert:${repo || "?"}] no local checkout: ${err.message}`);
    await slack.postToSelf(
      selfId,
      `:warning: *${originOf(event)} ${event.severity}* in *${event.service}* — can't auto-fix, no checkout for \`${repo || "?"}\`: ${err.message}\nMap it via CWALERT_SERVICE_REPOS if the repo name differs.\n> ${trim(event.sample)}\nLogs: ${event.consoleUrl}`,
    );
    return { status: "needs_repo", repo, error: err.message };
  }

  const branchName = `auto/cwalert-${String(event.ts)}`;
  const dmChannel = await slack.postToSelf(
    selfId,
    `:rotating_light: *Auto-fix picked up a ${originOf(event)} ${event.severity}*\n` +
      `> ${trim(event.sample)}\n` +
      `• Service: *${event.service}* → repo *${repo}* (branch \`${branchName}\`, isolated worktree)\n` +
      `• Base: fresh \`origin/${cfg.baseBranch}\` — your working copy is untouched\n` +
      `• ${armedForAutoMerge(event, cfg) ? `Auto-merge ARMED (env \`${event.env}\`, fatal) — merges itself only if confidence ≥ ${cfg.autoMergeMinConfidence}/10, tests pass, PR clean and diff ≤ ${cfg.autoMergeMaxFiles} files/${cfg.autoMergeMaxLines} lines` : "Auto-merge off for this event — I'll ping you to review"}\n` +
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

  const sessionId = newSessionId();
  const startedAt = Date.now();
  log(`[cwalert:${repo}] worker started (session ${sessionId})`);
  const heartbeat = setInterval(
    () => log(`[cwalert:${repo}] worker still running (${minutes(Date.now() - startedAt)} min elapsed)`),
    HEARTBEAT_MS,
  );
  const controller = new AbortController();
  const stopWatching = watchForStop({ slack }, dmChannel, `cwalert:${repo}`, controller);

  let result;
  let discarded = false;
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
      sessionId,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      discarded = true;
      removeWorktree(repoPath, worktreePath);
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
    // Any non-cancelled outcome keeps the worktree so the fix session can be resumed.
    if (!discarded) {
      log(`[cwalert:${repo}] worker finished after ${minutes(Date.now() - startedAt)} min — resume: cd ${worktreePath} && claude --resume ${sessionId}`);
      showInDesktopApp(sessionId);
    }
  }

  const elapsedMin = minutes(Date.now() - startedAt);
  const prUrl = result.match(/^PR_URL:\s*(\S+)/m)?.[1] ?? "none";
  const confidence = Number.parseInt(result.match(/^ROOT_CAUSE_CONFIDENCE:\s*(\d+)/m)?.[1] ?? "", 10);
  const tests = result.match(/^TESTS:\s*(\w+)/m)?.[1]?.toLowerCase() ?? "unknown";
  const slackDraft = result.match(/SLACK_DRAFT:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  log(`[cwalert:${repo}] result: ${prUrl !== "none" ? `PR ${prUrl}` : "no PR"}`);

  if (prUrl === "none") {
    await slack.postToSelf(
      selfId,
      trim(
        `:information_source: *No auto-fix PR* for the ${originOf(event)} error in *${repo}* (${elapsedMin} min) — likely not a code bug (see below):\n` +
          `> ${event.sample}\nLogs: ${event.consoleUrl}` +
          `\n:technologist: Session is in the Claude desktop app now — or in terminal: ${resumeHint(worktreePath, sessionId)}` +
          (slackDraft ? `\n\n${slackDraft}` : "") +
          `\n\nWorker output:\n${result}`,
      ),
    );
    return { status: "no_pr", prUrl, sessionId, worktreePath };
  }

  const merged = await settlePr({ prUrl, event, repo, confidence, tests, cfg });
  await slack.postToSelf(
    selfId,
    trim(
      `${prHeader({ event, repo, prUrl, elapsedMin, merged })}\n> ${event.sample}\nLogs: ${event.consoleUrl}` +
        `\n:technologist: Session is in the Claude desktop app now — or in terminal: ${resumeHint(worktreePath, sessionId)}` +
        (slackDraft ? `\n\n${slackDraft}` : "") +
        `\n_root-cause confidence ${Number.isInteger(confidence) ? `${confidence}/10` : "not stated"} · tests: ${tests}_`,
    ),
  );
  return { status: merged.merged ? "pr_merged" : "pr_opened", prUrl, merged, sessionId, worktreePath };
}

/**
 * Decide and, if every gate holds, merge the PR. Never throws: a merge failure must still leave
 * the user with a DM and an open PR they can merge by hand.
 * @returns {Promise<{ merged: boolean, reason: string, sha?: string, error?: string }>}
 */
async function settlePr({ prUrl, event, repo, confidence, tests, cfg }) {
  if (!cfg.autoMerge || !cfg.autoMergeEnvs.includes(event.env)) {
    return { merged: false, reason: autoMergeDecision({ event, confidence, tests, pr: {}, cfg }).reason };
  }
  let pr;
  try {
    // Checks usually haven't started the second the PR opens — wait, bounded, before judging.
    pr = await waitForChecks(prUrl, { timeoutMs: cfg.autoMergeChecksTimeoutMs });
  } catch (err) {
    return { merged: false, reason: `could not read PR status: ${err.message}` };
  }
  const decision = autoMergeDecision({ event, confidence, tests, pr, cfg });
  if (!decision.merge) return { merged: false, reason: decision.reason };
  try {
    const sha = mergePr(prUrl);
    log(`[cwalert:${repo}] auto-merged ${prUrl} (${sha})`);
    return { merged: true, reason: decision.reason, sha };
  } catch (err) {
    log(`[cwalert:${repo}] auto-merge FAILED for ${prUrl}: ${err.message}`);
    return { merged: false, reason: `merge failed: ${err.message}`, error: err.message };
  }
}

/** Slack header: merged (RC), or an urgent ping when a human has to merge it. */
function prHeader({ event, repo, prUrl, elapsedMin, merged }) {
  if (merged.merged) {
    return (
      `:white_check_mark: *Auto-fix MERGED to \`rc\`* for *${repo}* in ${elapsedMin} min: ${prUrl}\n` +
      `• Gate: ${merged.reason}${merged.sha ? ` · commit \`${merged.sha.slice(0, 8)}\`` : ""}\n` +
      `• Revert: \`gh pr create\` from \`git revert ${merged.sha ? merged.sha.slice(0, 8) : "<sha>"}\` — nobody reviewed this before it landed`
    );
  }
  const urgent = event.env === "prod";
  return (
    `${urgent ? ":rotating_light::rotating_light: *PROD — REVIEW + MERGE NEEDED*" : ":white_check_mark: *Auto-fix PR opened*"}` +
    ` for *${repo}* in ${elapsedMin} min: ${prUrl}\n` +
    `• Not auto-merged: ${merged.reason}`
  );
}
