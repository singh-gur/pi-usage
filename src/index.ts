/**
 * pi-usage extension entry point.
 *
 * Registers the /usage command (dismissible, scrollable view across all
 * configured quota providers and session token usage) and additive quota/token
 * footer indicators. Background work starts from session lifecycle events only; it is
 * TUI-only, offline-aware, and fully cleared on session shutdown.
 */
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { AuthGateway } from "./auth.ts";
import { FileSharedCoordination } from "./coordination.ts";
import { providersSubmenu, providersSummary, type ProviderPanelContext } from "./provider-settings-ui.ts";
import { UsageMonitor, type MonitorSession } from "./refresh.ts";
import { UsageError, type QuotaAdapter } from "./types.ts";
import { UsageView, formatCacheReadPercent, type UsageEntry } from "./ui.ts";
import { collectSessionUsage, sessionTokenTotals } from "./session-usage.ts";
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
import { anthropicAdapter } from "./providers/anthropic.ts";

/** Fixed supported-provider list. */
const ADAPTERS: readonly QuotaAdapter[] = [
  opencodeGoAdapter,
  openrouterAdapter,
  codexAdapter,
  kimiAdapter,
  zaiAdapter,
  grokAdapter,
  githubCopilotAdapter,
  anthropicAdapter,
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
  const monitor = new UsageMonitor({ adapters: ADAPTERS, coordination: new FileSharedCoordination() });
  let showCacheReadPercent = DEFAULT_USAGE_SETTINGS.showSessionBar;
  let footerContext: ExtensionContext | undefined;
  let quotaStatus: string | undefined;
  let cacheReadStatus: string | undefined;
  let footerGeneration = 0;
  let sessionEpoch = 0;
  let usageOpen = false;
  const renderStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("usage", [cacheReadStatus, quotaStatus].filter(Boolean).join(" · ") || undefined);
  };
  const updateTokenStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    footerContext = ctx;
    cacheReadStatus = showCacheReadPercent
      ? formatCacheReadPercent(sessionTokenTotals(collectSessionUsage(ctx.sessionManager.getBranch())))
      : undefined;
    renderStatus(ctx);
  };
  // Keep both indicators in the package's single additive status section.
  const bindSession = (ctx: ExtensionContext): MonitorSession => {
    const generation = ++footerGeneration;
    return {
      ...sessionFrom(ctx),
      notify: (message) => {
        if (usageOpen || generation !== footerGeneration || ctx.mode !== "tui") return false;
        ctx.ui.notify(message, "info");
        return true;
      },
      setStatus: (_key, text) => {
        if (generation !== footerGeneration || !footerContext) return;
        quotaStatus = text;
        renderStatus(footerContext);
      },
    };
  };

  const loadAndApplySettings = async (ctx: ExtensionContext): Promise<LoadedUsageSettings> => {
    const loaded = await loadUsageSettings(ctx.cwd, ctx.isProjectTrusted());
    showCacheReadPercent = loaded.settings.showSessionBar;
    updateTokenStatus(ctx);
    monitor.setSettings(loaded.settings);
    if (ctx.mode === "tui") {
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    }
    return loaded;
  };

  pi.registerCommand("usage", {
    description: "Show provider quota and session token usage",
    handler: async (_args, ctx) => {
      // Custom TUI view only; print/JSON/RPC modes stay silent.
      if (ctx.mode !== "tui") return;

      const session = bindSession(ctx);
      const epoch = sessionEpoch;
      // Bind on demand if lifecycle events were missed; otherwise keep refs fresh.
      if (!monitor.hasSession) {
        await loadAndApplySettings(ctx);
        monitor.startSession(session, ctx.model?.provider);
      } else monitor.updateSession(session);

      updateTokenStatus(ctx);
      const sessionUsage = collectSessionUsage(ctx.sessionManager.getBranch());
      const adapters = ADAPTERS.filter((adapter) =>
        session.gateway.isConfigured(adapter.id) && !monitor.isReportingDisabled(adapter.id))
        .sort((a, b) => Number(b.id === ctx.model?.provider) - Number(a.id === ctx.model?.provider));
      // Prefill with cached data (verified against current credentials);
      // the refresh below bypasses cache age but respects backoff.
      const entries: UsageEntry[] = adapters.map((adapter) => ({ name: adapter.name }));
      entries.push({ name: "Current session", sessionUsage });
      await Promise.all(
        adapters.map(async (adapter, index) => {
          const cached = await monitor.serveCached(adapter.id);
          if (cached !== undefined) entries[index]!.usage = cached;
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

      let selectedName: string | undefined;
      usageOpen = true;
      try {
        for (;;) {
          const selected = await ctx.ui.custom<UsageEntry | undefined>((tui, theme, _keybindings, done) => {
            const view = new UsageView({
              theme,
              getEntries: () => entries,
              ...(selectedName === undefined ? {} : { selectedName }),
              onClose: () => done(undefined),
              onReset: (entry) => done(entry),
              requestRender: () => tui.requestRender(),
              getViewportRows: () => tui.terminal.rows,
            });
            requestRender = () => tui.requestRender();
            return view;
          });
          requestRender = undefined;
          if (!selected?.usage || epoch !== sessionEpoch) break;
          selectedName = selected.name;
          try {
            const selection = await monitor.prepareReset(selected.usage.providerId);
            const labels = selection.offers.map((offer, index) => `${index + 1}. ${offer.label} — expires ${
              offer.expiresAt === undefined ? "not reported" : new Date(offer.expiresAt).toISOString()}`);
            if (epoch !== sessionEpoch) break;
            const choice = await ctx.ui.select(`${selected.name}: select a reset`, ["Cancel", ...labels]);
            if (epoch !== sessionEpoch) break;
            const index = labels.indexOf(choice ?? "");
            if (index < 0) continue;
            const offer = selection.offers[index]!;
            const windows = selection.usage.windows.map((window) => `${window.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}: ${
              window.usedPercent === undefined ? "usage unknown" : `${100 - window.usedPercent}% remaining`}`).join("; ");
            const confirmation = await ctx.ui.select(`${selected.name}: ${offer.label}. ${windows}. Consuming a reset cannot be undone.`,
              ["Cancel", "Consume reset"]);
            if (confirmation !== "Consume reset") continue;
            const message = await monitor.redeemReset(selection, offer.id);
            if (epoch === sessionEpoch) ctx.ui.notify(message, "info");
          } catch (error) {
            if (epoch === sessionEpoch) ctx.ui.notify(error instanceof UsageError ? error.message : "Reset failed", "warning");
          }
          if (epoch !== sessionEpoch) break;
          const adapter = monitor.adapterFor(selected.usage.providerId);
          if (adapter) selected.usage = await monitor.serveCached(adapter.id) ?? await monitor.refreshProvider(adapter);
        }
      } finally {
        usageOpen = false;
        requestRender = undefined;
      }
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
          label: "Provider footer format",
          description: project ? `inherit uses global value: ${inherited.footerFormat}` : "Provider quota detail; the cache-read percentage is separate",
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
          id: "showSessionBar",
          label: "Cache read percentage",
          description: project ? `inherit uses global value: ${inherited.showSessionBar ? "on" : "off"}` : "Show cache-read tokens as a percentage of all session tokens",
          currentValue: project && file.showSessionBar === undefined
            ? "inherit"
            : (file.showSessionBar ?? DEFAULT_USAGE_SETTINGS.showSessionBar) ? "on" : "off",
          values: project ? ["inherit", "on", "off"] : ["on", "off"],
        },
        {
          id: "resetThresholdPercent",
          label: "Low-quota reset notice",
          description: "Notify below this remaining 5-hour percentage when a reset is available; 0 disables notices",
          currentValue: project && file.resetThresholdPercent === undefined ? "inherit"
            : `${file.resetThresholdPercent ?? DEFAULT_USAGE_SETTINGS.resetThresholdPercent}%`,
          values: [
            ...(project ? ["inherit"] : []),
            ...[...new Set([0, 5, 10, 15, 20, 25, 50, 100,
              file.resetThresholdPercent ?? inherited.resetThresholdPercent])].sort((a, b) => a - b).map((value) => `${value}%`),
          ],
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
      const mergedSettings = () => project
        ? mergeUsageSettings(loaded.global, file)
        : mergeUsageSettings(file, loaded.project);
      // Signed-in providers first, the active model's provider on top.
      const providerRows = ADAPTERS
        .map((adapter) => ({ id: adapter.id, name: adapter.name, configured: ctx.modelRegistry.getProviderAuthStatus(adapter.id).configured }))
        .sort((a, b) => Number(b.id === ctx.model?.provider) - Number(a.id === ctx.model?.provider)
          || Number(b.configured) - Number(a.configured));
      const applySettings = () => {
        changed = true;
        const settings = mergedSettings();
        showCacheReadPercent = settings.showSessionBar;
        updateTokenStatus(ctx);
        monitor.setSettings(settings);
      };

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const providerPanel: ProviderPanelContext = {
          providers: providerRows,
          project,
          file,
          globalProviders: loaded.global.providers,
          flags: () => {
            const settings = mergedSettings();
            return {
              pollLabel: POLL_LABELS[settings.pollIntervalMinutes],
              pollOff: settings.pollIntervalMinutes === 0,
              turnOff: !settings.refreshAfterTurn,
            };
          },
          theme,
          onChange: applySettings,
        };
        items.push({
          id: "providers",
          label: "Providers",
          description: "Per-provider usage reporting: hide a provider, or choose when it refreshes",
          currentValue: providersSummary(providerPanel),
          submenu: providersSubmenu(providerPanel),
        });
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold(`pi-usage settings — ${scope}`)), 1, 1));
        const list = new SettingsList(
          items,
          8,
          getSettingsListTheme(),
          (id, value) => {
            if (id === "providers") return; // the drill-down applies its own changes
            if (value === "inherit") {
              delete file[id as keyof UsageSettingsFile];
            } else if (id === "footerFormat") {
              file.footerFormat = value as FooterFormat;
            } else if (id === "pollIntervalMinutes") {
              file.pollIntervalMinutes = pollMinutes(value);
            } else if (id === "refreshAfterTurn") {
              file.refreshAfterTurn = value === "on";
            } else if (id === "showSessionBar") {
              file.showSessionBar = value === "on";
            } else if (id === "resetThresholdPercent") {
              file.resetThresholdPercent = Number.parseInt(value, 10);
            }
            applySettings();
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
        showCacheReadPercent = loaded.settings.showSessionBar;
        updateTokenStatus(ctx);
        monitor.setSettings(loaded.settings);
        ctx.ui.notify("Could not save pi-usage settings; changes were reverted", "error");
      }
    },
  });

  // Background behavior is session-scoped: started on session_start, cleared
  // on session_shutdown (quit/reload/new/resume/fork all fire shutdown first).
  pi.on("session_start", async (_event, ctx) => {
    await loadAndApplySettings(ctx);
    monitor.startSession(bindSession(ctx), ctx.model?.provider);
  });

  pi.on("model_select", async (event, ctx) => {
    monitor.updateSession(bindSession(ctx));
    monitor.setActiveProvider(event.model.provider);
    updateTokenStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    monitor.updateSession(bindSession(ctx));
    monitor.onAgentSettled();
    updateTokenStatus(ctx);
  });

  // turn_end runs after persistence; message_end runs before it in Pi 1.1.0.
  pi.on("turn_end", async (_event, ctx) => updateTokenStatus(ctx));
  pi.on("session_tree", async (_event, ctx) => updateTokenStatus(ctx));
  pi.on("session_compact", async (_event, ctx) => updateTokenStatus(ctx));

  pi.on("session_shutdown", async () => {
    const ctx = footerContext;
    footerGeneration++;
    sessionEpoch++;
    cacheReadStatus = undefined;
    quotaStatus = undefined;
    footerContext = undefined;
    monitor.shutdown();
    ctx?.ui.setStatus("usage", undefined);
  });
}
