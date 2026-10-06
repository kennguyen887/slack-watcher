import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { pruneWorktrees } from "./git.js";
import { listRepos } from "./repos.js";
import { createSlackClient, formatConversationContext } from "./slack.js";
import { loadState, saveState, mentionKey, appendHistory } from "./state.js";
import { classifyMention } from "./classify.js";
import { PR_URL_RE } from "./github.js";
import { HANDLERS } from "./handlers/index.js";
import { findReviewFollowup, handlePrReviewFollowup } from "./handlers/pr-review.js";
import { pollCwalert } from "./sources/cwalert.js";
import { log, stamp } from "./log.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findNewMentions(matches, state, selfId) {
  // search.messages renders mentions as <@ID> or <@ID|Display Name> — accept both.
  const mentionsMe = (m) => new RegExp(`<@${selfId}[|>]`).test(m.text ?? "");
  // PR-link messages trigger without a mention, but only the pr_review/ignore kinds downstream.
  const hasPrLink = (m) => m.prLinkOnly && PR_URL_RE.test(m.text ?? "");
  return matches
    .filter((m) => m.user !== selfId)
    .filter((m) => mentionsMe(m) || hasPrLink(m))
    // lastTs is only a search window; a mention owed a retry is re-admitted below it.
    .filter((m) => Number.parseFloat(m.ts) > state.lastTs || state.pending[mentionKey(m)])
    .filter((m) => !state.processed.includes(mentionKey(m)))
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
}

// Statuses that mean the work never ran, as opposed to ran-and-decided-not-to. These are
// failures the handler reports instead of throwing, so they need the same retry as a throw —
// a worktree that could not be created (a full disk, git contention) otherwise consumed the
// request as if it had been reviewed. Everything else — cancelled, cancelled_by_user,
// no_pr_url, unverified, reviewed — is a real outcome and must NOT come back.
const RETRYABLE_STATUSES = new Set(["worktree_failed"]);

/** Retire a mention: dedupe it forever, drop its retry entry, and move the search window. */
function consume(state, key, mention) {
  state.processed.push(key);
  delete state.pending[key];
  state.lastTs = Math.max(state.lastTs, Number.parseFloat(mention.ts));
}

/** Mention-search results win over PR-link results for the same message. */
function mergeMatches(mentionMatches, prMatches) {
  const merged = new Map(mentionMatches.map((m) => [mentionKey(m), m]));
  for (const m of prMatches) {
    if (!merged.has(mentionKey(m))) merged.set(mentionKey(m), { ...m, prLinkOnly: true });
  }
  return [...merged.values()];
}

/**
 * True when the user already replied in the SAME thread after the mention — they handled it.
 * Only applied to threads: in a non-threaded channel, an unrelated nearby message from the
 * user would otherwise cause a false skip.
 */
function userAlreadyReplied(context, mention, selfId) {
  if (context.kind !== "thread") return false;
  return context.messages.some(
    (m) => m.user === selfId && Number.parseFloat(m.ts) > Number.parseFloat(mention.ts),
  );
}

async function processMention(mention, repos, config, slack, selfId) {
  const context = await slack.fetchContext(mention, config.contextWindowSeconds);
  if (context.error) log(`context unavailable for ${mentionKey(mention)}: ${context.error}`);

  if (userAlreadyReplied(context, mention, selfId)) {
    log(`mention ${mentionKey(mention)} → skipped, you already replied in the conversation`);
    return { classification: { kind: "skipped" }, result: { status: "user_already_replied" } };
  }

  const contextBlock = formatConversationContext(context, mention, selfId);

  // A reply in a thread we already reviewed ("I updated them") is a review follow-up — routed
  // deterministically, BEFORE the classifier: the classifier reads such replies as status
  // updates (→ ignore), and the review worker's never-double-review pre-check would block a
  // fresh review anyway. The recorded session is resumed to re-check the update instead.
  const followup = findReviewFollowup(mention, config.historyFile);
  if (followup) {
    const classification = {
      kind: "pr_review_followup",
      repo: null,
      summary: `Follow-up in a reviewed thread — re-checking ${followup.prs.length} PR(s)`,
      prUrl: followup.prs[0]?.url ?? null,
      questions: [],
    };
    log(
      `mention ${mentionKey(mention)} → pr_review_followup (${followup.prs.length} PR(s), thread ${followup.threadTs}) resuming recorded review session(s)`,
    );
    if (config.dryRun) return { classification, result: { status: "dry_run" } };
    const result = await handlePrReviewFollowup({ mention, classification, contextBlock, config, slack, selfId, followup });
    return { classification, result };
  }

  const classification = await classifyMention(mention, repos, config, contextBlock);
  log(
    `mention ${mentionKey(mention)} → ${classification.kind} (repo: ${classification.repo ?? "-"}, context msgs: ${context.messages.length}) ${classification.summary}`,
  );

  if (config.dryRun) return { classification, result: { status: "dry_run" } };

  const handler = HANDLERS[classification.kind];
  const result = handler
    ? await handler({ mention, classification, contextBlock, context, config, slack, selfId })
    : { status: "ignored" };
  return { classification, result };
}

async function pollOnce(config, slack, selfId, query, state) {
  // Re-scan every poll so newly cloned repos are picked up without a restart.
  const repos = listRepos(config.reposRoot);
  const [mentionMatches, prMatches] = await Promise.all([
    slack.searchMentions(query),
    config.prSearchQuery ? slack.searchMentions(`"${config.prSearchQuery}"`) : [],
  ]);
  const fresh = findNewMentions(mergeMatches(mentionMatches, prMatches), state, selfId);
  if (fresh.length) log(`${fresh.length} new mention(s)`);

  for (const mention of fresh) {
    const key = mentionKey(mention);
    try {
      const { classification, result } = await processMention(mention, repos, config, slack, selfId);
      appendHistory(config.historyFile, {
        key,
        channel: mention.channel?.name,
        from: mention.username ?? mention.user,
        text: mention.text?.slice(0, 300),
        permalink: mention.permalink,
        classification,
        result,
      });
      if (RETRYABLE_STATUSES.has(result?.status)) {
        // Rethrow into the retry path below rather than duplicating its bookkeeping.
        throw new Error(`did not run (${result.status})`);
      }
      if (!config.dryRun) {
        consume(state, key, mention);
        saveState(config.stateFile, state);
      }
    } catch (err) {
      // A mention used to be consumed even when processing threw, so one bad poll — an expired
      // CLI login, a spend limit, a timeout — dropped the request for good and the team waited
      // on a review that was never coming. Leave it queued and retry on later polls instead;
      // the review worker's own never-double-review pre-check makes a retry safe.
      const attempts = (state.pending[key]?.attempts ?? 0) + 1;
      const exhausted = attempts >= config.mentionMaxAttempts;
      log(`ERROR processing ${key}: ${err.message} (attempt ${attempts}/${config.mentionMaxAttempts}${exhausted ? " — giving up" : ", will retry"})`);
      appendHistory(config.historyFile, { key, error: err.message, attempts, gaveUp: exhausted });
      if (!config.dryRun) {
        if (exhausted) consume(state, key, mention);
        else state.pending[key] = { ts: mention.ts, attempts, lastError: err.message };
        saveState(config.stateFile, state);
        // One DM when it first breaks and one when it is abandoned — not once per attempt.
        if (attempts === 1 || exhausted) {
          const what = exhausted
            ? `gave up after ${attempts} attempts (\`npm run retry -- ${key}\` to requeue)`
            : `failed, retrying (attempt ${attempts}/${config.mentionMaxAttempts})`;
          await slack
            .postToSelf(selfId, `:x: Watcher ${what} on a mention (${mention.permalink ?? key}): ${err.message}`)
            .catch((dmErr) => log(`ERROR posting failure DM: ${dmErr.message}`));
        }
      }
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");
  const config = loadConfig();
  fs.mkdirSync(config.logDir, { recursive: true });
  fs.mkdirSync(config.workerSessionsDir, { recursive: true });

  // Worktrees outlive their worker so sessions stay resumable — reap old ones here.
  try {
    pruneWorktrees(config.worktreesDir, config.worktreeKeepDays, config.worktreeKeepMax);
  } catch (err) {
    log(`worktree prune failed: ${err.message}`);
  }

  const slack = createSlackClient(config.slackToken, config.slackWebhooks);
  const { userId, userName, team } = await slack.whoAmI();
  const query = config.searchQueryOverride || `<@${userId}>`;

  const state = loadState(config.stateFile);
  if (state.lastTs === 0) {
    // First run: start from "now" so we never storm through historical mentions.
    state.lastTs = Date.now() / 1000;
    saveState(config.stateFile, state);
    log("first run — baseline set to now, historical mentions skipped");
  }

  log(
    `watching mentions of @${userName} (${userId}) on ${team} | query="${query}" | every ${config.pollIntervalSeconds}s${config.dryRun ? " | DRY RUN" : ""}`,
  );
  log(`repos: ${listRepos(config.reposRoot).join(", ")}`);

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  if (config.cwalert.enabled) {
    log(`cwalert source ON — event log ${config.cwalert.eventLog}, base ${config.cwalert.baseBranch}, cooldown ${Math.round(config.cwalert.cooldownMs / 3_600_000)}h`);
    // Auto-merge lands unreviewed code on a shared branch — never let it be a surprise: say so
    // on every start, so the log itself shows whether the kill switch is on.
    log(
      config.cwalert.autoMerge
        ? `cwalert auto-merge ARMED for env ${config.cwalert.autoMergeEnvs.join("/")} — fatal only, confidence >= ${config.cwalert.autoMergeMinConfidence}/10, diff <= ${config.cwalert.autoMergeMaxFiles} files/${config.cwalert.autoMergeMaxLines} lines (CWALERT_AUTOMERGE=0 to disarm)`
        : "cwalert auto-merge OFF — every fix PR waits for you",
    );
  }

  do {
    try {
      await pollOnce(config, slack, userId, query, state);
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message ?? err.cause})` : "";
      log(`poll error: ${err.message}${cause}`);
    }
    // CloudWatch auto-fix source — isolated try/catch so a failure never stalls mention polling.
    if (config.cwalert.enabled) {
      try {
        await pollCwalert(config, slack, userId);
      } catch (err) {
        log(`cwalert poll error: ${err.message}`);
      }
    }
    if (!once) await sleep(config.pollIntervalSeconds * 1000);
  } while (!once && !stopping);

  log("stopped");
}

// Only run when this file IS the program. Importing it (a test reaching for one of its
// helpers) used to start a second live watcher against the real Slack and state file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[${stamp()}] FATAL: ${err.message}`);
    process.exit(1);
  });
}
