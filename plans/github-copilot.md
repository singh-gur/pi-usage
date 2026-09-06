# Simple Implementation Plan: GitHub Copilot Provider

## Overview

Add GitHub Copilot main-allowance reporting to `/usage` and the active-provider footer for personal and organization-provided accounts on github.com. Reuse existing refresh, cache, settings, and transport behavior. Live compatibility with Pi's resolved Copilot token remains an explicit user-owned gate, not a claim supported by mocked tests.

## Planning Profile

- Executor: Workhorse
- Detail: Standard
- Feedback: Standard
- Shape: Single phase; one provider integration with a compatibility gate.
- Approval: User approved the draft and creation of one Kaneo To Do task.
- Repository baseline inspected: `cfe82d6` on `main`.

## Relevant Context

- `src/index.ts:32` contains the fixed `ADAPTERS` registry. `sessionFrom` binds public model-registry APIs to the auth gateway.
- `src/auth.ts:56` resolves Pi credentials and validates effective routing. Its existing alternate provider origin is accepted only without an auth-level base URL.
- `src/refresh.ts` resolves auth both during refresh and before serving cached data. Both paths must use the same routing policy.
- `src/providers/codex.ts` demonstrates a pure interpreter, OAuth gate, fixed endpoint, and injected bounded requester.
- `src/ui.ts` renders normalized quota windows; the first window supplies footer data. Settings and scheduling are provider-independent.
- Installed Pi coding-agent and pi-ai versions inspected: 0.85.1. Copilot's OAuth `toAuth` returns the short-lived session token as `apiKey` and an account-specific `baseUrl`, not the underlying GitHub OAuth token.
- Candidate quota endpoint: `GET https://api.github.com/copilot_internal/user`. It is undocumented. Other clients attempt session-token authentication, but this does not establish successful Pi account compatibility.
- GitHub distinguishes AI-credit billing from legacy premium requests. Organization snapshots can report `unlimited` without reporting the organization's remaining budget.

## Decisions

- Scope: personal and organization-provided accounts on github.com, main allowance and reset timing, Pi-managed OAuth only.
- Percentage-based first version: no currency conversion, inferred request counts, hard-coded plan allowances, or model-specific estimates.
- Excluded: custom enterprise hosts, organization-wide billing reports, secondary completion quotas, separate login/token storage, CLI credential fallback, token exchanges, inference probes, and new dependencies.
- Preserve Pi 0.85.1 compatibility boundaries. Stop on material API differences rather than using private credential APIs.
- Use fixed official GET requests only. Never derive the quota destination from configuration, tokens, or response fields.

### Display contract

| Response | Display |
| --- | --- |
| Top-level `token_based_billing: true` | AI-credit allowance |
| Top-level `token_based_billing: false` | Legacy premium-request allowance |
| Billing flag absent or invalid | Copilot allowance; no assumed billing unit |
| Finite main quota | Reported percentage remaining |
| Personal unlimited quota | Unlimited; no fabricated percentage |
| Organization unlimited/pooled snapshot | Organization-managed; balance not reported |
| Missing or malformed main quota | Explicit unsupported error |

Use `quota_snapshots.chat` for an explicitly reported Free plan (`copilot_plan === "free"`); otherwise use `quota_snapshots.premium_interactions`. Never silently substitute completion quota. Interpret organization plans from validated response metadata (the inspected plan values include `business` and `enterprise`); do not expose organization/account identifiers or guess an unknown plan's budget. Unknown account classification must not turn an unlimited snapshot into a claim of unrestricted personal spending.

An organization-managed status does not mean unlimited spending or guaranteed access. Do not infer exhaustion from `has_quota: false` alone, or treat placeholder percentages on unlimited snapshots as a numeric balance.

## Assumptions

- The internal endpoint may accept the session token exposed by Pi's public auth API. This is explicitly unverified and accepted as a compatibility risk.
- Source-derived response contracts support parser design, not verified account outcomes. Personal and organization account comparisons must be tracked separately.

## Single-Phase Plan

- Objective: Integrate Copilot main allowance with existing command/footer behavior while preserving credential safety and honest quota semantics.
- Status: Verification passed (agent-run); awaiting user confirmation
- Complexity: Medium
- Estimated Time: One focused implementation pass; live compatibility confirmation is separately user-dependent.
- Prerequisites: Approved plan; existing provider/auth/monitor infrastructure. No dependency installations authorized.

## Files

| Path | Action | Purpose |
| --- | --- | --- |
| `src/providers/github-copilot.ts` | Create | Adapter and pure response interpreter |
| `src/types.ts` | Modify | Opt-in OAuth origin list and date-only reset field |
| `src/auth.ts` | Modify | Validate Copilot's official OAuth routing |
| `src/refresh.ts` | Modify | Forward routing policy through refresh and cache validation |
| `src/ui.ts` | Modify | Nonnumeric allowance states and date-only resets |
| `src/index.ts` | Modify | Append adapter to registry |
| `test/providers.test.ts` | Modify | Synthetic parser and request contract checks |
| `test/runtime.test.ts` | Modify | Routing and cache safety checks |
| `test/extension.test.ts` | Modify | Seven-provider integration and rendering checks |
| `README.md` | Modify during implementation | Provider scope and compatibility limitations |
| `AGENTS.md` | Modify | Tracking reference now; finalized provider/safety guidance during implementation |

## Implementation Tasks

- [x] **`src/types.ts`, `src/auth.ts`, `src/refresh.ts` — official OAuth routing:** Add optional `allowedOAuthOrigins: readonly string[]` to `QuotaAdapter` and a corresponding optional argument to `resolveQuotaAuth`. Accept this explicit allowlist only when `source === "OAuth"`. Copilot declares exactly `https://api.individual.githubcopilot.com`, `https://api.business.githubcopilot.com`, and `https://api.enterprise.githubcopilot.com`; its quota `officialOrigin` is `https://api.github.com`. Preserve existing `officialOrigin` and `allowedProviderOrigin` behavior for all other adapters. Forward the policy at both refresh and cached-result auth call sites.
  - Constraints: no wildcard hosts, custom domains, HTTP origins, lookalike domains, or token-derived request destinations. This changes validation of legitimate OAuth routing, not the fixed quota endpoint.
  - Done when: accepted Copilot routes pass, unsafe routes fail, other provider override tests remain passing, and cache validation uses the same policy as refresh.

- [x] **`src/providers/github-copilot.ts` — adapter and interpreter:** Export `interpretGitHubCopilot(status, data, now?)` and `githubCopilotAdapter`, following `codex.ts`. Use provider ID `github-copilot` and name `GitHub Copilot`. Require OAuth before any quota request. Make one injected bounded GET to `https://api.github.com/copilot_internal/user`, with `Authorization: Bearer <Pi-resolved token>` and `Accept: application/json`.
  - Use the inspected Copilot client-header convention: `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Version: vscode/1.107.0`, `Editor-Plugin-Version: copilot-chat/0.35.0`, and `Copilot-Integration-Id: vscode-chat`. Document these constants as source-derived, not a verified endpoint requirement. Do not add token exchange or alternative auth attempts.
  - Validate response records before accessing the selected main snapshot. Accept finite numeric percentages only within `[0, 100]`; preserve real zero. Map remaining percentage to `usedPercent = 100 - percent_remaining`.
  - Apply the display contract above, handling unlimited/organization-managed semantics before placeholder percentages. Do not derive quota counts from entitlement, plan names, or percentages. Missing/invalid main measurement is unsupported rather than zero.
  - Errors are fixed and sanitized: 401 authentication rejected; 403 access denied without asserting token expiry or missing subscription; other non-200 statuses request errors; unusable 200 response unsupported. Never surface upstream body text or account identifiers.
  - Reuse `UsageError`, normalized `ProviderUsage`/`QuotaWindow`, injected requester, and existing transport/monitor bounds. Legitimate numeric allowance with unusable reset data remains usable without a reset.
  - Done when: synthetic response variants produce agreed normalized results and exact request assertions pass without exposing private data.

- [x] **`src/types.ts`, `src/ui.ts`, adapter parser — nonnumeric allowance and resets:** Reuse `QuotaWindow.status` for fixed `unlimited` and `organization-managed` states. Render them in the dashboard and as neutral nonnumeric footer text, never a green 100% placeholder. Add optional `resetDate: string` for a validated calendar date without a time.
  - Prefer a valid `quota_reset_date_utc` timestamp for countdowns. Otherwise preserve a validated date-only `quota_reset_date` or `limited_user_reset_date` as `resetDate`. Missing/invalid dates stay absent; never manufacture midnight or infer replenishment after a reset passes.
  - Render date-only values as calendar dates in the dashboard and full footer, not countdowns. Preserve full/compact/off modes; full mode retains age/stale information. Existing providers' rendering must not change.
  - Done when: numeric, unlimited, organization-managed, timestamp, and date-only output have passing rendering checks, including narrow-width behavior.

- [x] **`src/index.ts`, existing test files — integration:** Append Copilot to `ADAPTERS`. Extend the six-provider integration fixture to seven providers and extend mocked public auth to include an auth-level base URL.
  - Parser coverage: AI-credit, explicit legacy, and unspecified billing mode; Free-plan main selection; zero/fractional/missing/invalid/out-of-range percentages; unlimited and organization-managed snapshots; valid timestamps/date-only resets and invalid dates.
  - Request/auth coverage: exact fixed destination and headers; non-OAuth rejection makes zero quota calls; exact official origin acceptance; custom/lookalike/insecure origin rejection; consistent refresh and cache validation.
  - Integration coverage: independent dashboard tabs/errors, active-provider footer, account-cache separation, and inherited offline/settings behavior. Reuse existing monitor tests rather than introducing a second scheduler or test framework.
  - Done when: Copilot runs through mocked public Pi APIs, all existing provider regressions pass, and no new dependency/configuration/auth store appears.

- [x] **`README.md`, `AGENTS.md` — support boundaries:** Document provider ID, main-quota scope, OAuth requirement, explicit official-routing exception, and undocumented-endpoint limitation. Keep compatibility claims at the inspected Pi 0.85.1 contract.
  - Done when: guidance reflects implemented behavior and does not describe either personal or organization account support as live-verified without corresponding user confirmation.

## Verification

- [x] `pnpm test` — all synthetic provider, routing, monitor, integration, and rendering checks pass; no live authenticated requests or paid model calls.
- [x] `pnpm run typecheck` — passes with no emitted runtime files.
- [x] `pnpm run pack:check` — passes and contains only intended distributable files.
- [ ] User-owned personal-account compatibility comparison: user compares `/usage` with GitHub locally and reports sanitized results only, without tokens, raw responses, or account identifiers.
- [ ] User-owned organization-account compatibility comparison: tracked separately; no organization-wide balance claim based on a per-user snapshot.

### Compatibility gate

If Pi's resolved token is rejected, stop and record the blocker. Do not add credential-file reads, private APIs, GitHub CLI fallback, a separate login, token exchanges, or inference probes. A successful mocked suite is not endpoint/auth compatibility evidence. Any unsupported account class remains explicitly unverified; changing or deferring this gate requires user approval.

## Execution Tracking and Completion Gate

- Track live execution in one Kaneo task in Home Projects / Pi Usage (`fu8gwyw0lnnjl67qz5314gw5`); locate its ID in the standalone-work table in `AGENTS.md`. Never create a duplicate.
- Task starts in `to-do`. Fetch its current state before execution and move to `in-progress` only when implementation actually starts.
- Update plan status to In Progress when execution begins; check off tasks only with inspected evidence. Mark skipped/superseded steps explicitly rather than falsely checking them off.
- Record meaningful verification results and blockers; distinguish agent-run checks from user-reported account comparisons.
- After verification, move to `in-review` with “awaiting user confirmation”. Mark the phase Complete and task `done` only after required verification and explicit user acceptance.
- Installation, commits, tags, pushes, and publication require separate authorization. Plan approval does not authorize implementation.

## Outputs

- One Copilot quota adapter integrated with the existing command/footer.
- Narrow shared auth/display additions, synthetic regression coverage, and accurate existing documentation.
- Separate recorded compatibility outcomes for personal and organization accounts.

## Risks

- Undocumented endpoint and uncertain session-token acceptance: explicit compatibility gate; stop instead of widening auth access.
- Changing billing semantics and organization pools: percentage-only finite reporting, explicit nonnumeric states, no inferred totals or access guarantees.
- OAuth routing exception: static exact-origin opt-in, preserved other-provider semantics, both auth call sites covered by tests.
- Date-only reset precision: preserve the calendar date without inventing a countdown.

## Questions for User

None before implementation. Account comparisons and completion acceptance remain user-owned gates.

## Evidence References

- Installed Pi 0.85.1 public `ModelRegistry` declarations, extension documentation, Copilot provider, and OAuth `toAuth` implementation; source inspected, no credentials read.
- GitHub billing transition: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing
- GitHub official routing domains: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
- VS Code quota contracts: https://github.com/microsoft/vscode/blob/ae7dce46/src/vs/base/common/defaultAccount.ts
- VS Code quota interpretation tests: https://github.com/microsoft/vscode/blob/ae7dce46/src/vs/workbench/contrib/chat/test/common/chatEntitlementService.test.ts
- Internal endpoint reference: https://github.com/ericc-ch/copilot-api/blob/0ea08feb/src/services/github/get-copilot-usage.ts
- Session-token attempts (secondary evidence only, not verification; credential fallbacks are excluded): https://github.com/vbgate/opencode-mystatus/blob/main/plugin/lib/copilot.ts
