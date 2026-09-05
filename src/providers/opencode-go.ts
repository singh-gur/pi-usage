/**
 * OpenCode Go subscription quota adapter.
 *
 * GET https://opencode.ai/zen/go/v1/usage with Bearer auth. Response:
 * { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 * percent is consumed usage; resetsAt is a returned ISO timestamp.
 */
import type { GetJson } from "../http.ts";
import {
  UsageError,
  finiteNumber,
  parseResetTime,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaWindow,
} from "../types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
const KNOWN_STATUSES = new Set(["ok", "rate-limited"]);

interface WindowEntry {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
}

function errorEnvelopeKind(data: unknown): string | undefined {
  const type = (data as { error?: { type?: unknown } } | null)?.error?.type;
  return typeof type === "string" ? type : undefined;
}

function windowFrom(entry: unknown, label: string): QuotaWindow | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const raw = entry as WindowEntry;
  const window: QuotaWindow = { label };
  const percent = finiteNumber(raw.percent);
  if (percent !== undefined) window.usedPercent = percent;
  const resetsAt = parseResetTime(raw.resetsAt);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  const status =
    typeof raw.status === "string" && KNOWN_STATUSES.has(raw.status) ? raw.status : "unknown";
  window.status = status;
  // A window is usable when it carries at least one quota fact.
  return window.usedPercent !== undefined || window.resetsAt !== undefined ? window : undefined;
}

/** Pure interpretation of an OpenCode Go usage response. */
export function interpretOpenCodeGo(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401) {
    throw new UsageError("auth", "Credentials were rejected by OpenCode Go");
  }
  if (status === 403 || errorEnvelopeKind(data) === "EntitlementError") {
    throw new UsageError("subscription", "OpenCode Go subscription required");
  }
  if (errorEnvelopeKind(data) === "AuthError") {
    throw new UsageError("auth", "Credentials were rejected by OpenCode Go");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  const usage = (data as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) {
    throw new UsageError("unsupported", "Unrecognized OpenCode Go usage response");
  }
  const windows: QuotaWindow[] = [];
  let malformed = 0;
  for (const key of WINDOW_KEYS) {
    const window = windowFrom((usage as Record<string, unknown>)[key], key);
    if (window) windows.push(window);
    else malformed++;
  }
  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota windows in OpenCode Go response");
  }
  const result: ProviderUsage = {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    domainLabel: "Coding plan allowance",
    capturedAt: now,
    windows,
  };
  if (malformed > 0) {
    result.partialNotice = `${malformed} usage window(s) missing or malformed`;
  }
  return result;
}

export const opencodeGoAdapter: QuotaAdapter = {
  id: "opencode-go",
  name: "OpenCode Go",
  officialOrigin: "https://opencode.ai",
  domainLabel: "Coding plan allowance",
  async fetchQuota(auth, getJson: GetJson): Promise<ProviderUsage> {
    const response = await getJson(USAGE_URL, { authorization: `Bearer ${auth.apiKey}` });
    return interpretOpenCodeGo(response.status, response.data);
  },
};
