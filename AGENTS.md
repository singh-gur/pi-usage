# AGENTS.md — pi-usage

Repo-scoped rules for agents working in `pi-usage`. The global rules in
`~/.pi/agent/AGENTS.md` still apply; this file adds project-specific context.

## Project

`pi-usage` is an independently implemented, read-only Pi extension package
that reports provider subscription quota (Codex, OpenCode Go, Z.ai, Kimi,
Grok) and OpenRouter key allowance through a `/usage` command and an additive
footer indicator.

- `PLAN.md` is the user-approved implementation plan. It is the source of
  truth for scope, contracts, phases, and verification. Do not implement
  outside approved scope; do not widen compatibility claims beyond the
  inspected Pi 0.85.1 API.
- Phase order is strictly sequential: Phase 1 → 2 → `/usage` visual refinement
  → 3 → 4. Start dependent work from the preceding accepted checkpoint.
- Scope changes go back through the plan workflow and require user approval
  before any code or tracking reflects them.

## Commands

Commands (pnpm 11.1.2, recorded in `packageManager`; build-script and run-check
decisions live in `pnpm-workspace.yaml`):

- `pnpm install --frozen-lockfile` — reproducible installs; commit `pnpm-lock.yaml`.
- `pnpm test` — `node --test test/*.test.ts`, synthetic data only.
- `pnpm run typecheck` — `tsc --noEmit`, no emitted runtime files.
- `pnpm run pack:check` — `pnpm pack --dry-run`; intended files only.

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
  separate explicit authorization. Plan approval or phase completion alone
  is insufficient.
- After a phase is accepted, commit the checkpoint and create a
  `pi-usage-phase-N` tag. Never move or overwrite an existing checkpoint tag.
- Shared branch, no parallel writers needed. Keep diffs minimal and scoped
  to the active plan task.

## Kaneo task tracking

Live execution progress is tracked in Kaneo through the Kaneo MCP tools
(`kaneo_*` native tools or the `kaneo` MCP gateway). Keep the board in sync
with reality throughout every work session. Approved scope lives in
`PLAN.md`; execution state lives in Kaneo. Never rewrite approved plan scope
to match board activity, and never treat board state as phase approval.

The plan has already been imported to Kaneo. Workspace: **Home Projects**;
project: **Pi Usage** (`fu8gwyw0lnnjl67qz5314gw5`). One task per phase plus
the approved blocking pre-phase-3 UI refinement, with implementation steps as
a checklist in each task description and a plan reference:

| Task | ID | Number |
| --- | --- | --- |
| Phase 1 — Working command with OpenCode Go and OpenRouter | `ewh2cdm81664ejrjozkvvkgn` | #1 |
| Phase 2 — Codex, Kimi, and Z.ai | `blyhyibkuiybaon7e054eemg` | #2 |
| Pre-Phase 3 — `/usage` visual refinement | `l2gmrcwc5c2r8acgsb06s68l` | #5 |
| Phase 3 — Grok subscription billing | `mj3yks2izvt70btmyvge73i4` | #3 |
| Phase 4 — Automatic footer and lifecycle hardening | `e9t8jlijlktz0n8zvctlp19d` | #4 |

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
- Ask before deleting tasks or moving work between projects. Do not
  automatically delete tasks for removed plan phases; propose a superseded
  disposition instead.
- After a timeout or uncertain create/update result, re-read the task
  before retrying. Never blindly repeat creates or comments.
- Report what actually succeeded after mutations; if a batch partially
  fails, list successful and unresolved operations with their task IDs.
- Do not upload secrets, credentials, tokens, or private data to Kaneo.

### Plan changes

When `PLAN.md` changes after approval: compare the plan against linked
Kaneo tasks, report added/changed/removed/ambiguous work, preview the
reconciliation batch, and apply it only after user approval. Keep
unapproved plan changes out of the tracked execution scope.

### Progress reports

When asked for status, show task IDs, work by state (completed / active /
blocked / not started), outstanding verification or user approvals, plan
drift, and the next ready task with why its prerequisites are satisfied.
Count tasks explicitly; never invent percentage-complete estimates.
