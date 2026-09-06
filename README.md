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
| OpenRouter key | `openrouter` | Key spending cap, remaining dollars, and reported spending |

Providers without credentials configured in Pi are omitted entirely. One account per provider.

## Installation

Requires Node.js ≥ 24.16 and Pi ≥ 0.85.1.

The package is distributed from this Git repository (no npm package). Move a pinned install to a newer ref with `pi install git:github.com/singh-gur/pi-usage@<ref>`; unpinned installs are reconciled by `pi update --extensions`.

Install as a Pi package (latest commit):

```
pi install git:github.com/singh-gur/pi-usage
```

Or pin to a known release (tags `pi-usage-phase-1` … `pi-usage-phase-4` are published checkpoints):

```
pi install git:github.com/singh-gur/pi-usage@pi-usage-phase-4
```

The `https://` protocol URL form works too: `pi install https://github.com/singh-gur/pi-usage`. Review the source before installing — Pi packages run with full system access.

From a Git checkout (local development):

```
git clone git@github.com:singh-gur/pi-usage.git
pi -e ./pi-usage/src/index.ts
```

Credentials are resolved exclusively through Pi (`/login <provider>`); the extension never reads credential stores, `.env` files, or browsers. Codex and Grok quota requires OAuth (subscription) credentials — plain API keys are rejected before any request.

## Usage

Run `/usage` in Pi (TUI mode) for a scrollable, tabbed dashboard: one tab per configured provider, consumed/remaining bars where a ratio is safe, reset timing, exact values, and explicit partial/error states. The view dismisses with `esc`/`enter`/`q`.

The footer indicator is additive (`setStatus`, never a footer replacement) and shows, for the active provider only: remaining allowance, reset countdown where known, data age, and explicit `stale` / error labels.

## Automatic refresh schedule

All automatic networking is TUI-only and suppressed under `PI_OFFLINE`; print/JSON/RPC modes stay silent.

- **Session start and model switch:** refresh the active provider (model switches within the same provider do not re-fetch — the quota is unchanged).
- **After each turn** (`agent_settled`): refresh only when cached data is ≥ 60 s old or a reset time has passed.
- **Every 5 minutes:** poll the active provider only. No provider is background-polled while inactive.
- Overlapping command/event/timer requests are deduplicated; failed refreshes back off exponentially (30 s doubling, 5 min cap) and valid server `Retry-After` guidance is honored.
- `/usage` bypasses cache age but respects server-imposed backoff.

## Data, errors, and safety

- Every network call is a GET to a fixed official provider endpoint (no writes, no inference calls). Custom provider base URLs/proxies are refused before credentials leave the process.
- Quota results are in-memory only, partitioned by a salted per-process credential fingerprint: switching accounts never shows the previous account's data.
- Legitimate zeros are preserved; missing, malformed, or unsupported values stay unknown — never reported as zero.
- Failures render as fixed, sanitized error categories (auth, subscription, unsupported, request, timeout); raw bodies, tokens, and account identifiers are never displayed.
- A passed reset time means fresh data is needed, never an assumed replenishment.
- Known limitation (Grok free plans): the billing endpoint's payload for an account without coding credits is indistinguishable from a paid account at 0% after reset, so the weekly period shows as fully remaining even though model calls may fail with the model API's own credit error.

## Development

```
pnpm install --frozen-lockfile
pnpm test            # node --test, synthetic payloads only
pnpm run typecheck   # tsc --noEmit
pnpm run pack:check  # pnpm pack --dry-run
```

No live endpoints or credentials are used by the test suite.
