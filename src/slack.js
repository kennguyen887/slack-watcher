const SLACK_API = "https://slack.com/api";
const MAX_RETRIES = 3;
// A hung socket must never wedge a poll: in one-shot (cron) mode the overlap
// guard would then skip every future tick behind a process that never exits.
const REQUEST_TIMEOUT_MS = 30_000;

export const WEBHOOK_URL_RE = /^https:\/\/hooks\.slack\.com\//;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The attempt loop shared by both transports: network errors, 429s and 5xx are
 * retried with backoff, anything else is handed back for the caller to read.
 *
 * Network errors used to propagate on the first try, so one wifi blip lost the
 * message (a send.js update, or worse a grace-gate DM) with nothing retrying it.
 * A request that died mid-flight may in rare cases have been delivered anyway —
 * for this tool a duplicated message beats a silently lost one.
 */
async function fetchWithRetry(label, makeRequest) {
  let lastFailure = "rate limited";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await makeRequest();
    } catch (err) {
      // DNS failures, connection resets and the 30s abort all land here.
      lastFailure = err.message;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "5", 10);
      lastFailure = "rate limited";
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    // Slack asks clients to retry 5xx; a proxy's HTML error page also lands
    // here rather than in the caller's body parse.
    if (response.status >= 500) {
      lastFailure = `HTTP ${response.status}`;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    return response;
  }
  throw new Error(`${label} failed after ${MAX_RETRIES + 1} attempts: ${lastFailure}`);
}

async function call(token, method, params, { httpMethod = "POST" } = {}) {
  const response = await fetchWithRetry(`Slack ${method}`, () => {
    if (httpMethod === "GET") {
      const qs = new URLSearchParams(params).toString();
      return fetch(`${SLACK_API}/${method}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
    return fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  });

  const body = await response.json();
  if (!body.ok) {
    throw new Error(`Slack ${method} failed: ${body.error}`);
  }
  return body;
}

/** Normalize a target so "#Chan", "chan" and a raw ID all match one map key. */
const webhookKey = (target) => String(target).replace(/^#/, "").toLowerCase();

/** The incoming-webhook URL configured for this target, or null to post as the user. */
export function resolveWebhook(webhooks, target) {
  if (!webhooks || !target) return null;
  const wanted = webhookKey(target);
  const hit = Object.entries(webhooks).find(([channel]) => webhookKey(channel) === wanted);
  return hit ? hit[1] : null;
}

/**
 * Post through an incoming webhook, so the message shows up as the webhook's app
 * instead of as you. The webhook is bound to ONE channel when it is created, so the
 * map key is only a routing label — the URL alone decides where the text lands.
 */
async function postWebhook(url, text, threadTs) {
  const response = await fetchWithRetry("Slack webhook", () =>
    fetch(url, {
      method: "POST",
      // No Authorization header: the URL *is* the credential, and handing the user
      // token to it would leak exactly what this route exists to stop using.
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );

  // Webhooks answer in plain text: "ok", or a 4xx with invalid_payload /
  // channel_not_found / no_service (a revoked, mistyped or deleted hook).
  const body = (await response.text()).trim();
  if (!response.ok || body !== "ok") {
    throw new Error(`Slack webhook failed: HTTP ${response.status} ${body || "(empty body)"}`);
  }
}

/** Render fetched context as a prompt block. Empty string when there is nothing useful. */
export function formatConversationContext(context, mention, selfId) {
  if (!context || !context.messages.length || (context.messages.length === 1 && context.messages[0].ts === mention.ts)) {
    return "";
  }
  const lines = context.messages.map((m) => {
    const who =
      m.ts === mention.ts
        ? ">>> [the mention] "
        : m.user === selfId
          ? "[me] "
          : m.user === mention.user
            ? "[requester] "
            : `[<@${m.user}>] `;
    return who + m.text;
  });
  return `
Conversation context around the mention (oldest first; the requester often splits one request across several short messages — read them as a whole):
"""
${lines.join("\n").slice(0, 4000)}
"""
`;
}

/**
 * @param webhooks  channel → incoming-webhook URL. A target on this map is posted through
 *                  its webhook (as the webhook's app); everything else posts as the token's
 *                  user. Empty map = today's behavior, everything as you.
 */
export function createSlackClient(token, webhooks = {}) {
  return {
    async whoAmI() {
      const { user_id, user, team } = await call(token, "auth.test", {});
      return { userId: user_id, userName: user, team };
    },

    async searchMentions(query, count = 50, page = 1) {
      const body = await call(
        token,
        "search.messages",
        { query, sort: "timestamp", sort_dir: "desc", count: String(count), page: String(page) },
        { httpMethod: "GET" },
      );
      return body.messages?.matches ?? [];
    },

    /**
     * Pull conversation context around a mention: the full thread if the mention
     * is a thread reply, otherwise nearby channel messages (±windowSeconds).
     * Requires history scopes (channels/groups/im/mpim:history); degrades to
     * {messages: [], error} when the token lacks them.
     */
    async fetchContext(match, windowSeconds = 900) {
      const channelId = match.channel?.id;
      if (!channelId) return { messages: [], error: "no channel id", kind: "none" };
      try {
        const threadTs = match.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1];
        const kind = threadTs ? "thread" : "channel";
        let messages;
        if (threadTs) {
          const body = await call(
            token,
            "conversations.replies",
            { channel: channelId, ts: threadTs, limit: "50" },
            { httpMethod: "GET" },
          );
          messages = body.messages ?? [];
        } else {
          const ts = Number.parseFloat(match.ts);
          const body = await call(
            token,
            "conversations.history",
            {
              channel: channelId,
              oldest: String(ts - windowSeconds),
              latest: String(ts + windowSeconds),
              inclusive: "true",
              limit: "30",
            },
            { httpMethod: "GET" },
          );
          messages = (body.messages ?? []).reverse(); // history returns newest first
        }
        return {
          messages: messages
            .filter((m) => (m.type === "message" || !m.type) && m.text)
            .map((m) => ({ user: m.user, ts: m.ts, text: m.text.slice(0, 500) })),
          error: null,
          kind,
        };
      } catch (err) {
        return { messages: [], error: err.message, kind: "none" };
      }
    },

    /** Post to any conversation: channel ID, #channel-name, user ID (DM), or group ID. */
    async post(channel, text) {
      const hook = resolveWebhook(webhooks, channel);
      if (hook) {
        await postWebhook(hook, text);
        // The webhook answers "ok" and nothing else, so echo the target back: callers
        // only use this to say where the message went.
        return channel;
      }
      const body = await call(token, "chat.postMessage", {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return body.channel;
    },

    /** Resolve @username / display name / real name → user ID. Requires users:read scope. */
    async resolveUserId(handle) {
      const name = handle.replace(/^@/, "").toLowerCase();
      let cursor;
      do {
        const body = await call(
          token,
          "users.list",
          { limit: "200", ...(cursor ? { cursor } : {}) },
          { httpMethod: "GET" },
        );
        const hit = (body.members ?? []).find(
          (u) =>
            !u.deleted &&
            (u.name?.toLowerCase() === name ||
              u.profile?.display_name?.toLowerCase() === name ||
              u.profile?.real_name?.toLowerCase() === name),
        );
        if (hit) return hit.id;
        cursor = body.response_metadata?.next_cursor || null;
      } while (cursor);
      throw new Error(`user not found: ${handle}`);
    },

    async postToSelf(userId, text) {
      // chat.postMessage accepts a user ID directly for the self-DM — avoids
      // conversations.open, which would require the extra im:write scope.
      const body = await call(token, "chat.postMessage", {
        channel: userId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return body.channel;
    },

    /**
     * Public thread reply as the user — only used after an explicit per-feature opt-in
     * (e.g. PR review confirmations). A channel with a webhook replies as the app instead.
     */
    async replyInThread(channel, threadTs, text) {
      const hook = resolveWebhook(webhooks, channel);
      if (hook) return postWebhook(hook, text, threadTs);
      await call(token, "chat.postMessage", {
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
    },

    /** Messages in a conversation since oldestTs — used to catch a manual "stop" reply in the self-DM. */
    async fetchMessagesSince(channelId, oldestTs) {
      const body = await call(
        token,
        "conversations.history",
        { channel: channelId, oldest: String(oldestTs), limit: "20" },
        { httpMethod: "GET" },
      );
      return body.messages ?? [];
    },
  };
}
