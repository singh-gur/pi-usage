/**
 * pi-usage extension entry point.
 *
 * Registers the /usage command: refreshes all configured supported providers
 * concurrently and shows a dismissible, scrollable view with independent
 * per-provider loading/results/errors. Read-only; no automatic polling in
 * this phase.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuthGateway } from "./auth.ts";
import { resolveQuotaAuth } from "./auth.ts";
import { DEFAULT_HTTP_LIMITS, bounded, createGetJson, isOffline } from "./http.ts";
import { UsageError, type ProviderUsage, type QuotaAdapter } from "./types.ts";
import { UsageView, type UsageEntry } from "./ui.ts";
import { opencodeGoAdapter } from "./providers/opencode-go.ts";
import { openrouterAdapter } from "./providers/openrouter.ts";
import { codexAdapter } from "./providers/codex.ts";
import { kimiAdapter } from "./providers/kimi.ts";
import { zaiAdapter } from "./providers/zai.ts";

/** Fixed supported-provider list (grows in later phases). */
const ADAPTERS: readonly QuotaAdapter[] = [
  opencodeGoAdapter,
  openrouterAdapter,
  codexAdapter,
  kimiAdapter,
  zaiAdapter,
];

/** Whole-provider bound, including waiting for auth resolution. */
const PROVIDER_BOUND_MS = 30_000;

function errorUsage(adapter: QuotaAdapter, error: UsageError, capturedAt: number): ProviderUsage {
  return {
    providerId: adapter.id,
    providerName: adapter.name,
    domainLabel: adapter.domainLabel,
    capturedAt,
    windows: [],
    error: { kind: error.kind, message: error.message },
  };
}

async function refreshProvider(
  adapter: QuotaAdapter,
  gateway: AuthGateway,
  signal: AbortSignal,
): Promise<ProviderUsage> {
  const startedAt = Date.now();
  const work = (async () => {
    const auth = await resolveQuotaAuth(gateway, adapter.id, adapter.officialOrigin);
    if (auth instanceof UsageError) return errorUsage(adapter, auth, startedAt);
    return await adapter.fetchQuota(auth, createGetJson(DEFAULT_HTTP_LIMITS, signal));
  })();
  try {
    return await bounded(work, PROVIDER_BOUND_MS);
  } catch (error) {
    const usageError =
      error instanceof UsageError ? error : new UsageError("request", "Provider refresh failed");
    return errorUsage(adapter, usageError, Date.now());
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show provider quota and allowance usage",
    handler: async (_args, ctx) => {
      // Custom TUI view only; print/JSON/RPC modes stay silent (phase 4 formalizes).
      if (ctx.mode !== "tui") return;

      const gateway: AuthGateway = {
        isConfigured: (id) => ctx.modelRegistry.getProviderAuthStatus(id).configured,
        resolveAuth: (id) => ctx.modelRegistry.getProviderAuth(id),
        providerInfo: (id) => ctx.modelRegistry.getProvider(id) ?? undefined,
      };

      // Only providers with credentials configured in Pi are shown and queried.
      // The not-configured error kind stays as a safety net for resolution races.
      const adapters = ADAPTERS.filter((adapter) => gateway.isConfigured(adapter.id));
      if (adapters.length === 0) {
        ctx.ui.notify("No supported providers are configured in Pi", "info");
        return;
      }

      const controller = new AbortController();
      const entries: UsageEntry[] = adapters.map((adapter) => ({ name: adapter.name }));
      let requestRender: (() => void) | undefined = () => {};
      const onUpdate = () => requestRender?.();

      void Promise.all(
        adapters.map(async (adapter, index) => {
          const usage = isOffline()
            ? errorUsage(
                adapter,
                new UsageError("canceled", "Quota networking suppressed (PI_OFFLINE)"),
                Date.now(),
              )
            : await refreshProvider(adapter, gateway, controller.signal);
          entries[index]!.usage = usage;
          onUpdate();
        }),
      );

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const view = new UsageView({
          theme,
          getEntries: () => entries,
          onClose: () => {
            controller.abort();
            done(undefined);
          },
          requestRender: () => tui.requestRender(),
          getViewportRows: () => tui.terminal.rows,
        });
        requestRender = () => tui.requestRender();
        return view;
      });
      // View closed: discard late package-owned work.
      controller.abort();
    },
  });
}
