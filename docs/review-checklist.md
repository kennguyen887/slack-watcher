# PR review hunt list

Injected verbatim into every PR-review worker prompt. Edit this file to change what the
reviewer hunts for — no code change needed. Keep it dense: every line costs prompt budget
and attention. Add a class only when a real bug of that class shipped past a review.

## Stance

Most code you review here was written by an AI assistant, working from the same rulebook and
the same priors as you. That means it **compiles, reads plausibly, and matches the surrounding
style** — and none of that is evidence it is correct. "This looks like how the rest of the
codebase does it" is the trap: the pattern it copied may be stale, or may not fit this schema.

So: **do not ask "does this look right?" Ask "with real data, what value flows through this
line, and is that value correct?"** Pick concrete inputs — a null, a `0`, an empty array, a
second concurrent caller, a user from another company — and trace them through.

Assume the diff contains at least one defect until you have traced every changed file and
failed to find one. Finding nothing is a valid outcome, but it must be the *result* of the
hunt, not the starting position.

## A. AI-authored code — the failure modes that survive a plausibility read

- **Copied pattern, wrong schema.** A field/shape lifted from a sibling module that does not
  exist (or is named differently) here — `zipcode` vs `zipCode`, `user.company` vs
  `user.profile.company`. Open the type/entity/migration and confirm the field exists.
- **The copied pattern was already broken.** Check the source it was copied from actually works
  before accepting it as precedent.
- **Fixed at one call site.** A bug fixed in one function while identical sibling call sites keep
  it. `grep` the changed helper's other callers, and every other builder of the same payload.
- **Guard instead of root fix.** A new `?.`, `|| {}`, `try/catch`, or default value that makes a
  symptom disappear while the real producer keeps sending bad data. Ask where the bad value
  comes from; if the producer is in this repo and holds the right data, the guard is the bug.
- **Invented API surface.** A method, option, or env var that does not exist on the real library
  version. Check `package.json` version + the actual export.
- **Confidently wrong comment/docblock.** A docblock that states an invariant the code below does
  not hold (e.g. "changes exactly when X changes" over a key that ignores X). The comment is the
  claim; verify it against the code.
- **Plausible dead branch.** A condition that can never be true (or never false) with real data —
  so the "handled" case is not handled at all.

## B. Values and data

- **Falsy-vs-missing.** `value || fallback` where `0`, `""`, or `false` is legitimate data —
  a real `0` renders as `"-"`, a real `false` flips to the default. Needs `??` or an explicit check.
- **Optional field dereferenced.** A field the type marks optional, or that an event/webhook
  payload may omit, used without a guard — or rendered into a URL as `tel:undefined`.
- **Cache / memo / query key not unique to the entity.** Two different entities colliding on one
  key serves the first one's data to the second for the whole stale window. Check every key
  built from non-identifying values (counts, states, indexes).
- **Money in floats.** New money column or arithmetic in `float`/`double`, or rounding per step
  instead of once at the boundary.
- **Date/timezone.** Naive local-time construction, `DATE(col)` in SQL, UTC vs local mismatch
  across a boundary.
- **Off-by-one / boundary** on pagination, slicing, ranges.

## C. Contracts and compatibility

- **Response shape changed** — field renamed, removed, nested, or its type widened — while the
  current production client still reads the old shape.
- **Status codes / error bodies** changed on a path a client branches on.
- **Event or queue payload changed** without the consumer updated in the same PR, or a producer
  now emitting a second, different shape onto the same channel.
- **Env var used but not added** to `.env.example` and the config schema — the app boots locally
  and dies on deploy.
- **Route / redirect / import target that does not resolve** (mind framework path prefixes).
- **Removed code that was load-bearing.** A deleted cron/backfill/job: verify the normal write
  path actually populates that data; a comment calling it "one-off" is not evidence.

## D. Async, DB, performance

- **Sequential independent `await`s** that should be one `Promise.all`.
- **`await` inside a loop** over a collection — N+1 round trips.
- **Missing `await`** on a promise whose result or failure matters — a floating rejection, or a
  response sent before the write commits.
- **Unbounded query** — a list endpoint or cron with no `LIMIT`, or `select *` dragging
  blob/JSON columns into a loop.
- **`OR` across different columns / `orWhereNull` chains / a function-wrapped column** in a WHERE
  on a large table — full scan.
- **Multi-write flow with no transaction**, or a helper inside the transaction that quietly uses
  the base connection instead of the trx.
- **External call (HTTP, vendor SDK, email) inside a transaction.**
- **Read-decide-write with no lock** where a second concurrent actor can interleave — should be
  one atomic `UPDATE ... WHERE <expected state>` with an affected-rows check.
- **Outbound call with no timeout** — SDK defaults are usually far longer than the caller's deadline.

## E. Security and access control

- **Missing authorization check** on a new endpoint/handler, or an ownership/tenant filter that
  the query drops — user A can read or mutate user B's row.
- **Trusting a client-supplied id** (userId, companyId, role) instead of the session identity.
- **Secret, token, or PII in a log line, error body, or committed file.**
- **Unescaped user input** into SQL, HTML (`dangerouslySetInnerHTML`), or a shell command.
- **A new public/CORS/allow-list surface** wider than what the change needs.

## F. Reliability

- **Handler not idempotent** — a webhook/queue/cron redelivery doubles a charge, an award, a row.
- **Scheduled job with no overlap guard or max-tries.**
- **Non-idempotent migration** (`ALTER` with no `hasColumn` guard) that breaks a re-run.
- **`catch` that swallows** — empty, or log-and-continue where the failure leaves a silent data gap.

## G. Test files the PR ADDS — or GROWS (the one non-bug class worth reporting)

Judge **every test file the PR adds, and every existing one it grows** (`*.test.*`, `*.spec.*`,
anything under `__tests__/`) — this class is missed when you only read the source diff.

A grown one hides behind a plain `modified` entry in `--name-only`, so use `gh pr diff <n> --stat`:
a test file that gained a large chunk (new `jest.mock` calls, a dozen new cases) is the same class
as a new one, and it is how mirror-test bloat actually accumulates after the file first lands.
For a file that predates the PR, say so in the comment — the fix is still `git rm`, but the author
inherited it rather than wrote it.

This is the one reportable class with **no wrong output to trace**, so the verify gate for it is a
different question: *what real breakage would this file catch?* If the answer is "none", it is junk.
Never drop it for lacking an inputs → wrong-result trace.

That gate is the whole verdict — **open the file and answer it; never judge junk off the shape.**
A pile of `jest.mock` calls is not the test: a component holding real branch logic (route/prefix
matching, role or tenant gating, menu state) driven through real interactions has to mock its env
and its unrelated children, and it is NOT junk. Name the breakage it would catch, or call it junk —
one or the other, from the file's contents.

Junk = a test file mirroring each source file (one per component / util / service / hook), a whole
extra file for one more case, asserting config values or constants, asserting the options a module
just set, only proving a mock was called, or a mock/jest-config entry that exists solely to serve
those tests. They catch no real breakage, must be maintained forever, and bury the one test that
would — that is the impact to state.

**Judge what the file drives, not what it is named.** A `…Page.test.tsx` that mounts one component
with the router, the hooks, and every child mocked is a mirror test, not a page-level test, however
page-ish the filename (`components/manage-land/__tests__/ManageLandPage.test.tsx` is a mirror test).
Real page/route-level = it goes through the actual route entry with only the network stubbed.

Report the whole class as **ONE** comment on the worst offender. In that comment: list EVERY file
to delete as a `git rm` snippet, name the jest.config / mock entries to drop with them, and say
where the behaviour belongs instead (the page/route-level test).

Never flag a test the PR **deletes** alongside the source it covered — that is correct.
An existing repo already full of the same pattern is context worth mentioning, never a reason to
let the new ones pass.

## Do NOT report

Style, naming, formatting, log wording, import order, duplication, a declared-but-unread
prop/field/variable (that is dead code, not a bug), "consider extracting", "add a comment",
"might be nice to", praise, or a summary of what the PR does. If the worst thing you can say
about a line is that you would have written it differently, say nothing.
