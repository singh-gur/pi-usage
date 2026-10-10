import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOKEN_CATEGORIES = [
  { key: "input", label: "Input", color: "accent" },
  { key: "output", label: "Output", color: "success" },
  { key: "cacheRead", label: "Cache read", color: "warning" },
  { key: "cacheWrite", label: "Cache write", color: "mdLink" },
] as const;

export type TokenTotals = Record<(typeof TOKEN_CATEGORIES)[number]["key"], number>;
export interface SessionProviderUsage {
  /** Undefined for usage Pi records without provider/model attribution. */
  providerId: string | undefined;
  tokens: TokenTotals;
  models: Map<string, TokenTotals>;
  incomplete: boolean;
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function totalTokens(tokens: TokenTotals): number {
  return TOKEN_CATEGORIES.reduce((sum, { key }) => sum + tokens[key], 0);
}

/** Rebuild from the active branch, not mutable counters or model selection. */
export function collectSessionUsage(entries: readonly SessionEntry[]): SessionProviderUsage[] {
  const providers = new Map<string | undefined, SessionProviderUsage>();
  for (const entry of entries) {
    let providerId: string | undefined;
    let model = "Unattributed";
    let usage: Partial<TokenTotals> | undefined;
    if (entry.type === "message" && entry.message.role === "assistant") {
      providerId = entry.message.provider;
      model = entry.message.model;
      usage = entry.message.usage;
    } else if (entry.type === "usage") {
      providerId = entry.provider;
      model = entry.model;
      usage = entry.usage;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage;
    } else continue;
    // Old session records may lack usage entirely; keep that absence visible.
    if (!usage && providerId === undefined) continue;
    let provider = providers.get(providerId);
    if (!provider) {
      provider = { providerId, tokens: emptyTokens(), models: new Map(), incomplete: false };
      providers.set(providerId, provider);
    }
    const tokens = provider.models.get(model) ?? emptyTokens();
    provider.models.set(model, tokens);
    for (const { key } of TOKEN_CATEGORIES) {
      const value = usage?.[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        provider.incomplete = true;
        continue;
      }
      tokens[key] += value;
      provider.tokens[key] += value;
    }
  }
  return [...providers.values()];
}

export function sessionTokenTotals(providers: readonly SessionProviderUsage[]): TokenTotals {
  const totals = emptyTokens();
  for (const provider of providers) {
    for (const { key } of TOKEN_CATEGORIES) totals[key] += provider.tokens[key];
  }
  return totals;
}

/** Largest-remainder allocation keeps a fixed-width bar proportional. Tiny shares may round to zero. */
export function segmentWidths(values: readonly number[], width: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return values.map(() => 0);
  const exact = values.map((value) => value / total * width);
  const widths = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - widths[index]! }))
    .sort((a, b) => b.remainder - a.remainder);
  const remaining = width - widths.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remaining; i++) widths[order[i]!.index]!++;
  return widths;
}
