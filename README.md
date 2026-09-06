# pi-usage

A read-only [Pi](https://github.com/earendil-works/pi-coding-agent) extension that reports provider subscription quotas and key allowances: a `/usage` dashboard for every configured supported provider, plus a compact footer indicator for the active provider.

## Supported providers

| Provider | Pi id | What is reported |
| --- | --- | --- |
| OpenAI Codex (ChatGPT subscription) | `openai-codex` | Shared rate-limit windows and separate model-specific groups |
| OpenCode Go | `opencode-go` | Rolling / weekly / monthly consumed percent |
| Z.ai Coding Plan | `zai` | Coding allowance (5-hour and weekly windows); monthly MCP/tool allowance shown separately |
| Kimi Coding | `kimi-coding` | Main allowance and rolling windows (provider allowance units, not model tokens) |
| Grok / xAI subscription | `xai` | Coding-credit allowance for the current period (weekly/monthly); does not cover all Grok chat quotas |
| GitHub Copilot | `github-copilot` | Main allowance percentage (AI-credit or legacy premium-request depending on billing mode); unlimited and organization-managed accounts report a nonnumeric state |
| OpenRouter key | `openrouter` | Key spending cap, remaining dollars, and reported spending |

Providers without credentials configured in Pi are omitted entirely. One account per provider.

## Installation

Requires Node.js ≥ 24.16 and Pi ≥ 0.85.1.

Install from npm (recommended; tagged releases, updated via `pi update --extensions`):

```
pi install npm:@singh-gur/pi-usage
```

Or pin to a version:

```
pi install npm:@singh-gur/pi-usage@1.2.0
```

Or install from this Git repository (latest commit, unpinned installs are reconciled by `pi update --extensions`):

```
pi install git:github.com/singh-gur/pi-usage
```

Tags `pi-usage-phase-1` … `pi-usage-phase-4` are published development checkpoints; `v*` tags mark npm releases.

The `https://` protocol URL form works too: `pi install https://github.com/singh-gur/pi-usage`. Review the source before installing — Pi packages run with full system access.

From a Git checkout (local development):

```
git clone git@github.com:singh-gur/pi-usage.git
pi -e ./pi-usage/src/index.ts
```

Credentials are resolved exclusively through Pi (`/login <provider>`); the extension never reads credential stores, `.env` files, or browsers. Codex, Grok, and Copilot quota requires OAuth (subscription) credentials — plain API keys are rejected before any request.

## Usage

Run `/usage` in Pi (TUI mode) for a scrollable, tabbed dashboard: one tab per configured provider, consumed/remaining bars where a ratio is safe, reset timing, exact values, and explicit partial/error states. The view dismisses with `esc`/`enter`/`q`.

The footer indicator is additive (`setStatus`, never a footer replacement) and shows, for the active provider only: remaining allowance, reset countdown where known, data age, and explicit `stale` / error labels.

## Settings

Run `/usage-settings` to edit global or trusted project settings. Changes apply immediately and are saved to:

- Global: `~/.pi/agent/pi-usage.json`
- Project: `<cwd>/.pi/pi-usage.json` (overrides global values and is read only for trusted projects)

The files can also be edited directly; run `/reload` afterward. Unknown or invalid values are ignored with a warning.

```json
{
  "footerFormat": "full",
  "pollIntervalMinutes": 5,
  "refreshAfterTurn": true
}
```

| Setting | Values | Default |
| --- | --- | --- |
| `footerFormat` | `"full"`, `"compact"`, `"off"` | `"full"` |
| `pollIntervalMinutes` | `0`, `1`, `5`, `15`, `30` (`0` disables polling) | `5` |
| `refreshAfterTurn` | boolean | `true` |

`compact` shows only the status light and remaining value. `off` removes the footer and its automatic network activity; manual `/usage` refreshes remain available.

## Automatic refresh schedule

All automatic networking is TUI-only and suppressed under `PI_OFFLINE`; print/JSON/RPC modes stay silent.

- **Session start and model switch:** refresh the active provider (model switches within the same provider do not re-fetch — the quota is unchanged).
- **After each turn** (`agent_settled`): when enabled, refresh only when cached data is ≥ 60 s old or a reset time has passed.
- **Periodic poll:** every 5 minutes by default; configurable or disabled. Only the active provider is polled.
- Overlapping command/event/timer requests are deduplicated; failed refreshes back off exponentially (30 s doubling, 5 min cap) and valid server `Retry-After` guidance is honored.
- `/usage` bypasses cache age but respects server-imposed backoff.

## Data, errors, and safety

- Every network call is a GET to a fixed official provider endpoint (no writes, no inference calls). Custom provider base URLs/proxies are refused before credentials leave the process.
- Quota results are in-memory only, partitioned by a salted per-process credential fingerprint: switching accounts never shows the previous account's data.
- Legitimate zeros are preserved; missing, malformed, or unsupported values stay unknown — never reported as zero.
- Failures render as fixed, sanitized error categories (auth, subscription, unsupported, request, timeout); raw bodies, tokens, and account identifiers are never displayed.
- A passed reset time means fresh data is needed, never an assumed replenishment.
- Known limitation (Grok free plans): the billing endpoint's payload for an account without coding credits is indistinguishable from a paid account at 0% after reset, so the weekly period shows as fully remaining even though model calls may fail with the model API's own credit error.
- Known limitation (GitHub Copilot): quota comes from an undocumented internal endpoint (`api.github.com/copilot_internal/user`) using the session token Pi resolves from its OAuth login; acceptance of that token is not guaranteed and shows as an auth error if refused. Percentage-only reporting: unlimited personal plans show `Unlimited`, organization-provided and unclassifiable accounts show `Organization-managed` (balance not reported), and no request counts, currency totals, or organization-wide budgets are inferred. Copilot OAuth routing through Pi's account-specific official origins (`api.individual|business|enterprise.githubcopilot.com`) is the only accepted alternate routing; custom enterprise hosts are out of scope.

## Development

```
pnpm install --frozen-lockfile
pnpm test            # node --test, synthetic payloads only
pnpm run typecheck   # tsc --noEmit
pnpm run pack:check  # pnpm pack --dry-run
```

No live endpoints or credentials are used by the test suite.
