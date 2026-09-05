/**
 * OpenRouter key allowance adapter.
 *
 * GET https://openrouter.ai/api/v1/key with Bearer auth. Reports the current
 * key's spending cap, remaining allowance, and usage. A null limit means no
 * key spending cap is set — not unlimited account credit. limit_reset is a
 * cadence label ("monthly"), never a reset timestamp.
 */
import type { GetJson } from "../http.ts";
import {
  UsageError,
  finiteNumber,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaWindow,
} from "../types.ts";

const KEY_URL = "https://openrouter.ai/api/v1/key";

interface KeyData {
  limit?: unknown;
  limit_remaining?: unknown;
  limit_reset?: unknown;
  usage?: unknown;
}

/** Pure interpretation of an OpenRouter current-key response. */
export function interpretOpenRouter(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by OpenRouter");
  }
  if (status !== 200) {
    throw new UsageError("request", `Key endpoint returned HTTP ${status}`);
  }
  const key = (data as { data?: unknown } | null)?.data;
  if (typeof key !== "object" || key === null) {
    throw new UsageError("unsupported", "Unrecognized OpenRouter key response");
  }
  const raw = key as KeyData;
  const window: QuotaWindow = { label: "Key spending" };
  const used = finiteNumber(raw.usage);
  if (used !== undefined) window.used = { value: used, unit: "USD" };
  const limit = finiteNumber(raw.limit);
  if (limit !== undefined) window.limit = { value: limit, unit: "USD" };
  const remaining = finiteNumber(raw.limit_remaining);
  if (remaining !== undefined) window.remaining = { value: remaining, unit: "USD" };
  if (typeof raw.limit_reset === "string" && raw.limit_reset.length <= 20) {
    window.resetCadence = raw.limit_reset;
  }
  if (
    window.used === undefined &&
    window.limit === undefined &&
    window.remaining === undefined
  ) {
    throw new UsageError("unsupported", "No usable allowance fields in OpenRouter response");
  }
  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    domainLabel: "Key spending allowance",
    capturedAt: now,
    windows: [window],
  };
}

export const openrouterAdapter: QuotaAdapter = {
  id: "openrouter",
  name: "OpenRouter",
  officialOrigin: "https://openrouter.ai",
  domainLabel: "Key spending allowance",
  async fetchQuota(auth, getJson: GetJson): Promise<ProviderUsage> {
    const response = await getJson(KEY_URL, { authorization: `Bearer ${auth.apiKey}` });
    return interpretOpenRouter(response.status, response.data);
  },
};
