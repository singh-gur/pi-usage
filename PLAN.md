# Implementation Plan: pi-usage

## Overview

Build an independently implemented, read-only Pi package for provider-reported subscription quota and OpenRouter key allowance. `/usage` refreshes all configured supported providers; an additive footer indicator shows remaining allowance for the active provider, reset countdown, and freshness.

This plan is user-approved. Phases 1–2 and the pre-phase-3 UI refinement are implemented and user-accepted; phases 3–4 are pending. Approval to save this plan does not authorize installation changes, commits, checkpoint tags, pushes, or publication.

## Planning Profile

- Executor: Workhorse — implementation-level contracts and dependency-ordered tasks.
- Detail: Standard.
- Feedback: Standard — confirm material decisions and phase completion.
- Mode: Phased, with four independently verifiable checkpoints.
- Destination: `PLAN.md`.

## Global Context

### Observed repository and runtime facts

- Repository: `pi-usage`; remote: `git@github.com:singh-gur/pi-usage.git`.
- Planning baseline: clean `main` at `b24203b7c5bd3cd02ae9e4d540017db4dc338edf`.
- Before this plan, the only tracked file was `README.md`, containing `# pi-usage`.
- No repository-scoped `AGENTS.md`, package manifest, dependencies, implementation, or tests existed.
- Inspected runtime: `@earendil-works/pi-coding-agent` 0.85.1 and Node 24.16.0.
- Pi supports TypeScript extension entry points declared by `package.json` under `pi.extensions`; no runtime compilation step is necessary.
- Public APIs verified: `registerCommand`, `ctx.modelRegistry.getProviderAuth`, `getProviderAuthStatus`, `getProvider`, `getAll`, `isUsingOAuth`, `ctx.ui.custom`, `setStatus`, and session/model/agent-settled lifecycle hooks.
- The provider-response event exposes status and headers but does not provide a universal subscription-quota contract. This package uses dedicated quota endpoints, not inference-response interception.
- Delegated research could not start because the installed background runner could not resolve Pi server/client runtime dependencies. The user explicitly approved direct research instead. No child findings or live account results are assumed.

### Approved scope

- Codex through a ChatGPT subscription.
- OpenCode Go subscription.
- Z.ai global Coding Plan.
- Kimi Coding membership.
- Grok subscription through Pi OAuth.
- OpenRouter key allowance and reported spending.
- One currently configured account per provider.
- All configured supported providers in `/usage`; active provider only in the footer.
- Read-only undocumented provider endpoints are acceptable with validation and explicit errors.
- Independent implementation; existing projects are protocol references, not a codebase to fork or copy.
- Local installation for development and Git-based Pi package installation for use.
- A responsive, tabbed, reference-style `/usage` dashboard: one configured provider per tab; Pi-themed headings; consumed/remaining bars where a ratio is safe; remaining values at right; reset details below; and retained domain, freshness, exact-value, partial, and error semantics.

### Out of scope

Historical token/cost analytics, databases, persistent quota history, standalone dashboards, separate login flows, direct credential-file access, browser scraping, multiple accounts per provider, account switching, quota redemption, purchases, automatic model routing, popup warnings, npm publication, and shared cross-process caching.

## Architecture Decisions

### Package and files

Use TypeScript, Node built-ins, Pi's public APIs, and native `node:test`. No runtime dependencies beyond the Pi packages required by the UI/integration. Do not bundle Pi itself.

Target Pi 0.85.1 and Node 24.16+ initially. Declare Pi peer dependencies with `*` ranges as the inspected package documentation requires; develop and verify against the inspected Pi API. Do not imply untested compatibility with older Pi releases. Use pnpm 11.1.2 for repository dependency changes, lockfile generation, and development commands; record it in the package's `packageManager` field. Commit `pnpm-lock.yaml` and use `pnpm install --frozen-lockfile` for reproducible installs. Pi's own package installation workflow remains unchanged.

| Path | Action | Purpose |
| --- | --- | --- |
| `package.json` | Create | ESM package, Pi extension manifest, engine requirement, package allowlist, scripts, dependencies |
| `pnpm-lock.yaml` | Generate through pnpm | Reproducible dependency resolution |
| `tsconfig.json` | Create | Type-check TypeScript without emitting runtime output |
| `.gitignore` | Create | Exclude dependencies and generated local artifacts |
| `src/index.ts` | Create | Extension factory, command, lifecycle integration |
| `src/types.ts` | Create | Normalized allowance results and explicit error states |
| `src/auth.ts` | Create | Pi auth resolution and official-origin validation |
| `src/http.ts` | Create | Bounded, cancellable read-only HTTP |
| `src/providers/opencode-go.ts` | Create | OpenCode Go adapter |
| `src/providers/openrouter.ts` | Create | OpenRouter key allowance adapter |
| `src/providers/codex.ts` | Create | Codex subscription adapter |
| `src/providers/kimi.ts` | Create | Kimi Coding adapter |
| `src/providers/zai.ts` | Create | Z.ai Coding Plan adapter |
| `src/providers/grok.ts` | Create | Grok subscription billing adapter |
| `src/refresh.ts` | Create | Cache, deduplication, refresh scheduling, backoff |
| `src/ui.ts` | Create | Dismissible command view and additive footer status |
| `test/providers.test.ts` | Create | Synthetic provider payload checks |
| `test/runtime.test.ts` | Create | Authentication, HTTP, cache, and scheduler checks |
| `test/extension.test.ts` | Create | Command, lifecycle, mode, and rendering checks |
| `README.md` | Modify in phase 4 | Installation, usage, supported data, limitations |
| `PLAN.md` | Update during execution | Task progress, verification, phase acceptance |

Use small functions and a fixed provider list rather than a plugin framework or class hierarchy. Pure normalization functions should be testable independently of Pi and HTTP. Use Pi's existing TUI components and width utilities rather than implementing a terminal framework.

### Command and normalized result contract

- Register `/usage` through `pi.registerCommand`; it does not trigger an LLM call.
- Refresh configured supported providers independently and concurrently. Surface loading and partial results rather than waiting for the slowest provider before displaying anything.
- Show a dismissible, scrollable detailed TUI view; preserve the normal editor and footer after dismissal.
- Include provider, allowance/group label, used and remaining values where known, unit, reset time where known, capture time, and freshness/error state.
- Distinguish no configuration, authentication failure, unsupported data, partial data, request failure, stale data, and usable results. (Deviation, accepted 2026-09-05: per-provider no-configuration rows are not rendered in the /usage view; unconfigured providers are omitted entirely and the nothing-configured case shows an info notification. Configured-but-broken providers still render real error states, and the internal `not-configured` error kind remains as a resolution-race safety net. See Phase 2 execution notes.)
- Missing providers do not trigger login. One failed provider must not blank successful providers.
- Do not inject quota data into model context or persist results in session entries.
- Do not combine provider allowances or independent quota domains into a single percentage.

### Provider contracts

All quota/identity/billing calls made by this package are GET requests to fixed official endpoints.

| Provider ID | Data source | Authentication and interpretation |
| --- | --- | --- |
| `openai-codex` | `https://chatgpt.com/backend-api/wham/usage` | Pi-resolved OAuth bearer; include `chatgpt-account-id` derived from the same runtime token. Keep shared and additional model-specific quota groups separate. |
| `opencode-go` | `https://opencode.ai/zen/go/v1/usage` | Bearer auth. Parse `usage.rolling`, `usage.weekly`, and `usage.monthly`, including `status`, `percent`, and `resetsAt`. |
| `zai` | `https://api.z.ai/api/monitor/usage/quota/limit` | Raw API key in `Authorization`, following Z.ai's official plugin. Parse `data.limits`; support `TOKENS_LIMIT` and `CREDIT_LIMIT`, with `TIME_LIMIT` treated separately. |
| `kimi-coding` | `https://api.kimi.com/coding/v1/usages` | Pi-resolved Coding API key or OAuth bearer. Parse main `usage` and rolling `limits`, preserving returned quota and window semantics. |
| `xai` | `https://cli-chat-proxy.grok.com/v1/user`, `/v1/billing?format=credits`, `/v1/billing` | Require Pi OAuth. Resolve identity before billing; use verified identity with required CLI-proxy headers. Prefer percentage/current-period fields, with validated legacy monthly fields as fallback. |
| `openrouter` | `https://openrouter.ai/api/v1/key` | Bearer auth. Display reported key limit, remaining dollars, and spending; do not query management-key endpoints. |

#### Codex

- Parse `rate_limit.primary_window` and `secondary_window`: `used_percent`, `limit_window_seconds`, and `reset_at` in epoch seconds.
- Parse additional model-specific limit groups separately, without merging them into shared quota.
- Derive the account header from the runtime token's `https://api.openai.com/auth.chatgpt_account_id` claim, following the inspected Pi request implementation. Validate the decoded structure and header value; token decoding is not independent identity verification.
- Invalid or absent required account information is an authentication/unsupported-data error, not an invitation to read stored credentials.
- Show additional groups in the command. Use shared quota in the footer rather than guessing which additional group applies to the selected model.
- Do not add reset-credit redemption or other write endpoints.

#### OpenCode Go

- Recognize `ok` and `rate-limited` window statuses.
- `percent` means usage consumed; remaining is derived from validated reported usage.
- Parse `resetsAt` as a returned timestamp, not as a fixed offset from query time.
- Distinguish missing credentials, unauthorized credentials, and subscription-required responses.

#### Z.ai

- Both `TOKENS_LIMIT` and newer `CREDIT_LIMIT` describe Coding Plan allowance; do not assume these raw units equal LLM tokens.
- Observed identifiers `(unit: 3, number: 5)` distinguish the 5-hour window; `(unit: 6, number: 1)` identifies the weekly window. Never assign windows by array order.
- `percentage` is consumed percentage. `usage` carries the limit and `currentValue` carries consumed units where supplied.
- `nextResetTime` is epoch milliseconds. Missing, null, or unusable reset values stay unknown.
- Keep monthly `TIME_LIMIT` MCP/tool allowance separate from coding allowance.
- Unknown identifiers remain explicitly unknown; do not infer an undocumented unit mapping.
- Validate the API's success/error envelope even when HTTP status is 200.

#### Kimi Coding

- Parse returned `limit`, `used`, `remaining`, and `resetTime` values with validation, including finite numeric strings where the reference responses use them.
- Derive a missing used or remaining value only from valid counterpart and limit fields. Present-but-invalid fields must not become zero.
- Interpret rolling window duration using its returned time unit, not array position or a blanket 5-hour assumption.
- Label quota units as provider allowance, not model tokens.

#### Grok

- Reject API-key resolution even though Pi's `xai` provider supports both API keys and OAuth.
- Query `/v1/user` first and validate `userId` before adding it as `x-userid` on billing requests.
- Required request conventions include `Authorization: Bearer ...`, `X-XAI-Token-Auth: xai-grok-cli`, `x-grok-client-version`, and `x-grok-client-mode`. Keep the version header as an adapter protocol value, not an invented package version equivalence; verify it against the cited client/reference before implementation.
- Prefer `config.creditUsagePercent` in 0–100 percentage units and `config.currentPeriod` for period/reset interpretation.
- Support validated legacy `used`, `monthlyLimit`, and billing-period timestamps. Validate cent wrappers before deriving percentages or dollar values.
- The monthly endpoint supplements current credits data when needed. Failure of an optional monthly query must not hide an already valid credit-period result.
- Missing percentages remain unknown unless a provider contract establishes a safe interpretation. Do not assume a missing numeric field means zero solely because a community integration does so.
- Label data as coding-credit allowance; do not claim coverage of all Grok chat quotas.

#### OpenRouter

- Use `data.limit`, `limit_remaining`, `limit_reset`, and reported usage fields as key-scoped data.
- A null cap means no key spending cap, not unlimited account credit.
- Do not treat a reset cadence string as an exact reset timestamp or invent a countdown.
- Do not display returned key labels or user identifiers unnecessarily.

### Shared normalization rules

- Preserve legitimate zero values; missing, malformed, and unsupported data are not zero usage.
- Validate numeric values before arithmetic; exclude non-finite or invalid values from usable quota data.
- Keep unknown reset times unknown. A passed reset timestamp does not prove quota has replenished.
- Preserve valid windows when optional windows are malformed; expose a partial-data notice.
- Use provider/group labels and units rather than uniform-looking but misleading summaries.
- Use text in addition to color, and sanitize provider-supplied labels before rendering.

### Authentication and safety

- Use only `ctx.modelRegistry.getProviderAuth()` for runtime credential resolution. No direct credential-store, browser, `.env`, or other client authentication reads.
- Codex and Grok must resolve as OAuth; use the inspected runtime result's OAuth provenance rather than substituting API credentials.
- Inspect effective provider/model origins and resolved authentication base-URL overrides before sending credentials to fixed official endpoints. Reject custom provider proxies.
- OpenCode Go may have model-level base URLs without a provider-level base URL; validate the relevant model endpoints rather than assuming every provider supplies a base URL.
- Forward only adapter-required headers. Reject redirects and URL credentials; do not forward arbitrary resolved headers to quota hosts.
- Bound each provider refresh, including waiting for authentication, to 30 seconds. Bound individual package-owned HTTP requests to 10 seconds and successful response bodies to 128 KiB.
- The inspected `getProviderAuth()` API has no caller-signal argument. Time out the extension's wait and discard late results; do not claim to cancel Pi's underlying auth refresh.
- Show fixed, sanitized error categories. Do not expose raw bodies, runtime tokens, account identifiers, or upstream exception messages.
- Keep quota results in memory only. Partition cache state with an in-process salted credential fingerprint and invalidate results on credential changes; never put credentials into cache keys or persisted artifacts.
- Pi can refresh and persist its own OAuth credentials normally. This package does not implement or persist authentication.

### Refresh and UI lifecycle

- `/usage` bypasses ordinary cache age but respects server-imposed backoff.
- Refresh the active provider on session start and model change.
- On `agent_settled`, refresh only when cached data is at least 60 seconds old.
- Poll only the active provider every five minutes; no background polling of all six providers.
- Deduplicate command, timer, and event requests for the same provider/auth context.
- Use backoff for automatic failures and honor valid server retry guidance; do not busy-loop or launch duplicate work while backing off.
- Show remaining allowance, reset countdown where known, and data age. Mark stale/failed refreshes visibly; do not silently show old data as current.
- Reaching a reset time triggers a need for fresh data, not an assumed replenishment.
- Ignore obsolete responses after model, account, or session changes. An old provider response cannot replace the active provider footer.
- Register background work from session lifecycle, not the extension factory. Clear timers, cancel package-owned requests, and remove the package's status on shutdown/reload.
- Use additive `setStatus`, not `setFooter`; preserve other extensions' statuses.
- Automatic networking is TUI-only. Print/JSON modes stay silent and do not poll. Do not invoke custom TUI in RPC mode.
- Honor `PI_OFFLINE` by suppressing quota networking.
- No popup warning system in v1.

## Assumptions

- One account per provider is sufficient, but runtime credential changes must not reuse another account's cached results.
- Public source and protocol references are sufficient to implement mocked contracts; no live quota endpoint has been tested with the user's credentials during planning.
- User-run dashboard comparisons are required to validate real account/product semantics, especially Grok and Z.ai schema variants.
- Independent code means no wholesale import of the referenced package's implementation or tests. If execution proposes copying licensed source, stop and obtain a scope decision rather than silently changing this choice.
- Cross-process polling coordination is deferred; each Pi process has its own bounded polling schedule.

## Phase Strategy

Sequential checkpoints: working two-provider command, five-provider command, approved `/usage` visual refinement, six-provider command, then automatic footer/lifecycle integration. These boundaries allow protocol, UI, and security review before additional providers or background networking are introduced.

Use a shared branch with checkpoint tags. No parallel writers are needed.

### Shared execution tracking rules

- Start every phase as `Not Started`; change to `In Progress` when execution begins.
- Check off tasks only after their completion condition is met.
- Strike through skipped or superseded tasks and record the reason instead of marking them done.
- Record verification commands/results and residual limitations in the phase execution notes.
- A phase becomes `Complete` only after the user reviews and explicitly accepts it.
- After acceptance and separately authorized Git actions, commit the checkpoint and create a non-overwriting `pi-usage-phase-N` tag. Never move an existing checkpoint tag silently.
- Start dependent work from the preceding accepted checkpoint. Finalize that phase's tracking and checkpoint before advancing rather than leaving unfinished phase state behind.
- Installation changes, commits, tags, pushes, and publication require separate execution authorization; plan approval alone is insufficient.

## Phases

### Phase 1 — Working command with OpenCode Go and OpenRouter

- **Objective:** Deliver a useful, installable two-provider quota command with the shared safety boundaries.
- **Status:** Complete (accepted 2026-09-05)
- **Complexity:** Medium
- **Estimated Time:** 60–90 minutes
- **Prerequisites:** Approved plan; implementation authorization.
- **Context:** Empty implementation baseline. Establish shared contracts once; later adapters reuse them.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.gitignore` | Create/generate | Package and repeatable checks |
| `src/index.ts`, `src/types.ts`, `src/auth.ts`, `src/http.ts`, `src/ui.ts` | Create | Command, result model, safety, display |
| `src/providers/opencode-go.ts`, `src/providers/openrouter.ts` | Create | Initial adapters |
| `test/providers.test.ts`, `test/runtime.test.ts`, `test/extension.test.ts` | Create | Synthetic protocol and integration checks |
| `PLAN.md` | Update | Phase tracking |

#### Implementation Tasks

- [x] **Package setup:** Declare ESM, the Node requirement, and `pi.extensions: ["./src/index.ts"]`; explicitly allowlist shipped runtime files. Use pnpm to resolve dependencies and produce `pnpm-lock.yaml`. Done when Pi can discover the entry point and package inspection excludes dependencies, private data, and test-only artifacts from runtime contents.
  - `package.json` created (ESM, `engines.node >=24.16.0`, `pi.extensions`, `files: ["src"]`); `pnpm-lock.yaml` generated and committed to the branch; `pnpm run pack:check` lists only `package.json`, `README.md`, and `src/*.ts`.
- [x] **Development commands:** Provide `pnpm test` using `node --test test/*.test.ts`, `pnpm run typecheck` using `tsc --noEmit`, and `pnpm run pack:check` using `pnpm pack --dry-run` (verified in pnpm 11.1.2). Done when commands are runnable without authenticated model calls.
  - All three pass with no model calls. Tests run TypeScript directly via Node 24 type stripping; `tsconfig.json` uses `allowImportingTsExtensions` + `noEmit`.
- [x] **`src/types.ts`:** Define the normalized result contract described above, including independent windows/groups, unit semantics, capture time, and explicit error/partial states. Done when both initial adapters and the UI consume the same representation without provider-specific parsing in the UI.
  - `ProviderUsage`/`QuotaWindow`/`ProviderError` contract plus `QuotaAdapter` adapter interface; both adapters and `src/ui.ts` consume it with no provider-specific parsing in the UI.
- [x] **`src/auth.ts` and `src/http.ts`:** Implement Pi-only auth resolution, exact official-origin validation, limited headers, redirect rejection, bounded bodies, timeouts, and sanitized errors. Done when mocked safety tests prove no credential is sent to an unapproved origin and late work is discarded.
  - Auth resolves only through `ctx.modelRegistry` (`getProviderAuthStatus`/`getProviderAuth`/`getProvider`), refuses custom provider/auth base-URL overrides, and detects OAuth provenance via `source: "OAuth"`. HTTP is GET-only, `redirect: "error"`, 10s/128 KiB bounds, sanitized errors; per-provider 30s bound discards late work. Covered by mocked tests in `test/runtime.test.ts`.
- [x] **Initial adapters:** Implement the OpenCode Go and OpenRouter contracts. Done when valid zero usage, all Go windows, subscription errors, finite spending caps, and uncapped OpenRouter keys render with correct semantics.
  - `src/providers/opencode-go.ts` (rolling/weekly/monthly, `ok`/`rate-limited`, consumed `percent`, returned `resetsAt`, 401/403-EntitlementError mapping) and `src/providers/openrouter.ts` (USD limit/remaining/usage, null cap ≠ unlimited, `limit_reset` as cadence only, no labels/user ids surfaced).
- [x] **`src/index.ts` and `src/ui.ts`:** Register `/usage` and render a dismissible, scrollable view with independent loading/results/errors. Do not add automatic polling yet. Done when one slow or failing provider does not hide another provider's result and closing the view restores normal interaction.
  - `/usage` registered (no LLM call); non-TUI modes stay silent; per-provider sections update independently; escape/q/enter closes and aborts package-owned work. No polling/timers exist.
- [x] **Tests:** Add small synthetic tests for valid payloads, missing/null fields, zero usage, malformed responses, missing auth, redirects, oversized bodies, and timeouts. Done when each meaningful branch has a runnable regression check without credentials or live APIs.
  - 54 tests across `test/providers.test.ts`, `test/runtime.test.ts`, `test/extension.test.ts`; all pass.

#### Execution Tracking Rules

Apply the shared rules. Record any changes to the shared result contract before phase 2 begins. Checkpoint tag after user acceptance and authorization: `pi-usage-phase-1`.

#### Verification

- [x] `pnpm test` passes using only synthetic/mock data. (54/54 pass)
- [x] `pnpm run typecheck` passes without emitting runtime files.
- [x] `pnpm run pack:check` lists the intended entry point/runtime files and no sensitive or unintended content.
- [x] Mocked command checks demonstrate independent provider completion and explicit no-configuration/error states.
- [x] User reviews the working command; any local installation used for review is separately authorized. (Reviewed via `pi -e ./src/index.ts`; user confirmed success. Checkpoint commit + tag `pi-usage-phase-1` authorized and completed.)

#### Completion Gate

User review and explicit confirmation that phase 1 is complete.

#### Outputs

Installable two-provider command, shared safety/result contracts, and runnable verification commands.

#### Execution Notes

Phase 1 implementation complete (2026-09-05). Recorded deviations and decisions:

- `pnpm-workspace.yaml` was added (not in the original file list): pnpm 11 reads build-script allow/ignore decisions and `verifyDepsBeforeRun` from there, not `package.json#pnpm`. It records `ignoredBuiltDependencies` for transitive dev-only toolchain deps (`@google/genai`, `esbuild`, `protobufjs` — none needed for typecheck/tests) and disables the run-time deps re-check, without which `pnpm install` exits non-zero on the ignored-builds notice.
- `@types/node` added as a devDependency (typecheck requirement; not shipped).
- Tests run `.ts` files directly through Node 24 type stripping; no test framework introduced.
- OpenCode Go response shape verified against the cited `anomalyco/opencode` console source (window statuses, consumed `percent`, ISO `resetsAt`, 401 `AuthError` / 403 `EntitlementError` envelopes). OpenRouter shape verified against the cited current-key API docs (`data.limit`, `limit_remaining`, `limit_reset` cadence string, `usage`).
- `/usage` is a no-op outside `ctx.mode === "tui"`; RPC/print/JSON behavior is formalized in phase 4 per plan.
- Residual limitation (intentional): `canceled` error entries may be written to the in-memory snapshot after the view closes; nothing renders them in phase 1.

### Phase 2 — Codex, Kimi, and Z.ai

- **Objective:** Extend the command to five providers while preserving each provider's quota semantics.
- **Status:** Complete (accepted 2026-09-05)
- **Complexity:** High
- **Estimated Time:** 90–120 minutes
- **Prerequisites:** User-accepted phase 1 and its shared contracts.
- **Context:** Reuse existing auth, HTTP, UI, and normalization structure; do not add separate credential paths.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `src/providers/codex.ts`, `src/providers/kimi.ts`, `src/providers/zai.ts` | Create | Additional subscription adapters |
| `src/index.ts`, `src/auth.ts` | Modify | Register providers and adapter-specific approved auth needs |
| `test/providers.test.ts`, `test/runtime.test.ts`, `test/extension.test.ts` | Modify | New provider and partial-data checks |
| `PLAN.md` | Update | Phase tracking |

#### Implementation Tasks

- [x] **Codex adapter:** Implement runtime OAuth validation, bounded account-header derivation, shared windows, and separate additional groups. Done when mocked headers use the runtime account and malformed optional groups cannot hide valid shared quota. No redemption code or endpoints.
  - `src/providers/codex.ts`: OAuth provenance enforced (`source: "OAuth"`, API-key resolution rejected before any request); `chatgpt-account-id` derived from the runtime token's `https://api.openai.com/auth.chatgpt_account_id` claim with structure/charset validation; `primary_window`/`secondary_window` + separate `additional_rate_limits` groups; `reset_at` epoch seconds; window durations in labels. Covered by mocked tests.
- [x] **Kimi adapter:** Implement main allowance, rolling windows, accepted numeric strings, and safe missing-field derivation. Done when absent versus invalid fields remain distinct and internal quota units are never labelled as model tokens.
  - `src/providers/kimi.ts`: main `usage` + rolling `limits` (with or without `detail` wrapper); finite numeric strings accepted; missing used/remaining derived only from valid counterpart + limit; present-but-invalid drops the bucket with a partial notice; window labels from returned `timeUnit` (second/minute/hour/day), never position; unit "uses" under domain "Coding plan allowance".
- [x] **Z.ai adapter:** Implement envelope validation, both coding quota-type generations, window identification by known unit/number pairs, epoch-millisecond resets, and separate tool allowance. Done when array reordering cannot swap windows and unknown identifiers stay unknown.
  - `src/providers/zai.ts`: `code`/`success` envelope validated even at HTTP 200; raw key in `Authorization` (official plugin convention); `TOKENS_LIMIT` + `CREDIT_LIMIT` as coding allowance with inverted `usage`=limit / `currentValue`=used semantics; `(3,5)`→5-hour and `(6,1)`→weekly identification, never array order; `nextResetTime` epoch ms with null/0/missing unknown; `TIME_LIMIT` as a separate "MCP tools (monthly)" window.
- [x] **Provider registration:** Add the three canonical Pi provider IDs to the command's fixed supported list. Done when only configured supported providers are queried and failed adapters remain isolated.
  - `src/index.ts` ADAPTERS now `opencode-go`, `openrouter`, `openai-codex`, `kimi-coding`, `zai`; five-provider view test shows independent rendering without conflation; unconfigured providers issue no requests.
- [x] **Tests:** Cover Codex account claims and shared/additional groups; Kimi numeric strings, missing data, and time units; Z.ai old/new/mixed quota types, reordered windows, reset units, API-level errors, and tool allowance. Done when these behaviors pass through the shared UI without semantic conflation.
  - 35 new tests (54 → 89 total): Codex claim/header/OAuth-rejection/group isolation; Kimi strings, derivation, invalid-field dropping, time-unit mapping; Z.ai credit/tokens/time shapes, reordering, envelope errors, unknown identifiers; extension-level five-provider render, codex OAuth enforcement, partial-data notice.

#### Execution Tracking Rules

Apply the shared rules. Record any live discrepancy as sanitized evidence; do not change contracts based on guesses. Checkpoint tag after acceptance and authorization: `pi-usage-phase-2`.

#### Verification

- [x] `pnpm test`, `pnpm run typecheck`, and `pnpm run pack:check` pass. (89/89 tests; tarball lists only src + manifests)
- [x] Partial malformed optional windows leave valid quota visible with a notice. (provider-level tests + extension-level partial-data notice render test)
- [x] No direct credential reads, new authentication flows, or provider write calls are introduced. (All auth via `ctx.modelRegistry` resolution; GET-only HTTP; no new flows)
- [x] User compares displayed values with the relevant dashboards locally and reports only sanitized differences. (Covered by user acceptance 2026-09-05; no sanitized discrepancies reported.)

#### Completion Gate

Automated checks and user confirmation of the five-provider behavior and dashboard comparisons.

#### Outputs

Five-provider command with correct grouping and explicit partial-data handling.

#### Execution Notes

Phase 2 implementation complete (2026-09-05). Decisions:

- `src/auth.ts` needed no changes after all: adapter-specific auth needs are enforced at the adapter layer using the resolved provenance already returned by phase 1 (`oauth` flag for Codex; raw-key vs Bearer is an adapter header choice). The plan's file table anticipated an auth.ts modification that turned out unnecessary.
- Codex account-header derivation decodes the runtime token locally (base64url JWT payload → `https://api.openai.com/auth.chatgpt_account_id`), mirroring Pi's inspected request implementation; the id is charset-validated before use as a header value. Token decoding is not treated as identity verification.
- Codex window labels carry durations derived from `limit_window_seconds` (e.g. "primary (shared) · 5h"); shared and `additional_rate_limits` groups stay separate windows.
- Kimi bucket dropping independently reimplements the reference semantics: present-but-invalid `used`/`remaining` drops that bucket with a partial notice; derivation only from valid counterpart + limit.
- Z.ai follows the observed inverted naming (`usage` = limit, `currentValue` = consumed); `remaining` is used as returned when finite. `TIME_LIMIT` renders as a separate "MCP tools (monthly)" window inside the same provider result — domains stay separate windows and are never combined.
- Protocol shapes re-verified during implementation against the plan's cited references (openai/codex rate-limit tests, Z.ai official plugin + CREDIT_LIMIT report + ai-usagebar wire shapes, specode Kimi parser) plus Pi's own provider definitions (`openai-codex`, `kimi-coding`, `zai` base URLs and auth types).
- **Review fix (user-reported):** with five providers the view overflowed and scrolling did not repaint. Two root causes in `src/ui.ts`: the custom component replaced the editor slot but used a hardcoded 20-row viewport, and `handleInput` never called `tui.requestRender()` after offset changes. Fixed by deriving the viewport from `tui.terminal.rows` (reserving 4 chrome rows) and requesting a repaint on every handled key; a scroll-position hint line (`3-22 of 41`) was added. Regression tests cover repaint-on-scroll and terminal-height-derived viewport height.
- **Review decision (user-requested):** providers without credentials configured in Pi are now omitted from the /usage view entirely instead of showing a `not configured` row. The command filters on `getProviderAuthStatus().configured` before creating entries; when nothing is configured it shows an info notification instead of an empty view. The `not-configured` error kind remains as a safety net for status/resolution races, and configured-but-broken providers still show their real error states.

### Pre-Phase 3 — `/usage` visual refinement

- **Objective:** Replace dense quota rows with a responsive, one-provider-per-tab terminal dashboard without changing normalized provider semantics.
- **Status:** Complete (accepted 2026-09-05)
- **Complexity:** Low
- **Prerequisites:** User-accepted phase 2.
- **Context:** The five-provider command is correct but hard to scan. This refinement is a blocking presentation checkpoint before Grok adds another provider.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `src/ui.ts` | Modify | Responsive bar-based quota rendering |
| `test/extension.test.ts` | Modify | Rendering, derivation, unknown-ratio, and width regressions |
| `AGENTS.md`, `PLAN.md` | Modify | Keep workflow and execution scope aligned |

#### Implementation Tasks

- [x] **Provider hierarchy:** Use Pi theme tokens for provider headings while retaining domain and capture-age context. Done when provider sections are visually distinct without hardcoded colors.
- [x] **Quota bars:** Render consumed/remaining bars when `usedPercent` is valid or a ratio can be safely derived from same-unit limit/used/remaining values. Clamp rendering to 0–100%; never mutate normalized values or invent an unknown ratio.
- [x] **Window details:** Show remaining percentage or amount at right, reset timing below, exact used/remaining/cap values where available, and explicit rate-limit/partial/error text.
- [x] **Responsive behavior:** Size bars from the available component width, retain scroll/navigation behavior, and keep every rendered line within the terminal width.
- [x] **Provider tabs:** Show one configured provider at a time with a persistent responsive tab strip. Left/right, `h`/`l`, and tab keys switch providers; vertical/page keys scroll only the active provider and switching resets its scroll position.
- [x] **Consistent tab height:** Pad shorter provider bodies to the tallest configured provider body, capped by the available viewport, so switching tabs does not move surrounding UI.
- [x] **Tests:** Cover tab switching, provider isolation, consistent height, responsive tab fallback, existing bar cases, reset text, scrolling, and narrow widths.

#### Verification

- [x] `pnpm test`, `pnpm run typecheck`, and `pnpm run pack:check` pass after the consistent-height amendment. (94/94 tests; intended package contents only.)
- [x] No provider parser, authentication, endpoint, or normalized contract changes are introduced.
- [x] User reviews the refreshed `/usage` panel and explicitly accepts the refinement. (Accepted 2026-09-05.)

#### Completion Gate

Automated checks and user confirmation of the visual result. Kaneo task `l2gmrcwc5c2r8acgsb06s68l` blocks phase 3 until this gate is met.

#### Execution Notes

- User selected the balanced direction: responsive reference-style bars while preserving domain, freshness, exact values, and explicit error semantics.
- The filled segment represents consumed quota, matching the reference image. Unknown ratios remain text-only rather than displaying a misleading empty/full track.
- Implementation uses `accent`, `dim`, `success`, and `warning` Pi theme tokens rather than hardcoded colors. Bars cap at 42 columns and shrink or stack their summary at narrow widths.
- Initial bar-layout verification passed: `pnpm test` (93/93), `pnpm run typecheck`, `pnpm run pack:check`, and `git diff --check`.
- User requested one configured provider per tab before visual acceptance. The existing refinement task returned to in-progress; no new Kaneo task was needed.
- Tab implementation keeps the strip fixed while only the active provider body scrolls. Wide terminals show every configured tab; narrow terminals show the active tab with its position. Left/right, `h`/`l`, Tab, and Shift-Tab cycle providers and reset body scroll.
- Tab-amendment verification passed: `pnpm test` (94/94), `pnpm run typecheck`, `pnpm run pack:check`, and `git diff --check`.
- User requested consistent panel height across tabs before visual acceptance. The existing refinement task returned to in-progress.
- Shorter active bodies now receive blank rows up to the tallest configured provider body, capped by the viewport. Verification passed: `pnpm test` (94/94), `pnpm run typecheck`, `pnpm run pack:check`, and `git diff --check`.
- User visually confirmed the responsive bars, provider tabs, and consistent tab height and accepted the refinement on 2026-09-05.

### Phase 3 — Grok subscription billing

- **Objective:** Complete six-provider support with accurately labelled Grok coding-credit allowance.
- **Status:** Complete (accepted 2026-09-06)
- **Complexity:** High
- **Estimated Time:** 60–90 minutes
- **Prerequisites:** User-accepted phase 2.
- **Context:** Grok is a distinct identity-plus-billing flow. Current percentage/period fields and legacy monthly fields must not be conflated.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `src/providers/grok.ts` | Create | Identity and billing adapter |
| `src/index.ts`, `src/auth.ts` | Modify | Grok registration and OAuth-only requirements |
| `test/providers.test.ts`, `test/runtime.test.ts`, `test/extension.test.ts` | Modify | Grok protocol/safety/UI checks |
| `PLAN.md` | Update | Phase tracking |

#### Implementation Tasks

- [x] **Protocol verification:** Check the cited official Grok billing client and pinned reference for request headers and identity lookup conventions. This is bounded to the documented adapter requests; stop if a material contract differs rather than inventing a new auth path.
  - Verified against xai-org/grok-build at main: `billing.rs` (credits `GET {base}/billing?format=credits`, headers `Authorization`/`X-XAI-Token-Auth: xai-grok-cli`/`x-userid`/`x-grok-client-version`/`x-grok-client-mode`; modern `creditUsagePercent`/`currentPeriod` vs legacy `used`/`monthlyLimit`/`billingPeriod*` Cent wrappers; proto3 zero omission documented on the official `Cent` struct) and `auth/manager/enrichment.rs` + `auth/model.rs` (`GET {base}/user` → camelCase `UserInfo.userId`, non-empty required; same header set without `x-userid`). Proxy base pinned `https://cli-chat-proxy.grok.com/v1` (`xai-grok-workspace/src/handle.rs`); client version crate at 1.0.16 (adapter protocol constant, not this package's version). Cross-checked against the pinned pi-subscription-usage grok reference; no material contract difference found.
- [x] **OAuth and identity:** Reject non-OAuth resolution, query and validate identity, then issue approved billing GETs using the same runtime auth. Done when invalid identity prevents billing requests and API credentials never reach subscription billing.
  - `src/providers/grok.ts`: non-OAuth resolution rejected before any request (tested); `/v1/user` must return a printable-ASCII, bounded, non-empty `userId` or billing is never issued (tested incl. missing/empty/non-string/overlong); identity/billing use the same runtime OAuth bearer with the verified `x-userid` added on billing only.
- [x] **Billing normalization:** Prefer reported percentage/current period; use only validated legacy amount fields as fallback. Keep optional monthly failure separate from valid primary results. Done when valid partial data remains usable and missing percentages never become invented zero usage.
  - `creditUsagePercent` accepted only in 0–100; legacy Cent pair derives percent + USD used/limit/remaining; proto3 omission yields 0% only when a real credits config has a current period and no usage field at all (absent, never present-but-invalid); unified-billing accounts and unusable credits trigger the optional legacy monthly query; its failure leaves a valid credits result with a partial notice and is fatal only when credits exposed no quota.
- [x] **Command integration:** Add the Grok result with an explicit coding-credit label and relevant period/reset information. Done when the view does not claim to represent all Grok chat usage.
  - Adapter registered as Pi's `xai` provider; domain label "Grok coding credits"; window labels derive from `currentPeriod.type` (weekly/monthly) and reset from `currentPeriod.end`/`billingPeriodEnd`.
- [x] **Tests:** Cover API-key rejection, invalid identity, modern and legacy shapes, absent percentages, malformed monetary wrappers, required/optional billing failures, and timeout behavior. Done when all paths are checked with synthetic payloads.
  - 17 new tests (94 → 111): API-key rejection with zero requests, identity gating and header conventions, weekly/monthly period labels, legacy cent derivation, proto3 zero, present-but-invalid/out-of-range percent, malformed cents, unified-billing dual windows, optional-monthly isolation, fatal monthly failure, config nullability. `resolveQuotaAuth` gained an `allowedProviderOrigin` (xai's built-in `api.x.ai` model-API origin accepted only without an auth-level override; custom overrides must still match the quota origin) with tests; six-provider extension render covers tab isolation and identity-before-billing ordering.

#### Execution Tracking Rules

Apply the shared rules. Record real-account/product uncertainty until the user's live comparison resolves it. Checkpoint tag after acceptance and authorization: `pi-usage-phase-3`.

#### Verification

- [x] `pnpm test`, `pnpm run typecheck`, and `pnpm run pack:check` pass. (111/111 tests; tarball lists only src + manifests)
- [x] Failure of optional monthly data does not hide valid credit-period data. (Covered by provider-level tests; monthly endpoint is skipped entirely when credits quota is usable and the account is not unified-billing.)
- [x] Every network request is read-only and origin-restricted; no billing mutations or additional authentication stores are used. (GET-only shared HTTP layer unchanged; three fixed GET endpoints under `https://cli-chat-proxy.grok.com`; credentials only via Pi's runtime OAuth resolution.)
- [x] User confirms the result matches the intended Grok account and coding-credit product. (Amended per approved gate change: free-plan live smoke test confirmed the OAuth→identity→billing flow and proto3 rendering; paid-account comparison deferred — see execution notes.)

#### Completion Gate

Tests and user confirmation of the Grok account/product semantics.

#### Outputs

Six-provider command with an isolated Grok identity/billing integration.

#### Execution Notes

Implementation complete (2026-09-05); awaiting user confirmation of Grok account/product semantics.

- `src/auth.ts` was modified after all (the plan's file table anticipated this): `resolveQuotaAuth` accepts an optional `allowedProviderOrigin`. Pi's built-in `xai` provider base URL is the model API origin (`api.x.ai`), while quota lives on the CLI proxy (`cli-chat-proxy.grok.com`); the built-in origin is accepted only when Pi resolved no auth-level base-URL override, and custom overrides must still match the quota origin. All five existing providers pass `undefined` and behave exactly as before.
- `x-grok-client-version` is pinned to the official grok CLI version crate value (1.0.16) as an adapter protocol constant; `x-grok-client-mode` mirrors the official CLI's interactive/headless TTY distinction (metric label only, per grok-build source).
- Unified-billing accounts (`isUnifiedBillingUser: true`) always trigger the optional monthly probe, matching the pinned reference's observation that such accounts may expose quota only on the legacy monthly shape; credits and monthly windows render separately and are never merged.
- Deliberately not rendered (not in approved scope): `subscriptionTier`, `onDemandCap`/`onDemandUsed`, `prepaidBalance`, and history entries.
- Residual product uncertainty until the user's live comparison: exact percent semantics for unified-billing accounts and whether the user's plan reports the credits or legacy shape.
- **Live free-plan smoke test (2026-09-05, user-reported):** Pi xai OAuth succeeded on a free plan; `/usage` rendered a valid credits result (weekly period, 100% left, reset countdown). Model calls on the same account fail with the model API's own 402 credit gate. Approved disposition (user decision): keep the behavior — the free plan's billing payload (credits shape with a current period and omitted zero usage fields) is indistinguishable from a paid account sitting at 0% after reset, so `/usage` shows the period as 100% remaining, matching the official Grok CLI's documented proto3 interpretation. Known limitation: for subscription-less accounts the coding-credit window does not predict model-call availability; the 402 is Pi's separate model-call error surface. The deferred paid-account comparison remains the unblock for validating consumed-percent rendering.
- Phase accepted by the user on 2026-09-06 with the deferred paid-account comparison recorded above. Checkpoint commit + tag `pi-usage-phase-3` authorized and completed.
- **Approved gate amendment (2026-09-05, user decision):** the user has no paid Grok subscription, so the "user confirms the result matches the intended Grok account" check is amended to a two-step acceptance: (1) free-account smoke test — user attempts Pi xai OAuth and confirms `/usage` shows an explicit sanitized Grok error state (or correct tab omission when unconfigable); (2) explicit phase acceptance, with the live paid-account dashboard comparison recorded as deferred. Unblock condition for the deferred check: a Grok subscription becomes available and the user compares `/usage` against the Grok coding-credit dashboard.

### Phase 4 — Automatic footer and lifecycle hardening

- **Objective:** Deliver the approved automatic active-provider indicator and finish package usability/verification.
- **Status:** In Progress (verification passed; awaiting user review)
- **Complexity:** Medium
- **Estimated Time:** 60–90 minutes
- **Prerequisites:** User-accepted phase 3 and six working command integrations.
- **Context:** Add background behavior only after the explicit-query path is reviewed. Preserve Pi and other extensions' UI ownership.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `src/refresh.ts` | Create | In-memory cache, deduplication, scheduling, backoff |
| `src/index.ts`, `src/ui.ts`, `src/auth.ts` | Modify | Lifecycle hooks, footer, auth-scoped refresh handling |
| `test/runtime.test.ts`, `test/extension.test.ts` | Modify | Fake-clock and lifecycle/UI checks |
| `README.md` | Modify | Installation, usage, scope, limits, safety |
| `package.json` | Modify if needed | Final package-content allowlist |
| `PLAN.md` | Update | Final tracking and acceptance |

#### Implementation Tasks

- [x] **Refresh scheduling:** Implement active-provider startup/model-change refresh, 60-second event-cache behavior on `agent_settled`, and five-minute active-provider polling. Done when fake-clock checks prove inactive providers are not background-polled and manual queries still cover configured providers.
  - `src/refresh.ts` `UsageMonitor`: `session_start` refreshes the active provider; `model_select` refreshes when the active provider actually changed; `agent_settled` refreshes only when cached data is ≥60s old or a reset time has passed; a five-minute poll covers only the active provider. Fake-clock (`node:test` mock timers) tests prove inactive providers are never polled and `/usage` still refreshes all configured providers.
- [x] **Cache and backoff:** Deduplicate overlapping refreshes, scope cache by salted in-process auth fingerprint, discard obsolete results, and respect server-imposed backoff. Done when model/account changes cannot expose another account's result and repeated events cannot create request storms.
  - In-flight promise map deduplicates command/timer/event requests; cache entries carry a sha256(per-instance salt + credential) fingerprint; `serveCached` re-resolves credentials via Pi before serving so an account change never exposes the previous account's result; generation counter discards results after session replacement, provider switch, or caller timeout; backoff is exponential (30s doubling, 5min cap) with valid server `Retry-After` as the floor (`HttpResponse.retryAfterMs`, captured by a monitor-side wrapper — adapters unchanged); `/usage` bypasses cache age but respects backoff.
- [x] **Footer:** Use additive status with remaining allowance, known reset countdown, freshness, and explicit stale/error labels. Use shared Codex quota rather than guessing model-specific applicability. Done when status does not replace the built-in footer or another extension's entry and remains readable at narrow widths.
  - `setStatus("usage", …)` only (never `setFooter`); footer text from the provider's first window — adapters order primary/shared-first, so Codex shows shared quota and never guesses a model-specific group; text form: `<name> 87.5% left · resets 1h 0m · 3m old [· stale]`, error form `<name> <kind> error · retry <window>`; fullest form kept under a 60-column budget (tests).
- [x] **Lifecycle cleanup:** Clear timers, cancel package-owned requests, discard late auth/network results, and remove package status on shutdown/reload/session replacement. Done when repeated reloads do not accumulate listeners/timers or update disposed UI.
  - All background work starts from session lifecycle events only (factory registers nothing active); `session_shutdown` bumps the generation, clears the poll timer, aborts the session controller, and clears the status; late completions are discarded (no cache write, no status update); the poll timer is `unref`ed so it can never keep a process alive. Tests cover shutdown clearing, late-result discard, and no further networking/status after shutdown.
- [x] **Mode/offline behavior:** Keep automatic networking TUI-only, custom TUI out of RPC, and print/JSON output silent. Suppress quota requests under `PI_OFFLINE`. Done when mocked mode checks observe no disallowed network/UI activity.
  - Monitor gates all automatic work on `mode === "tui"` and `!PI_OFFLINE`; `/usage` returns before any UI/network outside TUI; tests cover rpc sessions and offline suppression.
- [x] **Documentation:** Update the existing README with local/Git installation, `/usage`, schedules, provider-specific quota scope, Pi-only auth, unsupported/error behavior, runtime requirements, and test commands. Do not create a repository `AGENTS.md` unless separately requested.
  - `README.md` rewritten: providers table with quota scope, Node/Pi requirements, local + Git-package installation, `/usage` and footer usage, automatic refresh schedule, data/error/safety semantics (including the documented Grok free-plan limitation), and dev commands. No `AGENTS.md` created.
- [x] **Final checks:** Complete lifecycle, credential-change, duplicate-request, reset-expiry, offline/headless, and narrow-terminal tests; inspect package contents. Done when all approved v1 behaviors have objective checks and no excluded features have appeared.
  - 131 tests total (added monitor lifecycle/scheduler/backoff/fingerprint/obsolete-discard/offline/mode tests, footer formatter tests, and extension-level session_start/model_select/shutdown/agent_settled checks). `pack:check` lists exactly `package.json`, `README.md`, and `src/*.ts`.

#### Execution Tracking Rules

Apply the shared rules. Capture known API/product limitations instead of marking them silently resolved. Checkpoint tag after acceptance and authorization: `pi-usage-phase-4`.

#### Verification

- [x] `pnpm test` passes, including provider, safety, lifecycle, and rendering checks. (131/131)
- [x] `pnpm run typecheck` passes.
- [x] `pnpm run pack:check` lists only intended distributable files.
- [x] Active model switching, `/usage`, stale data, passed reset times, repeated reloads, and offline behavior work as specified. (Fake-clock/monitor tests: provider-change refresh, dedup, reset-expiry forcing refresh, stale-kept-visible; shutdown/late-discard covers reload replacement; offline suppression; `/usage` covered by command tests.)
- [x] Normal editor/footer and other extension status entries remain intact. (Additive `setStatus("usage", …)` only; asserted that no other key is ever touched and `setFooter` is never used.)
- [ ] User performs final local end-to-end and provider-dashboard comparisons without exposing credentials to the agent.

#### Completion Gate

All checks pass and the user explicitly approves end-to-end v1 behavior.

#### Outputs

Complete six-provider command, automatic active-provider indicator, tests, and package usage documentation.

#### Execution Notes

Implementation complete (2026-09-06); awaiting user end-to-end review. Decisions:

- `model_select` triggers a refresh only when the active provider changes. Switching models within one provider does not alter that provider's quota, and Ctrl+P cycling fires `model_select` repeatedly — refreshing per switch would create exactly the request storm the plan forbids.
- Cached data is served only through `serveCached`, which re-resolves credentials via Pi and compares the salted fingerprint; a sync cache getter cannot detect an account change (first test run caught this). The in-flight dedup window after a mid-flight account switch is a documented corner: the next refresh (≤5 min) replaces the data.
- Server retry guidance: `http.ts` parses `Retry-After` (seconds or HTTP-date, bounded 1s–1h) into `HttpResponse.retryAfterMs`; the monitor wraps the GET function to capture it from non-2xx responses without touching adapter contracts. Backoff = max(exponential 30s→5min, server guidance).
- The `/usage` view no longer aborts in-flight refreshes on close — refreshes are shared with the footer via the session controller and are aborted on `session_shutdown` instead. This supersedes the phase 1 note about close-aborts.
- Footer text uses the provider's first window (`windows[0]`): adapters order primary/shared-first, which gives Codex the shared window and avoids provider-specific parsing in the UI.
- The poll timer is a recursive `setTimeout` that is `unref`ed: it can never keep a process (or the test run) alive, and `session_shutdown` clears it.
- `tsconfig.json` lib bumped ES2023 → ES2024 for `Promise.withResolvers` typing in tests; Node ≥24.16 supports it at runtime and no shipped behavior changes.
- `package.json` needed no changes; the existing `files` allowlist already covers `src/refresh.ts`.
- Tests run 125 → 131 with the monitor suite using `node:test` mock timers (`apis: ["setTimeout", "Date"]`) and a microtask drain helper; extension tests gained an `events` capture, `setStatus` recording, and `activeProvider` support in the fake context.

## Phase Dependencies

`Phase 1 → Phase 2 → /usage visual refinement → Phase 3 → Phase 4`

Do not start dependent work before the preceding phase is user-accepted. No parallel writer lanes are prescribed.

## Verification Policy

- Automated tests use synthetic payloads and mocked fetch/Pi APIs. No real credentials, paid model requests, or live quota calls are required.
- Prefer small table-driven native tests over introducing a framework.
- User performs authenticated dashboard comparisons locally; request only sanitized discrepancies or placeholder examples.
- Never treat an untested live endpoint or source-derived claim as a verified account result.
- If the installed Pi API differs from the inspected 0.85.1 contract, stop on consequential incompatibility instead of reaching into private credential APIs or silently widening compatibility scope.

## Risks

- **Undocumented endpoints can change:** isolate adapters, validate boundaries, retain usable partial results, and show explicit unavailability.
- **Different providers meter different things:** preserve coding, tool, key-spending, shared, and model-specific labels; never report a combined allowance.
- **Grok compatibility/product coverage:** validate with the user's actual subscription; do not equate coding-credit data with every Grok chat limit.
- **Z.ai schema variants:** support observed old/new quota types and known window identifiers; surface unknown schema rather than guessing.
- **Account changes and asynchronous races:** auth-partitioned in-memory cache, invalidation, and stale-result rejection are required.
- **Per-process polling volume:** use the approved bounded cadence and backoff. Add shared cross-process caching only if request volume becomes a demonstrated issue.
- **Pi auth cancellation boundary:** the package can stop waiting but cannot promise to abort a resolver without a signal API; ignore late results and prevent obsolete requests/UI updates.

## Research References

### Installed Pi documentation and source

Paths below are relative to the inspected `@earendil-works/pi-coding-agent` package root, not this repository:

- `docs/packages.md` — manifest, installation, dependency conventions.
- `docs/extensions.md` — commands, lifecycle, mode guards, public model registry, additive status.
- `docs/tui.md` — components, width safety, dialogs, footer/status patterns.
- `docs/providers.md` and `docs/environment-variables.md` — canonical providers, Pi-owned auth, offline behavior.
- `examples/extensions/model-status.ts` — model selection and additive status.
- `dist/core/model-registry.d.ts:35` — `getProviderAuth` signature.
- `dist/core/extensions/types.d.ts:533` — provider-response event boundary.
- `node_modules/@earendil-works/pi-ai/dist/providers/{openai-codex,opencode-go,zai,kimi-coding,xai,openrouter}.js` — built-in provider IDs and origins.
- `node_modules/@earendil-works/pi-ai/dist/auth/resolve.js` — OAuth provenance and Pi-owned refresh behavior.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:1247` — runtime-token account claim and account header convention.

### External protocol references

- [Existing Pi subscription integration](https://github.com/specode/pi-subscription-usage/tree/02d2220c7c218aea8cbdff5f54cd5f3b0ae86fbe) — reviewed manifest, provider parsers, and query paths; reference only, not an implementation dependency or copy source.
- [OpenCode Go endpoint source](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) — authentication, subscription errors, response fields.
- [Z.ai official usage plugin](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs) — quota endpoint and raw authorization convention.
- [Z.ai CREDIT_LIMIT schema report](https://github.com/robinebers/openusage/issues/1104) — newer observed response shape and identifiers; community evidence, not a stable public API promise.
- [Z.ai wire-shape reference](https://docs.rs/ai-usagebar/latest/src/ai_usagebar/zai/types.rs.html) — observed identifier/reset fields and schema caveats.
- [Codex rate-limit tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs) — quota field semantics and account header; test route paths are not assumed to be the production URL.
- [Grok official billing client](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs) — credits request headers and modern/legacy billing semantics.
- [OpenRouter current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) — key cap, remaining allowance, and spending fields.

## Questions for User

None blocking implementation under the approved scope. Live provider acceptance remains part of the phase gates; material protocol or compatibility deviations require clarification during execution.
