/**
 * pi-usage extension entry point.
 *
 * Registers the /usage command (dismissible, scrollable view across all
 * configured supported providers) and the automatic active-provider footer
 * indicator. Background work starts from session lifecycle events only; it is
 * TUI-only, offline-aware, and fully cleared on session shutdown.
 */
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { AuthGateway } from "./auth.ts";
import { UsageMonitor, type MonitorSession } from "./refresh.ts";
import type { QuotaAdapter } from "./types.ts";
import { UsageView, type UsageEntry } from "./ui.ts";
import {
  DEFAULT_USAGE_SETTINGS,
  loadUsageSettings,
  mergeUsageSettings,
  saveUsageSettings,
  type FooterFormat,
  type LoadedUsageSettings,
  type PollIntervalMinutes,
  type UsageSettingsFile,
} from "./settings.ts";
import { opencodeGoAdapter } from "./providers/opencode-go.ts";
import { openrouterAdapter } from "./providers/openrouter.ts";
import { codexAdapter } from "./providers/codex.ts";
import { kimiAdapter } from "./providers/kimi.ts";
import { zaiAdapter } from "./providers/zai.ts";
import { grokAdapter } from "./providers/grok.ts";
import { githubCopilotAdapter } from "./providers/github-copilot.ts";

/** Fixed supported-provider list. */
const ADAPTERS: readonly QuotaAdapter[] = [
  opencodeGoAdapter,
  openrouterAdapter,
  codexAdapter,
  kimiAdapter,
  zaiAdapter,
  grokAdapter,
  githubCopilotAdapter,
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

const POLL_LABELS: Record<PollIntervalMinutes, string> = {
  0: "off",
  1: "1 min",
  5: "5 min",
  15: "15 min",
  30: "30 min",
};

function pollMinutes(value: string): PollIntervalMinutes {
  const entry = Object.entries(POLL_LABELS).find(([, label]) => label === value);
  return Number(entry?.[0] ?? DEFAULT_USAGE_SETTINGS.pollIntervalMinutes) as PollIntervalMinutes;
}

export default function (pi: ExtensionAPI) {
  const monitor = new UsageMonitor({ adapters: ADAPTERS });

  const loadAndApplySettings = async (ctx: ExtensionContext): Promise<LoadedUsageSettings> => {
    const loaded = await loadUsageSettings(ctx.cwd, ctx.isProjectTrusted());
    monitor.setSettings(loaded.settings);
    if (ctx.mode === "tui") {
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    }
    return loaded;
  };

  pi.registerCommand("usage", {
    description: "Show provider quota and allowance usage",
    handler: async (_args, ctx) => {
      // Custom TUI view only; print/JSON/RPC modes stay silent.
      if (ctx.mode !== "tui") return;

      const session = sessionFrom(ctx);
      // Bind on demand if lifecycle events were missed; otherwise keep refs fresh.
      if (!monitor.hasSession) {
        await loadAndApplySettings(ctx);
        monitor.startSession(session, ctx.model?.provider);
      } else monitor.updateSession(session);

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

  pi.registerCommand("usage-settings", {
    description: "Configure pi-usage footer and refresh behavior",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;

      const loaded = await loadAndApplySettings(ctx);
      const scopes = ctx.isProjectTrusted() ? ["Global", "Project"] : ["Global"];
      const scope = await ctx.ui.select("pi-usage settings scope", scopes);
      if (scope === undefined) return;

      const project = scope === "Project";
      const file: UsageSettingsFile = { ...(project ? loaded.project : loaded.global) };
      const path = project ? loaded.paths.project : loaded.paths.global;
      let changed = false;
      const inherited = mergeUsageSettings(loaded.global);
      const items: SettingItem[] = [
        {
          id: "footerFormat",
          label: "Footer format",
          description: project ? `inherit uses global value: ${inherited.footerFormat}` : "Full, compact, or disabled",
          currentValue: project && file.footerFormat === undefined ? "inherit" : (file.footerFormat ?? DEFAULT_USAGE_SETTINGS.footerFormat),
          values: project ? ["inherit", "full", "compact", "off"] : ["full", "compact", "off"],
        },
        {
          id: "pollIntervalMinutes",
          label: "Poll interval",
          description: project ? `inherit uses global value: ${POLL_LABELS[inherited.pollIntervalMinutes]}` : "Periodic active-provider refresh; off disables polling",
          currentValue: project && file.pollIntervalMinutes === undefined
            ? "inherit"
            : POLL_LABELS[file.pollIntervalMinutes ?? DEFAULT_USAGE_SETTINGS.pollIntervalMinutes],
          values: project
            ? ["inherit", "off", "1 min", "5 min", "15 min", "30 min"]
            : ["off", "1 min", "5 min", "15 min", "30 min"],
        },
        {
          id: "refreshAfterTurn",
          label: "Refresh after turn",
          description: project ? `inherit uses global value: ${inherited.refreshAfterTurn ? "on" : "off"}` : "Refresh after a settled turn when cached data is at least one minute old",
          currentValue: project && file.refreshAfterTurn === undefined
            ? "inherit"
            : (file.refreshAfterTurn ?? DEFAULT_USAGE_SETTINGS.refreshAfterTurn) ? "on" : "off",
          values: project ? ["inherit", "on", "off"] : ["on", "off"],
        },
      ];

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold(`pi-usage settings — ${scope}`)), 1, 1));
        const list = new SettingsList(
          items,
          8,
          getSettingsListTheme(),
          (id, value) => {
            changed = true;
            if (value === "inherit") {
              delete file[id as keyof UsageSettingsFile];
            } else if (id === "footerFormat") {
              file.footerFormat = value as FooterFormat;
            } else if (id === "pollIntervalMinutes") {
              file.pollIntervalMinutes = pollMinutes(value);
            } else if (id === "refreshAfterTurn") {
              file.refreshAfterTurn = value === "on";
            }
            monitor.setSettings(project
              ? mergeUsageSettings(loaded.global, file)
              : mergeUsageSettings(file, loaded.project));
          },
          () => done(undefined),
        );
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", path), 1, 0));
        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!changed) return;
      try {
        await saveUsageSettings(path, file);
        ctx.ui.notify(`Saved ${scope.toLowerCase()} pi-usage settings`, "info");
      } catch {
        monitor.setSettings(loaded.settings);
        ctx.ui.notify("Could not save pi-usage settings; changes were reverted", "error");
      }
    },
  });

  // Background behavior is session-scoped: started on session_start, cleared
  // on session_shutdown (quit/reload/new/resume/fork all fire shutdown first).
  pi.on("session_start", async (_event, ctx) => {
    await loadAndApplySettings(ctx);
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
