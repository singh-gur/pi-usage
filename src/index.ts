/**
 * pi-usage extension entry point.
 *
 * Registers the /usage command (dismissible, scrollable view across all
 * configured supported providers) and the automatic active-provider footer
 * indicator. Background work starts from session lifecycle events only; it is
 * TUI-only, offline-aware, and fully cleared on session shutdown.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuthGateway } from "./auth.ts";
import { UsageMonitor, type MonitorSession } from "./refresh.ts";
import type { QuotaAdapter } from "./types.ts";
import { UsageView, type UsageEntry } from "./ui.ts";
import { opencodeGoAdapter } from "./providers/opencode-go.ts";
import { openrouterAdapter } from "./providers/openrouter.ts";
import { codexAdapter } from "./providers/codex.ts";
import { kimiAdapter } from "./providers/kimi.ts";
import { zaiAdapter } from "./providers/zai.ts";
import { grokAdapter } from "./providers/grok.ts";

/** Fixed supported-provider list. */
const ADAPTERS: readonly QuotaAdapter[] = [
  opencodeGoAdapter,
  openrouterAdapter,
  codexAdapter,
  kimiAdapter,
  zaiAdapter,
  grokAdapter,
];

function sessionFrom(ctx: {
  mode: string;
  modelRegistry: {
    getProviderAuthStatus(id: string): { configured: boolean };
    getProviderAuth(id: string): Promise<unknown>;
    getProvider(id: string): unknown;
  };
  ui: { setStatus(key: string, text: string | undefined): void };
}): MonitorSession {
  return {
    mode: ctx.mode,
    gateway: {
      isConfigured: (id) => ctx.modelRegistry.getProviderAuthStatus(id).configured,
      resolveAuth: (id) => ctx.modelRegistry.getProviderAuth(id) as never,
      providerInfo: (id) => (ctx.modelRegistry.getProvider(id) ?? undefined) as never,
    } satisfies AuthGateway,
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
  };
}

export default function (pi: ExtensionAPI) {
  const monitor = new UsageMonitor({ adapters: ADAPTERS });

  pi.registerCommand("usage", {
    description: "Show provider quota and allowance usage",
    handler: async (_args, ctx) => {
      // Custom TUI view only; print/JSON/RPC modes stay silent.
      if (ctx.mode !== "tui") return;

      const session = sessionFrom(ctx);
      // Bind on demand if lifecycle events were missed; otherwise keep refs fresh.
      if (!monitor.hasSession) monitor.startSession(session, ctx.model?.provider);
      else monitor.updateSession(session);

      const adapters = ADAPTERS.filter((adapter) => session.gateway.isConfigured(adapter.id));
      if (adapters.length === 0) {
        ctx.ui.notify("No supported providers are configured in Pi", "info");
        return;
      }

      // Prefill with cached data (verified against current credentials);
      // the refresh below bypasses cache age but respects backoff.
      const entries: UsageEntry[] = adapters.map((adapter) => ({ name: adapter.name }));
      await Promise.all(
        adapters.map(async (adapter, index) => {
          const cached = await monitor.serveCached(adapter.id);
          if (cached !== undefined) entries[index] = { name: adapter.name, usage: cached };
        }),
      );
      let requestRender: (() => void) | undefined = () => {};
      const onUpdate = () => requestRender?.();

      void Promise.all(
        adapters.map(async (adapter, index) => {
          entries[index]!.usage = await monitor.refreshProvider(adapter);
          onUpdate();
        }),
      );

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const view = new UsageView({
          theme,
          getEntries: () => entries,
          onClose: () => {
            // Shared refreshes also serve the footer; do not abort them here.
            done(undefined);
          },
          requestRender: () => tui.requestRender(),
          getViewportRows: () => tui.terminal.rows,
        });
        requestRender = () => tui.requestRender();
        return view;
      });
    },
  });

  // Background behavior is session-scoped: started on session_start, cleared
  // on session_shutdown (quit/reload/new/resume/fork all fire shutdown first).
  pi.on("session_start", async (_event, ctx) => {
    monitor.startSession(sessionFrom(ctx as never), (ctx as { model?: { provider?: string } }).model?.provider);
  });

  pi.on("model_select", async (event, ctx) => {
    monitor.updateSession(sessionFrom(ctx as never));
    monitor.setActiveProvider(event.model.provider);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    monitor.updateSession(sessionFrom(ctx as never));
    monitor.onAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    monitor.shutdown();
  });
}
