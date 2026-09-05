# Implementation Plan: pi-usage

## Overview

Build an independently implemented, read-only Pi package for provider-reported subscription quota and OpenRouter key allowance. `/usage` refreshes all configured supported providers; an additive footer indicator shows remaining allowance for the active provider, reset countdown, and freshness.

This plan is user-approved. Implementation has not started. Approval to save this plan does not authorize installation changes, commits, checkpoint tags, pushes, or publication.

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

### Out of scope

Historical token/cost analytics, databases, persistent quota history, standalone dashboards, separate login flows, direct credential-file access, browser scraping, multiple accounts per provider, account switching, quota redemption, purchases, automatic model routing, popup warnings, npm publication, and shared cross-process caching.

## Architecture Decisions

### Package and files

Use TypeScript, Node built-ins, Pi's public APIs, and native `node:test`. No runtime dependencies beyond the Pi packages required by the UI/integration. Do not bundle Pi itself.

Target Pi 0.85.1 and Node 24.16+ initially. Declare Pi peer dependencies with `*` ranges as the inspected package documentation requires; develop and verify against the inspected Pi API. Do not imply untested compatibility with older Pi releases. Use the package manager for dependency changes and lockfile generation.

| Path | Action | Purpose |
| --- | --- | --- |
| `package.json` | Create | ESM package, Pi extension manifest, engine requirement, package allowlist, scripts, dependencies |
| `package-lock.json` | Generate through npm | Reproducible dependency resolution |
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
- Distinguish no configuration, authentication failure, unsupported data, partial data, request failure, stale data, and usable results.
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

Sequential checkpoints: working two-provider command, five-provider command, six-provider command, then automatic footer/lifecycle integration. These boundaries allow protocol and security review before additional providers or background networking are introduced.

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
- **Status:** Not Started
- **Complexity:** Medium
- **Estimated Time:** 60–90 minutes
- **Prerequisites:** Approved plan; implementation authorization.
- **Context:** Empty implementation baseline. Establish shared contracts once; later adapters reuse them.

#### Files

| Path | Action | Purpose |
| --- | --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | Create/generate | Package and repeatable checks |
| `src/index.ts`, `src/types.ts`, `src/auth.ts`, `src/http.ts`, `src/ui.ts` | Create | Command, result model, safety, display |
| `src/providers/opencode-go.ts`, `src/providers/openrouter.ts` | Create | Initial adapters |
| `test/providers.test.ts`, `test/runtime.test.ts`, `test/extension.test.ts` | Create | Synthetic protocol and integration checks |
| `PLAN.md` | Update | Phase tracking |

#### Implementation Tasks

- [ ] **Package setup:** Declare ESM, the Node requirement, and `pi.extensions: ["./src/index.ts"]`; explicitly allowlist shipped runtime files. Use npm to resolve dependencies and produce the lockfile. Done when Pi can discover the entry point and package inspection excludes dependencies, private data, and test-only artifacts from runtime contents.
- [ ] **Development commands:** Provide `npm test` using `node --test test/*.test.ts`, `npm run typecheck` using `tsc --noEmit`, and `npm run pack:check` using `npm pack --dry-run`. Done when commands are runnable without authenticated model calls.
- [ ] **`src/types.ts`:** Define the normalized result contract described above, including independent windows/groups, unit semantics, capture time, and explicit error/partial states. Done when both initial adapters and the UI consume the same representation without provider-specific parsing in the UI.
- [ ] **`src/auth.ts` and `src/http.ts`:** Implement Pi-only auth resolution, exact official-origin validation, limited headers, redirect rejection, bounded bodies, timeouts, and sanitized errors. Done when mocked safety tests prove no credential is sent to an unapproved origin and late work is discarded.
- [ ] **Initial adapters:** Implement the OpenCode Go and OpenRouter contracts. Done when valid zero usage, all Go windows, subscription errors, finite spending caps, and uncapped OpenRouter keys render with correct semantics.
- [ ] **`src/index.ts` and `src/ui.ts`:** Register `/usage` and render a dismissible, scrollable view with independent loading/results/errors. Do not add automatic polling yet. Done when one slow or failing provider does not hide another provider's result and closing the view restores normal interaction.
- [ ] **Tests:** Add small synthetic tests for valid payloads, missing/null fields, zero usage, malformed responses, missing auth, redirects, oversized bodies, and timeouts. Done when each meaningful branch has a runnable regression check without credentials or live APIs.

#### Execution Tracking Rules

Apply the shared rules. Record any changes to the shared result contract before phase 2 begins. Checkpoint tag after user acceptance and authorization: `pi-usage-phase-1`.

#### Verification

- [ ] `npm test` passes using only synthetic/mock data.
- [ ] `npm run typecheck` passes without emitting runtime files.
- [ ] `npm run pack:check` lists the intended entry point/runtime files and no sensitive or unintended content.
- [ ] Mocked command checks demonstrate independent provider completion and explicit no-configuration/error states.
- [ ] User reviews the working command; any local installation used for review is separately authorized.

#### Completion Gate

User review and explicit confirmation that phase 1 is complete.

#### Outputs

Installable two-provider command, shared safety/result contracts, and runnable verification commands.

#### Execution Notes

None.

### Phase 2 — Codex, Kimi, and Z.ai

- **Objective:** Extend the command to five providers while preserving each provider's quota semantics.
- **Status:** Not Started
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

- [ ] **Codex adapter:** Implement runtime OAuth validation, bounded account-header derivation, shared windows, and separate additional groups. Done when mocked headers use the runtime account and malformed optional groups cannot hide valid shared quota. No redemption code or endpoints.
- [ ] **Kimi adapter:** Implement main allowance, rolling windows, accepted numeric strings, and safe missing-field derivation. Done when absent versus invalid fields remain distinct and internal quota units are never labelled as model tokens.
- [ ] **Z.ai adapter:** Implement envelope validation, both coding quota-type generations, window identification by known unit/number pairs, epoch-millisecond resets, and separate tool allowance. Done when array reordering cannot swap windows and unknown identifiers stay unknown.
- [ ] **Provider registration:** Add the three canonical Pi provider IDs to the command's fixed supported list. Done when only configured supported providers are queried and failed adapters remain isolated.
- [ ] **Tests:** Cover Codex account claims and shared/additional groups; Kimi numeric strings, missing data, and time units; Z.ai old/new/mixed quota types, reordered windows, reset units, API-level errors, and tool allowance. Done when these behaviors pass through the shared UI without semantic conflation.

#### Execution Tracking Rules

Apply the shared rules. Record any live discrepancy as sanitized evidence; do not change contracts based on guesses. Checkpoint tag after acceptance and authorization: `pi-usage-phase-2`.

#### Verification

- [ ] `npm test`, `npm run typecheck`, and `npm run pack:check` pass.
- [ ] Partial malformed optional windows leave valid quota visible with a notice.
- [ ] No direct credential reads, new authentication flows, or provider write calls are introduced.
- [ ] User compares displayed values with the relevant dashboards locally and reports only sanitized differences.

#### Completion Gate

Automated checks and user confirmation of the five-provider behavior and dashboard comparisons.

#### Outputs

Five-provider command with correct grouping and explicit partial-data handling.

#### Execution Notes

None.

### Phase 3 — Grok subscription billing

- **Objective:** Complete six-provider support with accurately labelled Grok coding-credit allowance.
- **Status:** Not Started
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

- [ ] **Protocol verification:** Check the cited official Grok billing client and pinned reference for request headers and identity lookup conventions. This is bounded to the documented adapter requests; stop if a material contract differs rather than inventing a new auth path.
- [ ] **OAuth and identity:** Reject non-OAuth resolution, query and validate identity, then issue approved billing GETs using the same runtime auth. Done when invalid identity prevents billing requests and API credentials never reach subscription billing.
- [ ] **Billing normalization:** Prefer reported percentage/current period; use only validated legacy amount fields as fallback. Keep optional monthly failure separate from valid primary results. Done when valid partial data remains usable and missing percentages never become invented zero usage.
- [ ] **Command integration:** Add the Grok result with an explicit coding-credit label and relevant period/reset information. Done when the view does not claim to represent all Grok chat usage.
- [ ] **Tests:** Cover API-key rejection, invalid identity, modern and legacy shapes, absent percentages, malformed monetary wrappers, required/optional billing failures, and timeout behavior. Done when all paths are checked with synthetic payloads.

#### Execution Tracking Rules

Apply the shared rules. Record real-account/product uncertainty until the user's live comparison resolves it. Checkpoint tag after acceptance and authorization: `pi-usage-phase-3`.

#### Verification

- [ ] `npm test`, `npm run typecheck`, and `npm run pack:check` pass.
- [ ] Failure of optional monthly data does not hide valid credit-period data.
- [ ] Every network request is read-only and origin-restricted; no billing mutations or additional authentication stores are used.
- [ ] User confirms the result matches the intended Grok account and coding-credit product.

#### Completion Gate

Tests and user confirmation of the Grok account/product semantics.

#### Outputs

Six-provider command with an isolated Grok identity/billing integration.

#### Execution Notes

None.

### Phase 4 — Automatic footer and lifecycle hardening

- **Objective:** Deliver the approved automatic active-provider indicator and finish package usability/verification.
- **Status:** Not Started
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

- [ ] **Refresh scheduling:** Implement active-provider startup/model-change refresh, 60-second event-cache behavior on `agent_settled`, and five-minute active-provider polling. Done when fake-clock checks prove inactive providers are not background-polled and manual queries still cover configured providers.
- [ ] **Cache and backoff:** Deduplicate overlapping refreshes, scope cache by salted in-process auth fingerprint, discard obsolete results, and respect server-imposed backoff. Done when model/account changes cannot expose another account's result and repeated events cannot create request storms.
- [ ] **Footer:** Use additive status with remaining allowance, known reset countdown, freshness, and explicit stale/error labels. Use shared Codex quota rather than guessing model-specific applicability. Done when status does not replace the built-in footer or another extension's entry and remains readable at narrow widths.
- [ ] **Lifecycle cleanup:** Clear timers, cancel package-owned requests, discard late auth/network results, and remove package status on shutdown/reload/session replacement. Done when repeated reloads do not accumulate listeners/timers or update disposed UI.
- [ ] **Mode/offline behavior:** Keep automatic networking TUI-only, custom TUI out of RPC, and print/JSON output silent. Suppress quota requests under `PI_OFFLINE`. Done when mocked mode checks observe no disallowed network/UI activity.
- [ ] **Documentation:** Update the existing README with local/Git installation, `/usage`, schedules, provider-specific quota scope, Pi-only auth, unsupported/error behavior, runtime requirements, and test commands. Do not create a repository `AGENTS.md` unless separately requested.
- [ ] **Final checks:** Complete lifecycle, credential-change, duplicate-request, reset-expiry, offline/headless, and narrow-terminal tests; inspect package contents. Done when all approved v1 behaviors have objective checks and no excluded features have appeared.

#### Execution Tracking Rules

Apply the shared rules. Capture known API/product limitations instead of marking them silently resolved. Checkpoint tag after acceptance and authorization: `pi-usage-phase-4`.

#### Verification

- [ ] `npm test` passes, including provider, safety, lifecycle, and rendering checks.
- [ ] `npm run typecheck` passes.
- [ ] `npm run pack:check` lists only intended distributable files.
- [ ] Active model switching, `/usage`, stale data, passed reset times, repeated reloads, and offline behavior work as specified.
- [ ] Normal editor/footer and other extension status entries remain intact.
- [ ] User performs final local end-to-end and provider-dashboard comparisons without exposing credentials to the agent.

#### Completion Gate

All checks pass and the user explicitly approves end-to-end v1 behavior.

#### Outputs

Complete six-provider command, automatic active-provider indicator, tests, and package usage documentation.

#### Execution Notes

None.

## Phase Dependencies

`Phase 1 → Phase 2 → Phase 3 → Phase 4`

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
