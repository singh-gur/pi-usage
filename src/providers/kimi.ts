/**
 * Kimi Coding membership quota adapter.
 *
 * GET https://api.kimi.com/coding/v1/usages with the Pi-resolved Coding API
 * key or OAuth bearer token. Parses the main `usage` quota and the rolling
 * `limits` buckets. Quota fields may arrive as finite numeric strings.
 * Units are provider allowance, never model tokens.
 */
import type { GetJson } from "../http.ts";
import {
  UsageError,
  finiteNumberOrString,
  parseResetTime,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaWindow,
} from "../types.ts";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const UNIT = "uses";

interface QuotaFields {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
}

/**
 * Parse one Kimi quota bucket. A missing used/remaining is derived only from
 * a valid counterpart plus limit; present-but-invalid fields drop the bucket
 * instead of becoming zero. Returns undefined for unusable buckets.
 */
function kimiQuota(record: QuotaFields): QuotaWindow | undefined {
  const limit = finiteNumberOrString(record.limit);
  let used = finiteNumberOrString(record.used);
  let remaining = finiteNumberOrString(record.remaining);
  const presentButInvalid =
    (record.used !== undefined && used === undefined) ||
    (record.remaining !== undefined && remaining === undefined);
  if (presentButInvalid) return undefined;
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = Math.max(0, limit - remaining);
  }
  if (remaining === undefined && used !== undefined && limit !== undefined) {
    remaining = Math.max(0, limit - used);
  }
  if (limit === undefined && used === undefined && remaining === undefined) {
    return undefined;
  }
  const window: QuotaWindow = { label: "" };
  if (limit !== undefined && limit > 0) window.limit = { value: limit, unit: UNIT };
  if (used !== undefined) window.used = { value: used, unit: UNIT };
  if (remaining !== undefined) window.remaining = { value: remaining, unit: UNIT };
  const resetsAt = parseResetTime(record.resetTime);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

/**
 * Rolling-window label from the returned time unit, never from array
 * position or a blanket 5-hour assumption.
 */
function kimiWindowLabel(window: unknown): string {
  const raw = window as { duration?: unknown; timeUnit?: unknown } | null;
  const duration = finiteNumberOrString(raw?.duration);
  const timeUnit = raw?.timeUnit;
  if (duration === undefined || duration <= 0 || typeof timeUnit !== "string") {
    return "rolling";
  }
  switch (timeUnit) {
    case "TIME_UNIT_SECOND":
      return `${duration}s`;
    case "TIME_UNIT_MINUTE":
      return duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
    case "TIME_UNIT_HOUR":
      return `${duration}h`;
    case "TIME_UNIT_DAY":
      return `${duration}d`;
    default:
      return "rolling";
  }
}

/** Pure interpretation of a Kimi usages response. */
export function interpretKimi(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by Kimi");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new UsageError("unsupported", "Unrecognized Kimi usage response");
  }
  const root = data as { usage?: unknown; limits?: unknown };
  const windows: QuotaWindow[] = [];
  let dropped = 0;

  const main = kimiQuota((root.usage as QuotaFields | null) ?? {});
  if (main) {
    main.label = "weekly";
    windows.push(main);
  } else if (root.usage !== undefined) {
    dropped++;
  }

  if (Array.isArray(root.limits)) {
    for (const item of root.limits) {
      if (typeof item !== "object" || item === null) {
        dropped++;
        continue;
      }
      const entry = item as { detail?: unknown; window?: unknown };
      const quota = kimiQuota((entry.detail as QuotaFields | undefined) ?? (item as QuotaFields));
      if (quota) {
        quota.label = `${kimiWindowLabel(entry.window)} window`;
        windows.push(quota);
      } else {
        dropped++;
      }
    }
  }

  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota buckets in Kimi response");
  }
  const result: ProviderUsage = {
    providerId: "kimi-coding",
    providerName: "Kimi For Coding",
    domainLabel: "Coding plan allowance",
    capturedAt: now,
    windows,
  };
  if (dropped > 0) {
    result.partialNotice = `${dropped} quota bucket(s) missing or malformed`;
  }
  return result;
}

export const kimiAdapter: QuotaAdapter = {
  id: "kimi-coding",
  name: "Kimi For Coding",
  officialOrigin: "https://api.kimi.com",
  domainLabel: "Coding plan allowance",
  async fetchQuota(auth, getJson: GetJson): Promise<ProviderUsage> {
    const response = await getJson(USAGE_URL, { authorization: `Bearer ${auth.apiKey}` });
    return interpretKimi(response.status, response.data);
  },
};
