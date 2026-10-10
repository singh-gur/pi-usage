/**
 * Anthropic (Claude Pro/Max subscription) quota adapter.
 *
 * GET https://api.anthropic.com/api/oauth/usage with the Pi-resolved OAuth
 * bearer token and `anthropic-beta: oauth-2025-04-20`. This is the same
 * undocumented endpoint Claude Code's own `/usage` command reads: rate-limit
 * windows as consumed percentages with reset times, plus extra-usage spend
 * when the account has it enabled.
 *
 * Response handling prefers the newer `limits[]` array (per-model scoped
 * weekly limits with display names) and falls back to the legacy flat keys
 * (`five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`) when
 * `limits[]` is absent or yields nothing, so the same window is never shown
 * twice. Standard API keys are rejected before any request: subscription
 * OAuth only. API spend outside the subscription (Admin API cost reports
 * require an Admin key Pi does not resolve) is out of scope.
 */
import type { GetJson } from "../http.ts";
import {
  UsageError,
  finiteNumber,
  parseResetTime,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaFetchAuth,
  type QuotaWindow,
} from "../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Consumed percentage; only the documented 0–100 range is usable. */
function parseConsumed(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

function utilizationWindow(raw: unknown, label: string): QuotaWindow | "malformed" | undefined {
  const window = record(raw);
  if (!window) return undefined;
  // Present-but-unusable measurement is malformed, never zero.
  if (window.utilization === undefined && window.resets_at === undefined) return undefined;
  const consumed = window.utilization === undefined ? undefined : parseConsumed(window.utilization);
  if (window.utilization !== undefined && consumed === undefined) return "malformed";
  const result: QuotaWindow = { label };
  if (consumed !== undefined) result.usedPercent = consumed;
  const resetsAt = parseResetTime(window.resets_at);
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  return result.usedPercent !== undefined || result.resetsAt !== undefined ? result : "malformed";
}

function limitWindow(entry: unknown): QuotaWindow | "malformed" | "skip" {
  const limit = record(entry);
  if (!limit) return "skip";
  const kind = typeof limit.kind === "string" ? limit.kind : undefined;
  if (kind === undefined) return "skip";
  if (kind !== "session" && kind !== "weekly_all" && kind !== "weekly_scoped") return "skip";
  // Present-but-unusable measurement is malformed, never zero.
  if (limit.percent === undefined && limit.resets_at === undefined) return "skip";
  const consumed = limit.percent === undefined ? undefined : parseConsumed(limit.percent);
  if (limit.percent !== undefined && consumed === undefined) return "malformed";
  let label: string;
  if (kind === "session") label = "5-hour";
  else if (kind === "weekly_all") label = "7-day";
  else {
    const name = record(record(limit.scope)?.model)?.display_name;
    label = typeof name === "string" && name.length > 0 ? `7-day (${name})` : "7-day (scoped)";
  }
  const result: QuotaWindow = { label };
  if (consumed !== undefined) result.usedPercent = consumed;
  const resetsAt = parseResetTime(limit.resets_at);
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  return result.usedPercent !== undefined || result.resetsAt !== undefined ? result : "malformed";
}

/** Extra-usage spend window; absent unless the account has spend enabled with usable data. */
function spendWindow(root: Record<string, unknown>): QuotaWindow | undefined {
  const spend = record(root.spend);
  if (!spend || spend.enabled !== true) return undefined;
  const window: QuotaWindow = { label: "extra usage spend" };
  const used = record(spend.used);
  const amount = used !== undefined ? finiteNumber(used.amount_minor) : undefined;
  const exponent = used !== undefined ? finiteNumber(used.exponent ?? 2) : undefined;
  const currency = used !== undefined && typeof used.currency === "string" && used.currency.length > 0
    ? used.currency
    : "USD";
  if (
    amount !== undefined && Number.isSafeInteger(amount) && amount >= 0
    && exponent !== undefined && Number.isInteger(exponent) && exponent >= 0 && exponent <= 9
  ) {
    window.used = { value: amount / 10 ** exponent, unit: currency };
  }
  const percent = parseConsumed(spend.percent);
  if (percent !== undefined) window.usedPercent = percent;
  return window.used !== undefined || window.usedPercent !== undefined ? window : undefined;
}

/** Pure interpretation of an Anthropic OAuth usage response. */
export function interpretAnthropic(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by Anthropic");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  const root = record(data);
  if (!root) {
    throw new UsageError("unsupported", "No usable quota windows in Anthropic response");
  }
  const windows: QuotaWindow[] = [];
  let malformed = 0;
  const push = (parsed: QuotaWindow | "malformed" | "skip" | undefined) => {
    if (parsed === undefined || parsed === "skip") return;
    if (parsed === "malformed") malformed++;
    else windows.push(parsed);
  };

  const limits = root.limits;
  let fromLimits = false;
  if (Array.isArray(limits) && limits.length > 0) {
    for (const entry of limits) push(limitWindow(entry));
    fromLimits = windows.length > 0 || malformed > 0;
  }
  if (!fromLimits) {
    // Legacy flat keys; only when limits[] carried nothing usable.
    malformed = 0;
    push(utilizationWindow(root.five_hour, "5-hour"));
    push(utilizationWindow(root.seven_day, "7-day"));
    push(utilizationWindow(root.seven_day_opus, "7-day (Opus)"));
    push(utilizationWindow(root.seven_day_sonnet, "7-day (Sonnet)"));
  }

  const spend = spendWindow(root);
  if (spend) windows.push(spend);

  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota windows in Anthropic response");
  }
  const result: ProviderUsage = {
    providerId: "anthropic",
    providerName: "Anthropic",
    domainLabel: "Claude subscription allowance",
    capturedAt: now,
    windows,
  };
  if (malformed > 0) {
    result.partialNotice = `${malformed} quota window(s) missing or malformed`;
  }
  return result;
}

export const anthropicAdapter: QuotaAdapter = {
  id: "anthropic",
  name: "Anthropic",
  officialOrigin: "https://api.anthropic.com",
  domainLabel: "Claude subscription allowance",
  async fetchQuota(auth: QuotaFetchAuth, getJson: GetJson): Promise<ProviderUsage> {
    if (!auth.oauth) {
      // Subscription OAuth only; standard API keys (and Admin keys, which Pi
      // does not resolve) are never substituted for quota access.
      throw new UsageError("auth", "Anthropic quota requires subscription OAuth credentials");
    }
    const response = await getJson(USAGE_URL, {
      accept: "application/json",
      authorization: `Bearer ${auth.apiKey}`,
      "anthropic-beta": OAUTH_BETA,
    });
    return interpretAnthropic(response.status, response.data);
  },
};
