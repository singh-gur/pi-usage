/**
 * Z.ai Coding Plan quota adapter.
 *
 * GET https://api.z.ai/api/monitor/usage/quota/limit with the raw API key in
 * `Authorization` (no Bearer prefix), following Z.ai's official plugin.
 *
 * Parses `data.limits` with the API's inverted naming: `usage` carries the
 * limit, `currentValue` carries consumed units, `percentage` is consumed
 * percent. Windows are identified by (unit, number) pairs — never by array
 * order: (3, 5) is the 5-hour session window, (6, 1) is weekly. The monthly
 * TIME_LIMIT MCP/tool allowance stays a separate window.
 */
import type { GetJson } from "../http.ts";
import { resetResponse } from "../resets.ts";
import {
  UsageError,
  finiteNumber,
  parseResetTime,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaWindow,
} from "../types.ts";

const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

interface LimitEntry {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  usage?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  nextResetTime?: unknown;
}

/** Window identity from the (unit, number) pair; unknown pairs stay unknown. */
export function zaiWindowId(unit: unknown, number: unknown): string {
  const u = finiteNumber(unit);
  const n = finiteNumber(number);
  if (u === 3 && n === 5) return "5-hour";
  if (u === 6 && n === 1) return "weekly";
  if (u !== undefined && n !== undefined) return `unknown (${u}/${n})`;
  return "unknown";
}

function limitWindow(entry: LimitEntry, label: string, unit: string): QuotaWindow | undefined {
  const window: QuotaWindow = { label, ...(label === "5-hour" ? { durationSeconds: 18_000 } : {}) };
  const usedPercent = finiteNumber(entry.percentage);
  if (usedPercent !== undefined) window.usedPercent = usedPercent;
  const limit = finiteNumber(entry.usage);
  if (limit !== undefined && limit > 0) window.limit = { value: limit, unit };
  const used = finiteNumber(entry.currentValue);
  if (used !== undefined) window.used = { value: used, unit };
  const remaining = finiteNumber(entry.remaining);
  if (remaining !== undefined) window.remaining = { value: remaining, unit };
  const resetsAt = parseResetTime(entry.nextResetTime);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return usedPercent !== undefined || window.limit || window.used || window.remaining || resetsAt !== undefined
    ? window : undefined;
}

/** Pure interpretation of a Z.ai quota-limit response. */
export function interpretZai(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by Z.ai");
  }
  if (status !== 200) {
    throw new UsageError("request", `Quota endpoint returned HTTP ${status}`);
  }
  const envelope = data as { code?: unknown; success?: unknown; data?: unknown } | null;
  if (typeof envelope !== "object" || envelope === null) {
    throw new UsageError("unsupported", "Unrecognized Z.ai quota response");
  }
  // The API reports failures in its envelope even with HTTP 200.
  const code = finiteNumber(envelope.code);
  if (envelope.success === false || (code !== undefined && code !== 200)) {
    throw new UsageError("request", "Z.ai quota API reported an error");
  }
  const limits = (envelope.data as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) {
    throw new UsageError("unsupported", "No usable limits in Z.ai response");
  }
  const windows: QuotaWindow[] = [];
  let malformed = 0;
  for (const item of limits) {
    if (typeof item !== "object" || item === null) {
      malformed++;
      continue;
    }
    const entry = item as LimitEntry;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      const unit = type === "CREDIT_LIMIT" ? "credits" : "units";
      const window = limitWindow(entry, zaiWindowId(entry.unit, entry.number), unit);
      if (window) windows.push(window);
      else malformed++;
    } else if (type === "TIME_LIMIT") {
      // Monthly MCP/tool allowance; separate domain from coding quota.
      const window = limitWindow(entry, "MCP tools (monthly)", "units");
      if (window) windows.push(window);
      else malformed++;
    } else {
      malformed++;
    }
  }
  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota limits in Z.ai response");
  }
  const result: ProviderUsage = {
    providerId: "zai",
    providerName: "Z.AI",
    domainLabel: "Coding plan allowance",
    capturedAt: now,
    windows,
  };
  if (malformed > 0) {
    result.partialNotice = `${malformed} limit entry/entries missing, malformed, or unknown`;
  }
  return result;
}

export const zaiAdapter: QuotaAdapter = {
  id: "zai",
  name: "Z.AI",
  officialOrigin: "https://api.z.ai",
  domainLabel: "Coding plan allowance",
  async fetchQuota(auth, getJson: GetJson): Promise<ProviderUsage> {
    // Official plugin convention: raw key, no Bearer prefix.
    const response = await getJson(USAGE_URL, { authorization: auth.apiKey });
    return interpretZai(response.status, response.data);
  },
  async fetchResets(auth, getJson) {
    // Inventory only: quota-axi/src/providers/zai-coding-plan.ts. No verified redemption contract.
    const response = await getJson("https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL",
      { authorization: `Bearer ${auth.apiKey}` });
    const root = resetResponse(response.status, response.data);
    const data = root.data as { fiveHourResets?: unknown; weekResets?: unknown } | null;
    if (root.code !== 200 || root.success !== true || !Array.isArray(data?.fiveHourResets) || !Array.isArray(data?.weekResets)) {
      throw new UsageError("unsupported", "Unrecognized Z.ai reset inventory");
    }
    const count = (cards: unknown[]) => cards.filter((card) =>
      typeof card === "object" && card !== null && (card as { available?: unknown }).available === true).length;
    const fiveHour = count(data.fiveHourResets);
    const weekly = count(data.weekResets);
    return { offers: [], availableCount: fiveHour + weekly,
      notice: `${fiveHour} 5-hour / ${weekly} weekly cards. Check expiry and redeem in ZCode; in-Pi redemption unavailable` };
  },
};
