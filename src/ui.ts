/**
 * Dismissible, scrollable /usage view and pure line rendering.
 *
 * The UI consumes only the normalized ProviderUsage contract; no
 * provider-specific parsing happens here. Color is always paired with text.
 */
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
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
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  return `${formatDuration(ms)} ago`;
}

function windowLine(window: QuotaWindow, theme: ThemeLike): string {
  const parts: string[] = [window.label.padEnd(9)];
  if (window.usedPercent !== undefined) parts.push(`${formatPercent(window.usedPercent)} used`);
  if (window.used) parts.push(`${formatQuotaValue(window.used.value, window.used.unit)} used`);
  if (window.remaining) {
    parts.push(`${formatQuotaValue(window.remaining.value, window.remaining.unit)} remaining`);
  }
  if (window.limit) parts.push(`cap ${formatQuotaValue(window.limit.value, window.limit.unit)}`);
  if (window.resetsAt !== undefined) {
    parts.push(
      window.resetsAt > Date.now()
        ? `resets in ${formatDuration(window.resetsAt - Date.now())}`
        : "reset time passed",
    );
  }
  if (window.resetCadence) parts.push(`resets ${window.resetCadence}`);
  let line = "  " + parts.join(" · ");
  if (window.status === "rate-limited") {
    line += " " + theme.fg("warning", "[rate-limited]");
  }
  return line;
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

function providerLines(entry: UsageEntry, theme: ThemeLike): string[] {
  const header = theme.bold(entry.name);
  const usage = entry.usage;
  if (!usage) {
    return [header, theme.fg("dim", "  refreshing…")];
  }
  const lines = [header];
  const domain = `${entry.name} — ${usage.domainLabel}`;
  lines[0] = theme.bold(domain);
  lines.push(theme.fg("dim", `  captured ${formatAge(Date.now() - usage.capturedAt)}`));
  if (usage.error) {
    const color = ERROR_COLOR[usage.error.kind] ?? "warning";
    const label =
      usage.error.kind === "not-configured" ? "not configured: " : `${usage.error.kind}: `;
    lines.push(theme.fg(color, `  ${label}${usage.error.message}`));
  }
  for (const window of usage.windows) {
    lines.push(windowLine(window, theme));
  }
  if (usage.partialNotice) {
    lines.push(theme.fg("warning", `  partial data: ${usage.partialNotice}`));
  }
  return lines;
}

/** Pure rendering of the whole view body (without scroll chrome). */
export function renderUsageLines(entries: UsageEntry[], theme: ThemeLike): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) lines.push("");
    lines.push(...providerLines(entries[i]!, theme));
  }
  return lines;
}

/**
 * Scrollable custom component shown via ctx.ui.custom(). Renders the shared
 * snapshot; the command layer invalidates it as providers complete.
 */
export class UsageView {
  private offset = 0;
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
    const rows = this.viewportRows();
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
    const body = renderUsageLines(this.getEntries(), this.theme);
    const lines = [...body];
    const rows = this.viewportRows();
    const maxOffset = Math.max(0, lines.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const scrolled = maxOffset > 0 && this.offset > 0;
    const hint = scrolled
      ? this.theme.fg("dim", `↑↓/jk scroll (${this.offset + 1}-${Math.min(this.offset + rows, lines.length)} of ${lines.length}) · esc close`)
      : this.theme.fg("dim", "↑↓/jk scroll · pgup/pgdn · esc close");
    const view = [...lines.slice(this.offset, this.offset + rows), hint];
    return view.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    // Rendering is stateless apart from the scroll offset; nothing to clear.
  }
}
