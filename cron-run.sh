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
pgrep -f "node $DIR/src/index.js --once" >/dev/null && exit 0
exec node "$DIR/src/index.js" --once
