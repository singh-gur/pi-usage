/**
 * Dismissible, scrollable /usage view and pure line rendering.
 *
 * The UI consumes only the normalized ProviderUsage contract; no
 * provider-specific parsing happens here. Color is always paired with text.
 */
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderUsage, QuotaWindow } from "./types.ts";

/** Structural theme slice; the real Pi theme satisfies this. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface UsageEntry {
  name: string;
  /** Undefined while the provider refresh is still in flight. */
  usage?: ProviderUsage;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatQuotaValue(value: number, unit: string): string {
  if (unit === "USD") return `$${formatNumber(value)}`;
  return `${formatNumber(value)} ${unit}`;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  return `${formatDuration(ms)} ago`;
}

function sameUnit(a: { unit: string } | undefined, b: { unit: string } | undefined): boolean {
  return a !== undefined && b !== undefined && a.unit === b.unit;
}

function usedPercent(window: QuotaWindow): number | undefined {
  let value = window.usedPercent;
  if (value === undefined && window.limit && window.limit.value > 0) {
    if (sameUnit(window.used, window.limit) && window.used!.value >= 0) {
      value = (window.used!.value / window.limit.value) * 100;
    } else if (sameUnit(window.remaining, window.limit) && window.remaining!.value >= 0) {
      value = 100 - (window.remaining!.value / window.limit.value) * 100;
    }
  }
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(100, value));
}

function remainingSummary(window: QuotaWindow, consumed: number): { text: string; includesLimit: boolean } {
  if (window.remaining) {
    if (sameUnit(window.remaining, window.limit)) {
      const unit = window.remaining.unit;
      const values = unit === "USD"
        ? `${formatQuotaValue(window.remaining.value, unit)} / ${formatQuotaValue(window.limit!.value, unit)}`
        : `${formatNumber(window.remaining.value)} / ${formatNumber(window.limit!.value)} ${unit}`;
      return { text: `${values} left`, includesLimit: true };
    }
    return { text: `${formatQuotaValue(window.remaining.value, window.remaining.unit)} left`, includesLimit: false };
  }
  return { text: `${formatPercent(100 - consumed)} left`, includesLimit: false };
}

function quotaBar(width: number, consumed: number, theme: ThemeLike): string {
  const filled = consumed > 0 ? Math.max(1, Math.round(width * consumed / 100)) : 0;
  return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function detailParts(window: QuotaWindow, includesLimit: boolean): string[] {
  const parts: string[] = [];
  if (window.resetsAt !== undefined) {
    parts.push(
      window.resetsAt > Date.now()
        ? `Resets in ${formatDuration(window.resetsAt - Date.now())}`
        : "Reset time passed",
    );
  }
  if (window.resetCadence) parts.push(`Resets ${window.resetCadence}`);
  if (window.used) parts.push(`${formatQuotaValue(window.used.value, window.used.unit)} used`);
  if (!includesLimit && window.limit) parts.push(`cap ${formatQuotaValue(window.limit.value, window.limit.unit)}`);
  return parts;
}

function windowLines(window: QuotaWindow, theme: ThemeLike, width: number): string[] {
  const status = window.status === "rate-limited" ? theme.fg("warning", " [rate-limited]") : "";
  const lines = [`  ${window.label}${status}`];
  const consumed = usedPercent(window);
  if (consumed === undefined) {
    const facts: string[] = [];
    if (window.used) facts.push(`${formatQuotaValue(window.used.value, window.used.unit)} used`);
    if (window.remaining) facts.push(`${formatQuotaValue(window.remaining.value, window.remaining.unit)} remaining`);
    if (window.limit) facts.push(`cap ${formatQuotaValue(window.limit.value, window.limit.unit)}`);
    if (window.resetsAt !== undefined) {
      facts.push(window.resetsAt > Date.now() ? `Resets in ${formatDuration(window.resetsAt - Date.now())}` : "Reset time passed");
    }
    if (window.resetCadence) facts.push(`Resets ${window.resetCadence}`);
    if (facts.length > 0) lines.push(theme.fg("dim", `  ${facts.join(" · ")}`));
    return lines;
  }

  const summary = remainingSummary(window, consumed);
  const summaryColor = 100 - consumed <= 10 ? "warning" : "success";
  const inlineWidth = Math.min(42, width - 4 - visibleWidth(summary.text));
  if (inlineWidth >= 10) {
    lines.push(`  ${quotaBar(inlineWidth, consumed, theme)}  ${theme.fg(summaryColor, summary.text)}`);
  } else {
    lines.push(`  ${quotaBar(Math.max(1, Math.min(42, width - 2)), consumed, theme)}`);
    lines.push(theme.fg(summaryColor, `  ${summary.text}`));
  }
  const details = detailParts(window, summary.includesLimit);
  if (details.length > 0) lines.push(theme.fg("dim", `  ${details.join(" · ")}`));
  return lines;
}

const ERROR_COLOR: Record<string, string> = {
  "not-configured": "dim",
  auth: "warning",
  subscription: "warning",
  unsupported: "warning",
  request: "error",
  timeout: "error",
  canceled: "dim",
};

function providerLines(entry: UsageEntry, theme: ThemeLike, width: number, showName = true): string[] {
  const lines = showName ? [theme.fg("accent", theme.bold(entry.name))] : [];
  const usage = entry.usage;
  if (!usage) return [...lines, theme.fg("dim", "  refreshing…")];

  lines.push(theme.fg("dim", `  ${usage.domainLabel} — updated ${formatAge(Date.now() - usage.capturedAt)}`));
  if (usage.error) {
    const color = ERROR_COLOR[usage.error.kind] ?? "warning";
    const label = usage.error.kind === "not-configured" ? "not configured: " : `${usage.error.kind}: `;
    lines.push(theme.fg(color, `  ${label}${usage.error.message}`));
  }
  for (const window of usage.windows) lines.push(...windowLines(window, theme, width));
  if (usage.partialNotice) lines.push(theme.fg("warning", `  partial data: ${usage.partialNotice}`));
  return lines;
}

/** Pure rendering of the whole view body (without scroll chrome). */
export function renderUsageLines(entries: UsageEntry[], theme: ThemeLike, width = 80): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) lines.push("");
    lines.push(...providerLines(entries[i]!, theme, width));
  }
  return lines;
}

function tabLine(entries: UsageEntry[], selected: number, theme: ThemeLike, width: number): string {
  const tabs = entries.map((entry, index) =>
    index === selected
      ? theme.fg("accent", theme.bold(`[${entry.name}]`))
      : theme.fg("dim", ` ${entry.name} `),
  );
  const full = tabs.join(" ");
  if (visibleWidth(full) <= width) return full;
  return truncateToWidth(
    `${theme.fg("dim", "‹ ")}${tabs[selected]}${theme.fg("dim", ` ›  ${selected + 1}/${entries.length}`)}`,
    width,
  );
}

/**
 * Scrollable custom component shown via ctx.ui.custom(). Renders the shared
 * snapshot; the command layer invalidates it as providers complete.
 */
export class UsageView {
  private offset = 0;
  private selected = 0;
  private readonly theme: ThemeLike;
  private readonly getEntries: () => UsageEntry[];
  private readonly onClose: () => void;
  private readonly requestRender: () => void;
  private readonly getViewportRows: (() => number) | undefined;
  private readonly fixedMaxRows: number | undefined;

  constructor(options: {
    theme: ThemeLike;
    getEntries: () => UsageEntry[];
    onClose: () => void;
    /** Trigger a TUI repaint after input-driven state changes. */
    requestRender: () => void;
    /** Terminal height source; the viewport uses it minus reserved chrome rows. */
    getViewportRows?: () => number;
    /** Explicit viewport height override (tests); defaults to terminal-derived. */
    maxRows?: number;
  }) {
    this.theme = options.theme;
    this.getEntries = options.getEntries;
    this.onClose = options.onClose;
    this.requestRender = options.requestRender;
    this.getViewportRows = options.getViewportRows;
    this.fixedMaxRows = options.maxRows;
  }

  /** Rows of content to show: fit the available terminal height (footer,
   *  working row, and margins reserved), never a fixed count. */
  private viewportRows(): number {
    if (this.fixedMaxRows !== undefined) return this.fixedMaxRows;
    const termRows = this.getViewportRows?.() ?? 24;
    return Math.max(4, termRows - 4);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
      this.onClose();
      return;
    }
    const count = this.getEntries().length;
    if (count > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) || data === "h")) {
      this.selected = (this.selected - 1 + count) % count;
      this.offset = 0;
      this.requestRender();
      return;
    }
    if (count > 1 && (matchesKey(data, Key.right) || matchesKey(data, Key.tab) || data === "l")) {
      this.selected = (this.selected + 1) % count;
      this.offset = 0;
      this.requestRender();
      return;
    }
    const rows = Math.max(1, this.viewportRows() - 1);
    if (matchesKey(data, Key.up) || data === "k") {
      this.offset = Math.max(0, this.offset - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.offset += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - rows);
    } else if (matchesKey(data, Key.pageDown)) {
      this.offset += rows;
    } else if (matchesKey(data, Key.home)) {
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.offset = Number.MAX_SAFE_INTEGER;
    } else {
      return; // unhandled key: no repaint needed
    }
    // Scrolling changed visible content; the TUI does not repaint on its own.
    this.requestRender();
  }

  render(width: number): string[] {
    const entries = this.getEntries();
    this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
    const tabs = entries.length > 0 ? [tabLine(entries, this.selected, this.theme, width)] : [];
    const bodies = entries.map((entry) => providerLines(entry, this.theme, width, false));
    const body = bodies[this.selected] ?? [];
    const availableRows = Math.max(1, this.viewportRows() - tabs.length);
    const rows = Math.min(availableRows, Math.max(0, ...bodies.map((lines) => lines.length)));
    const maxOffset = Math.max(0, body.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const visibleBody = body.slice(this.offset, this.offset + rows);
    visibleBody.push(...Array<string>(rows - visibleBody.length).fill(""));
    const scrolled = maxOffset > 0 && this.offset > 0;
    const tabHint = entries.length > 1 ? "←→/hl/tab tabs · " : "";
    const hint = scrolled
      ? this.theme.fg("dim", `${tabHint}↑↓/jk (${this.offset + 1}-${Math.min(this.offset + rows, body.length)} of ${body.length}) · esc close`)
      : this.theme.fg("dim", `${tabHint}↑↓/jk scroll · esc close`);
    const view = [...tabs, ...visibleBody, hint];
    return view.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    // Rendering is stateless apart from the scroll offset; nothing to clear.
  }
}
