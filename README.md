# slack-watcher

A personal Slack → Claude Code automation daemon. It watches Slack for messages that need you and turns them into work.

## Features

| Incoming message | What the watcher does |
|---|---|
| "@you fix the price filter on the listing page" | Spawns a headless [Claude Code](https://claude.com/claude-code) worker in a **disposable git worktree** → implements the fix → runs tests/lint → opens a **draft PR** targeting your integration branch |
| "Please review this PR: github.com/…/pull/123" (mention optional) | Reviews the PR → posts **inline comments on the exact changed lines** with ```suggestion``` blocks (real bugs only, minor nits skipped, plain English) → replies in the Slack thread; a clean PR gets an **approving review** instead, so the author can merge |
| "@you I updated them" (a reply in a thread whose PRs were already reviewed) | **Resumes the very session that reviewed each PR** in its kept worktree → verifies each earlier finding is really fixed in the new commits → comments on what is still broken, or approves and replies "Re-checked the update — LGTM!" |
| "@you fix the bug" (too vague) | DMs you 1-3 ready-to-send clarifying questions instead of guessing |
| "a ơi cái legacy-api này sửa trên branch nào?" | Researches the answer in the repos, then **replies in the thread as you, in your own learned voice** — Vietnamese teammates only, and only when it verified the answer and nothing needs your decision |
| "Hey, do you think this is feasible?" (English) | Left to you — DM'd as a heads-up, never auto-answered. English is where clients and other teams live |
| "@you when do we deploy?" (a call only you can make) | DM'd to you with a draft; nothing is posted |
| "thanks @you!" / FYI / status update | Ignored — nothing happens |

### Review spec — what a model picks, versus what a pipeline picks

A reviewer model handed "review this PR" is good at judging a change and bad at choosing what to
look at: on a large diff it quietly reads some files and not others, and it judges each one against
whatever bar it happens to recall. Those two steps are not model work, so the watcher runs
[Open Code Review](https://github.com/alibaba/open-code-review)'s `ocr delegate` first — no model, no
API key, a couple of seconds — and hands the worker:

- **a closed file list** — the PR's changed files with tests, generated code, vendored trees,
  lockfiles and secret paths already filtered out, so coverage is decided by a pipeline rather than
  by attention, and the worker is told to cover every file on it;
- **the checklist that applies to each file**, resolved per path from [`ocr/rule.json`](ocr/rule.json) —
  frontend files get the request-count, bundle-bytes and hydration checks, backend files get N+1,
  transaction, idempotency and bounds checks, migrations get idempotency and money-precision checks.

`ocr/rule.json` **replaces** Open Code Review's built-in ruleset rather than extending it: the
built-in rules ask for typos, dead code, duplication and `var`/`==` nits, which are exactly the
comments this reviewer must never post.

Frontend unit tests are treated as weight the team decided not to carry. The reviewer never asks for
one, never counts "this is untested" as a finding, and when a PR **adds** a frontend test file it
posts a single comment asking for the file to be deleted. Backend suites are untouched by this: the
`include`/`exclude` pair in `ocr/rule.json` splits them by where they live — a repo's own root
`test/` or `tests/` directory is a backend suite and stays out of review entirely, while a frontend
test sitting beside its source or under `__tests__/` is pulled back into scope so it can be flagged.
A frontend test the PR only *modifies* is left alone; deleting a file the PR did not create is not
that PR's job.

The review still runs on `REVIEW_MODEL` (opus by default), still posts inline comments on the exact
changed lines, and still approves a clean PR. Nothing about the flow changes; the worker just starts
from a resolved spec instead of an open-ended diff. Without `ocr` installed it falls back to reading
the diff unaided — degraded, never broken.

Built-in guardrails and quality-of-life:

- **Near real-time without a server or admin rights** — polls Slack search with your own user token (default 45 s); no Slack app install to the workspace, runs on your machine via launchd (starts at login, auto-restarts).
- **Reads the whole conversation** — pulls the thread or nearby messages, so requests split across several short messages are understood as one.
- **Answers your Vietnamese teammates in your own voice** — `npm run learn-style` reads back through your own Slack history, throws away everything the watcher itself wrote, and distills how you actually type (length, particles, pronouns, which words you never translate) into a local style profile. Answers are researched in the real code before being written, and only a *verified* answer that needs no decision from you is posted; anything else lands in your DMs as a draft. English-speaking teammates are never auto-answered — that line is a language gate, not a translation setting.
- **Sees attachments** — downloads screenshots and small log/text files from the message (where bug reports usually live) and feeds them to the worker; the classifier only sees a cheap text marker, so vision cost is paid once, by the worker, only when files exist.
- **Grace window + kill switch** — DMs you "starting in N min, reply `stop` to cancel" before doing anything; replying `stop` also works **while the worker runs** (checked every 20 s) and kills the Claude session immediately, discarding the worktree.
- **A review covers only what the mention asked for** — the PR links in the message itself, else the ones in its thread, else the requester's own nearby messages; a PR another teammate posted in the channel minutes earlier is never swept into the same review or its thread reply.
- **Duplicate-work check** — scans open PRs, recent commits, and thread replies before writing code; never reviews its own or already-reviewed PRs (an author's "updated" reply in a reviewed thread doesn't re-review from scratch — it resumes the recorded session, which re-checks only the update).
- **Your working copy is sacred** — workers only ever touch isolated worktrees under `worktrees/`; drafts only; nothing public without the grace gate.
- **Pick up where the worker left off** — every code/review worker runs under a known session id in a worktree that survives the run. On macOS the finished session is auto-imported into the **Claude desktop app** (via its `claude://resume?session=<id>` deep link), so it just shows up in the app's session list, titled after the job (`Review commonground PR #2523`, `Code listings-api — <summary>`, `Auto-fix <repo> — <alert>`); every worker starts in ONE shared folder (`WORKER_SESSIONS_DIR`, default `../slack-bot` next to this repo) and reaches its worktree through `--add-dir`, so the app lists all of them under a single `slack-bot` group instead of one group per worktree. The DM also gives you `cd <sessions dir> && claude --resume <session-id> --add-dir <worktree>` for the terminal. A worktree is removed as soon as its PR is merged or closed (nothing is left to resume); the rest auto-prune after `WORKTREE_KEEP_DAYS` (default 1) day of inactivity, and only the newest `WORKTREE_KEEP_MAX` (default 6) are kept at all — the cap is what keeps `worktrees/` from growing with review volume.
- **Full visibility** — stage-by-stage DMs, streamed worker progress in the console log, and a `history.jsonl` audit trail.
- **Manual send CLI** — fire off any message to a channel or DM in one command, with guards where it matters: transient network/5xx failures retry instead of losing the message, `--cap N` refuses over-length messages (default 2000), and an optional `SEND_ALLOWED_TARGETS` allowlist refuses unlisted targets — sends have no delete API, so a bad one can only be prevented, not recalled.
- **Post as an app, not as you, per channel** — `SLACK_WEBHOOKS` maps a channel to an incoming-webhook URL; anything sent there (by `send.js`, by an external script piping into it, or by a review's thread reply) goes out as the webhook's app instead of your account. Everything else is untouched, DMs always stay on your token, and `send.js` names the transport it used on every send.

## Requirements

- macOS (launchd; the watcher itself is portable Node, `install.sh` is Mac-specific)
- Node ≥ 18 (no npm dependencies)
- [Claude Code CLI](https://claude.com/claude-code) (`claude`) logged in
- [GitHub CLI](https://cli.github.com) (`gh`) logged in
- *(Optional, recommended)* [Open Code Review](https://github.com/alibaba/open-code-review) — `npm install -g @alibaba-group/open-code-review`. Reviews work without it; see **Review spec** below for what it adds
- A Slack **user token** (`xoxp-…`) — see below

## Setup

1. **Slack token**: create an app at api.slack.com/apps → OAuth & Permissions → **User Token Scopes**: `search:read`, `chat:write` (required) + `channels:history`, `groups:history`, `im:history`, `mpim:history` (conversation context) + `files:read` (read attached screenshots/logs) + `users:read` (DM by username via `send.js`) → Install to Workspace → copy the **User OAuth Token**. Step-by-step guide with official links: [docs/slack-user-token-xoxp-how-to-create-it-and-use-it-in-node-js.md](docs/slack-user-token-xoxp-how-to-create-it-and-use-it-in-node-js.md).
2. ```bash
   cp .env.example .env   # set SLACK_USER_TOKEN, BASE_BRANCH, PR_SEARCH_QUERY, ...
   ```
3. Test without side effects:
   ```bash
   DRY_RUN=1 node src/index.js --once
   ```
   The first run sets the baseline to "now" — old mentions are never processed. Dry runs don't consume mentions.
4. *(Optional, for auto-answering)* Teach it your voice, then turn the answering on:
   ```bash
   npm run learn-style          # reads back through your own Slack messages
   ```
   It writes `style/profile.md` (gitignored — it is distilled from real conversations). Set
   `QUESTION_AUTO_REPLY=1` in `.env` to let it answer Vietnamese teammates in-thread as you;
   without the profile it only ever drafts privately. Re-run it whenever your voice drifts.
5. Install as a login agent — one poll per tick, so a `git pull` deploys itself on the next run:
   ```bash
   ./install.sh
   tail -f logs/watcher.log
   ```
   Uninstall: `./uninstall.sh`.

   > **macOS: use the LaunchAgent, not `crontab`.** The worker's `claude` CLI reads its OAuth token from the login Keychain, which only your GUI login session can unlock. A crontab entry runs outside that session, so every worker fails with `Failed to authenticate: OAuth session expired` even though `claude` works fine in your terminal. `install.sh` installs a `gui/<uid>` LaunchAgent that runs `cron-run.sh` every 180s — same one-shot model, but with Keychain access.

## How it works

```
poll (45s) ──► search.messages: mentions of you  ──┐
          ──► search.messages: PR links (your org) ─┤─► dedupe (state.json)
                                                    ▼
                              fetch thread / nearby messages as context
                                                    ▼
                       classify (claude haiku): code_request │ pr_review │
                    needs_clarification │ question │ ignore
                                                    ▼
            DM "picked up — starting in N min, reply stop to cancel"
                                                    ▼
              disposable git worktree from origin/<BASE_BRANCH>
                    (questions skip this — they only read)
                                                    ▼
          reviews only: ocr delegate ──► file list + per-file checklist
                   (no model, no API key — see "Review spec")
                                                    ▼
        claude -p worker (streamed progress in console log) ──► draft PR /
        inline review comments / in-thread answer in your voice ──► result DM
```

Safety properties:

- **Your working copy is never touched** — workers run in isolated `git worktree`s under `worktrees/`, kept for `WORKTREE_KEEP_DAYS` days and capped at the newest `WORKTREE_KEEP_MAX` (so recent sessions stay resumable without the folder growing unbounded), then pruned automatically on startup.
- **Nothing public without a gate** — PRs are drafts; every public action (review comments, the "added comments" thread reply, and an auto-answer) sits behind the grace window ("reply `stop` to cancel"). An auto-answer clears four more gates on top: Vietnamese only, a learned voice must exist, the worker must have verified the answer and judged that it needs no decision from you, and it must fit `ANSWER_MAX_CHARS` — anything else becomes a private draft. The answer worker also runs with the file-editing tools denied at the CLI, because unlike the code and review workers it reads your real working copies rather than a disposable worktree.
- **Duplicate-work protection** — grace window for "I'm already on it", plus the worker checks open PRs / recent commits / thread replies before writing code, and never reviews its own or already-reviewed PRs.
- **A bad poll never eats a request** — a mention whose processing throws (expired CLI login, spend limit, timeout) stays queued and is retried on later polls, up to `MENTION_MAX_ATTEMPTS` (default 5); retrying is safe because the review worker never re-reviews a PR it already commented on. You get a DM on the first failure and on the give-up, and `npm run retry -- <channelId>:<messageTs>` puts an abandoned one back in the queue.
- **Audit trail** — every processed message is appended to `history.jsonl`; live worker progress streams to `logs/watcher.log`.

⚠️ **Understand the risk**: workers run `claude -p --dangerously-skip-permissions` with write access to your repos, triggered by incoming Slack messages. Anyone who can mention you can start a worker (it only ever opens draft PRs, but still). Run it only in workspaces you trust, or set `WORKER_CLAUDE_ARGS=--permission-mode acceptEdits` for a read-mostly mode that stops at push/PR steps.

## Manual sending (`src/send.js`)

```bash
node src/send.js "#dev-channel" "deployed, please verify"
node src/send.js "@teammate" "PR is up: <link>"      # needs users:read
echo "multiline..." | node src/send.js "#channel" -
```

## Structure

One file = one concern; handlers split per mention kind, routed by a plain map.

| File | Purpose |
|---|---|
| `src/index.js` | Poll loop, mention filtering/dedupe, route `kind → handler` |
| `src/config.js` | `.env` loading + validation (fail fast) |
| `src/classify.js` | Mention classification via a cheap model |
| `src/handlers/` | One file per kind; `shared.js` = grace window, thread-ts, trim; `index.js` = route map |
| `src/slack.js` | Slack Web API client (search, post, context fetch, 429 retry) |
| `src/claude.js` | `claude -p` runner with streamed progress |
| `src/git.js` | git exec + disposable worktree create/remove |
| `src/repos.js` | Repo discovery + doc-sourced repo hints |
| `src/github.js` | PR URL parsing, PR/CI status, review reconciliation |
| `src/ocr.js` | Open Code Review's `ocr delegate` → the review spec block (file list + checklist) |
| `ocr/rule.json` | The review bar itself, per file type — what to report, what to stay silent about |
| `src/send.js` | Manual send CLI |
| `src/style.js` | Loads the learned voice (`style/profile.md`, gitignored) |
| `src/style-learn.js` | `npm run learn-style` — harvests your own messages and distills the profile |

Handlers share one signature: `handle(ctx)` with `ctx = { mention, classification, contextBlock, config, slack, selfId }`. Adding a new mention kind = one new handler file + one entry in the `HANDLERS` map + one line in the classifier prompt.

## Operational notes

- Slack search renders mentions as `<@U123|Display Name>` — the watcher matches both forms. If mention search returns nothing in your workspace, set `SLACK_SEARCH_QUERY=@YourName`.
- Re-run a processed message: remove its `channel:ts` key from `state.json`'s `processed`, set `lastTs` just below its ts, restart the agent (`launchctl kickstart -k gui/$(id -u)/com.slack-watcher`).
- Leftover worktrees after a crash: `git -C <repo> worktree list`, then `git worktree remove --force <path>`.
- Log timestamps are UTC+7 by default — change `UTC_OFFSET_HOURS` in `src/log.js`.

## Disclaimer

This tool automates real actions under your identity — draft PRs, review comments, and drafted replies. However, we still recommend that users review and take ownership of the messages before sending them, rather than relying entirely on the AI-generated response.

## License

MIT
