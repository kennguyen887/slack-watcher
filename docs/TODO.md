# TODO

## Security: Docker sandbox for claude worker

**Risk:** claude worker runs with `--dangerously-skip-permissions` and full filesystem access.
A crafted Slack message could steer the agent outside the worktree (prompt injection).

**Fix:** Run the worker inside a Docker container:
- Mount only the target worktree (read/write) + repos root (read-only)
- No access to `~/.ssh`, `~/.env`, host filesystem
- Network: allow GitHub + npm/pnpm registries only

Current attack surface is bounded (draft PRs only, grace window, small trusted team)
so this is acceptable until Docker is set up.
