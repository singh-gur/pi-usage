/**
 * /usage-settings drill-down for per-provider reporting:
 * Providers row -> provider list (what each provider does) -> provider panel
 * (three independent toggles). Pure helpers are exported for tests.
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { ProviderUsageSettings, UsageSettingsFile } from "./settings.ts";

export type ProviderToggle = "show" | "poll" | "turn";
export type ToggleValue = "inherit" | "on" | "off";

const FIELD = { show: "disabled", poll: "poll", turn: "refreshAfterTurn" } as const;

/** Displayed value of one toggle; "inherit" only exists at project scope. */
export function toggleValue(entry: ProviderUsageSettings | undefined, toggle: ProviderToggle, project: boolean): ToggleValue {
  const raw = entry?.[FIELD[toggle]];
  if (raw === undefined) return project ? "inherit" : "on";
  // "show" is stored inverted as `disabled`.
  return (toggle === "show" ? raw === false : raw === true) ? "on" : "off";
}

/** Write one toggle into the scope file, pruning entries that become empty. */
export function applyToggle(file: UsageSettingsFile, providerId: string, toggle: ProviderToggle, value: ToggleValue, project: boolean): void {
  const providers = (file.providers ??= {});
  const entry = (providers[providerId] ??= {});
  const field = FIELD[toggle];
  // Global "on" is the default (omit); project "on" is an explicit override of the global value.
  if (value === "inherit" || (value === "on" && !project)) delete entry[field];
  else entry[field] = toggle === "show" ? value === "off" : value === "on";
  if (Object.keys(entry).length === 0) delete providers[providerId];
  if (Object.keys(providers).length === 0) delete file.providers;
}

/** One-line description of what a provider does, from its effective switches. */
export function describeProvider(entry: ProviderUsageSettings | undefined): string {
  if (entry?.disabled === true) return "hidden · no requests";
  const timed = entry?.poll !== false;
  const turn = entry?.refreshAfterTurn !== false;
  if (timed && turn) return "on · timed + after-turn refresh";
  if (timed) return "on · timed refresh only";
  if (turn) return "on · after-turn refresh only";
  return "on · manual refresh only";
}

const isCustomized = (entry: ProviderUsageSettings | undefined): boolean =>
  entry?.disabled === true || entry?.poll === false || entry?.refreshAfterTurn === false;

export interface ProviderPanelContext {
  /** Display order is the caller's: signed-in providers first. */
  providers: ReadonlyArray<{ id: string; name: string; configured: boolean }>;
  project: boolean;
  /** The scope file being edited; mutated in place. */
  file: UsageSettingsFile;
  /** Global entries, shown as the inherited value at project scope. */
  globalProviders: UsageSettingsFile["providers"];
  /** Current effective global switches, for accurate descriptions. */
  flags(): { pollLabel: string; pollOff: boolean; turnOff: boolean };
  theme: { fg(color: "accent" | "dim", text: string): string; bold(text: string): string };
  /** Called after every mutation of `file`. */
  onChange(): void;
}

/** What the provider effectively does in the edited scope (project merges global). */
function effective(ctx: ProviderPanelContext, providerId: string): ProviderUsageSettings | undefined {
  const own = ctx.file.providers?.[providerId];
  return ctx.project ? { ...ctx.globalProviders?.[providerId], ...own } : own;
}

export function providersSummary(ctx: ProviderPanelContext): string {
  const count = ctx.providers.filter((provider) => isCustomized(effective(ctx, provider.id))).length;
  return count === 0 ? "all default" : `${count} customized`;
}

function panel(title: string, subtitle: string, ctx: ProviderPanelContext, list: SettingsList): Component {
  const header = new Container();
  header.addChild(new Text(ctx.theme.fg("accent", ctx.theme.bold(title)), 1, 0));
  header.addChild(new Text(ctx.theme.fg("dim", subtitle), 1, 1));
  return {
    render: (width) => [...header.render(width), ...list.render(width)],
    invalidate: () => {
      header.invalidate();
      list.invalidate();
    },
    handleInput: (data) => list.handleInput(data),
  };
}

function providerPanel(ctx: ProviderPanelContext, provider: ProviderPanelContext["providers"][number], done: (summary?: string) => void): Component {
  const { project } = ctx;
  const flags = ctx.flags();
  const inheritNote = (toggle: ProviderToggle) => project
    ? ` Inherit uses the global value: ${toggleValue(ctx.globalProviders?.[provider.id], toggle, false)}.`
    : "";
  const item = (id: ProviderToggle, label: string, description: string): SettingItem => ({
    id,
    label,
    description: description + inheritNote(id),
    currentValue: toggleValue(ctx.file.providers?.[provider.id], id, project),
    values: project ? ["inherit", "on", "off"] : ["on", "off"],
  });
  const items = [
    item("show", "Report usage",
      "Off: no quota requests for this provider, and it disappears from the footer and /usage."),
    item("poll", "Timed refresh",
      flags.pollOff
        ? "Globally off (Poll interval is off); this switch cannot turn it back on."
        : `Re-check quota every ${flags.pollLabel} while this provider's model is active. Off: only on start, model switch, turn end, or /usage.`),
    item("turn", "Refresh after turn",
      flags.turnOff
        ? "Globally off (Refresh after turn is off); this switch cannot turn it back on."
        : "Re-check quota after a turn finishes when the data is over a minute old."),
  ];
  const list = new SettingsList(
    items,
    6,
    getSettingsListTheme(),
    (id, value) => {
      applyToggle(ctx.file, provider.id, id as ProviderToggle, value as ToggleValue, project);
      ctx.onChange();
    },
    () => done(describeProvider(effective(ctx, provider.id))),
  );
  return panel(`Providers › ${provider.name}`, "Changes apply immediately · Esc goes back", ctx, list);
}

/** Row text: what the provider does; unconfigured providers stay quiet until customized. */
function rowValue(ctx: ProviderPanelContext, provider: ProviderPanelContext["providers"][number]): string {
  const entry = effective(ctx, provider.id);
  if (provider.configured) return describeProvider(entry);
  return isCustomized(entry) ? `${describeProvider(entry)} · not configured` : "not configured";
}

/** Submenu for the main list's "Providers" row. */
export function providersSubmenu(ctx: ProviderPanelContext): NonNullable<SettingItem["submenu"]> {
  return (_current, done) => {
    const items: SettingItem[] = ctx.providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      currentValue: rowValue(ctx, provider),
      submenu: (_value, closeDetail) => providerPanel(ctx, provider, closeDetail),
    }));
    // No header here: a nested panel swaps in below the outer title, so a header would stack.
    return new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      () => {}, // detail panels apply their own changes; this only refreshes the row text
      () => done(providersSummary(ctx)),
    );
  };
}
