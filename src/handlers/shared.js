import { log } from "../log.js";

// Every handler receives a ctx object:
//   { mention, classification, contextBlock, config, slack, selfId }

const SLACK_TEXT_LIMIT = 3500;
const STOP_REPLY = /^(stop|cancel|skip|huỷ|hủy|dừng|thôi)\b/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VI_RE = /[ơưăđ]|[Ẁ-ỿ]/i;
/** Returns "vi" or "en" based on mention.text only — ignores context block. */
export const detectLang = (text = "") => (VI_RE.test(text) ? "vi" : "en");
export const minutes = (ms) => Math.round(ms / 60_000);
export const trim = (text) =>
  text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n… (truncated)` : text;

const BRANCH_TYPES = new Set(["fix", "feat", "chore", "refactor", "docs"]);

/** Title → git-safe kebab slug: strips accents (Vietnamese titles included) and keeps it short. */
function slugify(text, { maxWords = 8, maxLen = 48 } = {}) {
  const slug = String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-");
  // Trim to length on a word boundary — "…-undefined-re" reads like a typo.
  return slug.length <= maxLen ? slug : slug.slice(0, maxLen).replace(/-[^-]*$/, "");
}

/**
 * A branch name a human can read in the PR list — `fix/price-filter-on-listing-page`,
 * never `auto/slack-1785862152-195269`. Accepts a plain title (an error line, a request
 * summary) or an already-typed suggestion (`feat/dark-mode`) from the classifier.
 * The fallback only kicks in when the title slugs to nothing (e.g. CJK-only text).
 */
export function toBranchName(title, { type = "fix", fallback = "" } = {}) {
  const [head, ...rest] = String(title ?? "").trim().split("/");
  const suggested = rest.length > 0 && BRANCH_TYPES.has(head.toLowerCase()) ? head.toLowerCase() : null;
  const slug = slugify(suggested ? rest.join("/") : title);
  return `${suggested ?? type}/${slug || slugify(fallback) || "slack-request"}`;
}

/** Thread timestamp for replying to a mention: its own thread if it is a reply, else the message itself. */
export function threadTsOf(mention) {
  return mention.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1] ?? mention.ts;
}

/**
 * While a worker runs, poll the self-DM for a "stop" reply and abort the
 * controller when one arrives — lets the user kill a running Claude session.
 * Returns a cleanup function; always call it when the worker settles.
 */
export function watchForStop(ctx, dmChannel, label, controller, intervalMs = 20_000) {
  const since = Date.now() / 1000;
  const timer = setInterval(async () => {
    try {
      const replies = await ctx.slack.fetchMessagesSince(dmChannel, since);
      if (replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) {
        log(`[${label}] stop received — killing the running worker`);
        clearInterval(timer);
        controller.abort();
      }
    } catch {
      // transient Slack error — try again next tick
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Wait out the grace window; true = the task must be dropped, either because the
 * user replied "stop" in the self-DM, or because they answered the original
 * conversation themselves while we were waiting.
 */
export async function cancelledDuringGrace(ctx, dmChannel, label) {
  const { config, slack, selfId, mention } = ctx;
  if (config.workerGraceMs <= 0) return false;
  const graceStart = Date.now() / 1000;
  log(`[${label}] grace window ${minutes(config.workerGraceMs)} min — reply "stop" in self-DM to cancel`);
  await sleep(config.workerGraceMs);

  const replies = await slack.fetchMessagesSince(dmChannel, graceStart);
  if (replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) {
    log(`[${label}] cancelled by user during grace window`);
    await slack.postToSelf(selfId, `:no_entry: Cancelled — I won't touch this request. ${mention.permalink ?? ""}`);
    return true;
  }

  // The user may have answered the thread themselves instead of typing "stop".
  // Thread-only: a stray channel message must not count as handling the request.
  const context = await slack.fetchContext(mention, ctx.config.contextWindowSeconds);
  const replied =
    context.kind === "thread" &&
    context.messages.some((m) => m.user === selfId && Number.parseFloat(m.ts) > Number.parseFloat(mention.ts));
  if (replied) {
    log(`[${label}] cancelled — you already replied in the conversation`);
    await slack.postToSelf(
      selfId,
      `:no_entry: Skipped — you already replied in the conversation yourself, so I'm staying out of it. ${mention.permalink ?? ""}`,
    );
    return true;
  }
  return false;
}
