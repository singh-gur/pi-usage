# AGENTS.md — pi-usage

Repo-scoped rules for agents working in `pi-usage`. The global rules in
`~/.pi/agent/AGENTS.md` still apply; this file adds project-specific context.

## Project

`pi-usage` is an independently implemented Pi extension package
that reports provider subscription quota (Codex, OpenCode Go, Z.ai, Kimi,
Grok, GitHub Copilot, Anthropic) and OpenRouter key allowance through a `/usage` command
and an additive footer indicator. Package settings are managed through
`/usage-settings` and package-owned `pi-usage.json` files; project overrides
must remain trust-gated.

`/usage` places the active model's configured supported provider first and focuses
it on opening; other provider tabs keep their order and Current session stays last.
Unsupported or unconfigured active providers leave the default tab order unchanged.

`/usage` has a separate **Current session** tab with active-branch horizontal
bars by provider/model and input, output, cache read, and cache write. Provider
tabs show quota and provider reset availability, never session token charts. The shared additive `usage` status combines quota text
with only the cache-read percentage across all providers: cache-read tokens
as a share of all recorded session tokens, matching the session legend (not
an input-only cache-hit rate). Empty sessions show `cache read —`.
`showSessionBar` (default true) is retained as the visibility setting name for
compatibility; `/usage-settings` labels it **Cache read percentage**. It is
independent of `footerFormat`, which controls quota text and automatic quota
networking. Rebuild from Pi's public
`sessionManager.getBranch()` on lifecycle boundaries, never credential files
or provider requests. Include Pi v1's attributed `usage` entries (such as
cache warming), regardless of operation kind. Unattributed tool/summary usage
appears as "Other usage" inside Current session. Missing counts are partial,
not verified zeros; reasoning is already included in output. Very small shares
can round out of bars; exact counts remain in the session legends.

`/usage` offers `r` for source-derived Codex banked resets and Anthropic's
`juniper_tide` 5-hour offer only; selection and redemption both default to Cancel.
Resolve and revalidate credentials through Pi, recheck inventory before POST,
reject expired offers, serialize redemption, and never automatically retry an
uncertain mutation. Reset POST transport accepts only the inspected routes.
Refresh quota after every attempted POST. Codex full resets also restart the
weekly schedule; Anthropic's supported reset leaves weekly usage intact.
Z.ai reset-card inventory is read-only, with guidance to redeem/check expiry in
ZCode; no verified redemption contract is implemented. OpenCode Go and all other
providers have no reset action. No purchases, credential fallbacks, or live reset
requests during verification. All reset support is source-derived, not live-verified.
`resetThresholdPercent` defaults to 10 (integer 0–100; 0 disables notices).
Non-blocking notices require a confirmed available reset and an identified
5-hour window below the remaining threshold, cover the active provider only,
and are suppressed after one notice per credential/session and while `/usage`
is open. Existing footer-off and offline networking rules remain unchanged.
Per-provider switches live under a `providers` map in both scopes with
entry-level field merging (`poll`, `refreshAfterTurn`, `disabled`); a fully
`disabled` provider performs no requests ever and is absent from the footer
and `/usage` tabs entirely, never rendered as a deferred or stale state.
`/usage-settings` edits them through a Providers row that drills into a
provider list and a per-provider panel (Report usage, Timed refresh, Refresh
after turn); logic lives in `src/provider-settings-ui.ts`.

Cross-instance quota refreshes coordinate through per-account timing files in
the agent dir (`pi-usage-state/<provider>-<hash>.json`): per provider +
persistent-salted credential fingerprint they record only `lastRefreshAt`,
`backoffUntil`, and failure counts — never usage data or credentials (raw keys
and fingerprints must never appear in any persisted artifact). A matching
`.lock` file (exclusive create, owner token, 45 s staleness takeover) is held
across the whole refresh: state is read after acquiring it and written
(atomic rename) before releasing it, and release only removes a lock that
still carries the owner's token. Waiting claims poll up to 8 s. The lock
serializes same-account refreshes across running
instances; shared backoff is honored by every trigger including manual,
auto triggers skip when any instance captured within the last 60 s, and
coordination failures degrade to per-instance behavior without blocking or
failing a refresh. Coordination is wired only in the extension entry point,
so tests keep the default uncoordinated monitor.

Automatic refreshes make one request per provider: the reset inventory is
fetched only for `/usage` refreshes, or when the 5-hour window is below the
notice threshold (only the low-quota notice uses it). Anthropic's usage
endpoint is undocumented and reportedly rate-limits generic User-Agents almost
immediately (community reports, not verified here), so its usage reads send
`user-agent: claude-code/2.1` (never on the reset mutation route; Pi exposes no
Claude Code version, so keep it major.minor) and its failure backoff caps at
15 min via `QuotaAdapter.maxBackoffMs` instead of the global 5 min.

GitHub Copilot (`github-copilot`) reports the main allowance only,
percentage-based, from the undocumented `api.github.com/copilot_internal/user`
endpoint using the Pi-resolved OAuth session token. Its account-specific
OAuth origins are the sole accepted alternate routing (`allowedOAuthOrigins`);
support is not live-verified until the user reports a sanitized comparison
for that account class. Custom enterprise hosts, token exchanges, and
credential fallbacks are out of scope; if the token is rejected, stop and
record the blocker instead of widening auth access.

Target Pi v1 with `^1.1.0` peer/dev dependency ranges. Compatibility is
inspected and synthetically tested against Pi 1.1.0; do not imply live provider
verification or independently verified support for other releases.

README screenshots live in `assets/screenshots/` and depict real UI output
with synthetic data, not live account verification. The README and `pi.image`
gallery metadata use absolute GitHub raw URLs; push the assets before publishing
a package that references them. These images are not bundled in the npm tarball.

## Commands

Commands (pnpm 11.1.2, recorded in `packageManager`; build-script and run-check
decisions live in `pnpm-workspace.yaml`):

- `pnpm install --frozen-lockfile` — reproducible installs; commit `pnpm-lock.yaml`.
- `pnpm test` — `node --test test/*.test.ts`, synthetic data only.
- `pnpm run typecheck` — `tsc --noEmit`, no emitted runtime files.
- `pnpm run pack:check` — `pnpm pack --dry-run`; intended files only.
- `PI_OFFLINE=1 pnpm exec pi --no-extensions -e ./examples/session-preview.ts` —
  synthetic UI preview; open `/usage-demo`, no paid requests or quota calls.
- `pnpm exec pi --no-extensions -e ./src/index.ts --resume` — try the working tree
  against a locally selected session, without installing or loading the
  published copy. Use `PI_OFFLINE=1` to suppress quota networking.

Add/remove dependencies only through pnpm, never by editing `package.json`
or the lockfile directly. Use TypeScript strictness without a runtime build
step; Pi loads TypeScript extension entry points directly.

## Verification policy

- Tests use synthetic payloads and mocked fetch/Pi APIs. Never make live
  authenticated quota calls or paid model requests as part of verification.
- Never treat an untested live endpoint or source-derived claim as a verified
  account result. User dashboard comparisons happen locally; request only
  sanitized discrepancies.
- If the installed Pi API differs materially from the inspected contract,
  stop and report instead of reaching into private credential APIs.
- Never read credentials, `.env*`, kubeconfigs, or auth files to make a
  provider adapter work. Adapters consume Pi's public auth APIs only.

## Git and checkpoints

- Installation changes, commits, tags, pushes, and publication require
  separate explicit authorization.
- Never move or overwrite an existing tag.
- Shared branch, no parallel writers needed. Keep diffs minimal and scoped
  to the active task.

## Kaneo task tracking

Live execution progress is tracked in Kaneo through the Kaneo MCP tools
(`kaneo_*` native tools or the `kaneo` MCP gateway). Keep the board in sync
with reality throughout every work session; never treat board state as phase
approval.

The completed phased implementation is tracked in workspace **Home Projects**,
project **Pi Usage** (`fu8gwyw0lnnjl67qz5314gw5`):

| Task | ID | Number |
| --- | --- | --- |
| Phase 1 — Working command with OpenCode Go and OpenRouter | `ewh2cdm81664ejrjozkvvkgn` | #1 |
| Phase 2 — Codex, Kimi, and Z.ai | `blyhyibkuiybaon7e054eemg` | #2 |
| Pre-Phase 3 — `/usage` visual refinement | `l2gmrcwc5c2r8acgsb06s68l` | #5 |
| Phase 3 — Grok subscription billing | `mj3yks2izvt70btmyvge73i4` | #3 |
| Phase 4 — Automatic footer and lifecycle hardening | `e9t8jlijlktz0n8zvctlp19d` | #4 |

Post-v1 standalone work:

| Task | ID | Number |
| --- | --- | --- |
| Package settings mechanism | `kq5v82gmkqmr8nna88lj7odg` | #6 |
| GitHub Copilot provider (`plans/github-copilot.md`) | `f8nff61ksk7p3621svfwz639` | #7 |
| README refresh and package gallery screenshots | `gw90cg6mfw89hbvjr7q1b8b7` | #8 |

Do not re-import or create duplicate phase tasks; always reuse these IDs.
Add subtasks only when a step needs independent ownership, blocking, or
verification.

### Keeping tasks in track during work

Column slugs in this project: `to-do`, `in-progress`, `in-review`, `done`
(`done` is final). Column lifecycle:

1. Before starting any phase work, fetch the matching task by the ID above
   — never by title alone — and read its current state before editing.
2. Move the task to `in-progress` the moment execution actually starts.
3. Check off implementation steps only when completion is supported by
   inspected evidence (files created, commands passing). Distinguish
   checks the agent ran from outcomes the user reported.
4. Add a concise comment for meaningful events: verification results with
   commands and outcomes, blockers with cause and unblock condition, and
   material decisions. No repetitive status-only comments.
5. When required verification passes but the user has not yet accepted the
   phase, move the task to `in-review` and comment "awaiting user
   confirmation". It stays there until acceptance.
6. Move a phase task to `done` only after both its required verification
   passed AND the user explicitly accepted the phase. Passing tests alone
   is never phase completion.
7. Strike through or explicitly mark skipped/superseded steps with the
   reason. Never present skipped work as done.
8. When blocked, record the cause, affected work, and the unblock
   condition in a comment (no dedicated blocked column exists).

### Hygiene

- Reuse the existing phase task IDs above; never create duplicates. Ask
  when a renamed phase makes identity ambiguous.
- Change only intended fields. Preserve human notes, checklist progress,
  assignments, and unrelated description content.
- Never assign people, due dates, or priorities that were not requested,
   and never invent them to make the board look complete.
- Ask before deleting tasks or moving work between projects.
- After a timeout or uncertain create/update result, re-read the task
  before retrying. Never blindly repeat creates or comments.
- Report what actually succeeded after mutations; if a batch partially
  fails, list successful and unresolved operations with their task IDs.
- Do not upload secrets, credentials, tokens, or private data to Kaneo.

### Progress reports

When asked for status, show task IDs, work by state (completed / active /
blocked / not started), outstanding verification or user approvals, and the
next ready task with why its prerequisites are satisfied.
Count tasks explicitly; never invent percentage-complete estimates.
