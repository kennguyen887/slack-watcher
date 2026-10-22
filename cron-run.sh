#!/bin/sh
# One watcher poll per cron tick — the cron-mode entrypoint (`*/3 * * * *`).
# Skips the tick while a previous poll is still running (a worker can take far
# longer than the cron interval). macOS ships no flock(1), so the guard greps
# the process table for this checkout's node invocation instead; it cannot
# wedge permanently because every stage inside a poll is bounded (slack fetch,
# git, and claude runs all carry timeouts).
#
# The crontab entry must provide a PATH containing node, claude, and gh, e.g.:
#   */3 * * * * PATH=$HOME/.nvm/versions/node/v22.22.3/bin:/usr/local/bin:/usr/bin:/bin /path/to/slack-watcher/cron-run.sh >> /path/to/slack-watcher/logs/watcher.log 2>&1
DIR="$(cd "$(dirname "$0")" && pwd)"

# Office hours only: WATCH_DAYS (ISO weekday range, 1=Mon) and WATCH_HOURS ([from, to) local
# hours) from .env, default Mon–Fri 09:00–19:00. Gated here rather than in node so an
# off-hours tick costs a `date`, not a node start. Nothing is lost while it sleeps: the first
# poll back scans the last MENTION_LOOKBACK_HOURS, which must cover the weekend gap.
env_or() { v=$(sed -n "s/^$1=//p" "$DIR/.env" 2>/dev/null | tail -1); echo "${v:-$2}"; }
days=$(env_or WATCH_DAYS 1-5)
hours=$(env_or WATCH_HOURS 9-19)
day=$(date +%u)
hour=$(date +%H | sed 's/^0//')
[ "$day" -ge "${days%-*}" ] && [ "$day" -le "${days#*-}" ] || exit 0
[ "$hour" -ge "${hours%-*}" ] && [ "$hour" -lt "${hours#*-}" ] || exit 0

pgrep -f "node $DIR/src/index.js --once" >/dev/null && exit 0
exec node "$DIR/src/index.js" --once
