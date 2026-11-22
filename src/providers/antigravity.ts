/**
 * Antigravity (Google subscription via pi-antigravity) quota adapter.
 *
 * POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 * (with fallback to https://cloudcode-pa.googleapis.com on retryable failures)
 * using the Pi-resolved OAuth credential JSON (`{"token","projectId"}`)
 * exposed by `pi-antigravity`.
 *
 * Source-derived from `pi-antigravity` (`src/usage/usage.ts`,
 * `src/client/client.ts`, `src/auth/oauth.ts`); not live-verified here.
 * Aggregate quota summary is gated behind a paid subscription (free-tier
 * accounts return HTTP 403 `SUBSCRIPTION_REQUIRED`).
 */
import {
  UsageError,
  finiteNumber,
  parseResetTime,
  type ProviderUsage,
  type QuotaAdapter,
  type QuotaFetchAuth,
  type QuotaPostRequester,
  type QuotaRequester,
  type QuotaWindow,
} from "../types.ts";

const PRIMARY_ORIGIN = "https://daily-cloudcode-pa.googleapis.com";
const FALLBACK_ORIGIN = "https://cloudcode-pa.googleapis.com";
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
const ENDPOINTS = [PRIMARY_ORIGIN, FALLBACK_ORIGIN] as const;

/** CLI wire fingerprint mirrored from pi-antigravity; source-derived, not a public contract. */
const USER_AGENT =
  "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

const FALLBACK_STATUSES = new Set([403, 404, 429, 500, 502, 503, 504]);
const SUBSCRIPTION_ERROR = /SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function isSubscriptionError(status: number, data: unknown): boolean {
  if (status !== 403) return false;
  const message = record(record(data)?.error)?.message;
  return typeof message === "string" && SUBSCRIPTION_ERROR.test(message);
}

/**
 * Extract the OAuth access token from `pi-antigravity`'s serialized apiKey
 * (`{"token":"...","projectId":"..."}`). Never retains parser errors that
 * could quote raw credential input.
 */
export function extractAntigravityToken(apiKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    throw new UsageError("auth", "Antigravity credentials are missing a usable OAuth token");
  }
  const token = record(parsed)?.token;
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new UsageError("auth", "Antigravity credentials are missing a usable OAuth token");
  }
  return token;
}

/** Remaining fraction in [0, 1] -> consumed percent (0–100, 1 decimal). */
function parseUsedPercent(remainingFraction: unknown): number | undefined {
  const n = finiteNumber(remainingFraction);
  if (n === undefined || n < 0 || n > 1) return undefined;
  return Math.round((1 - n) * 1000) / 10;
}

function bucketWindow(raw: unknown, groupName: string | undefined): QuotaWindow | "malformed" {
  const bucket = record(raw);
  if (!bucket) return "malformed";
  if (bucket.remainingFraction === undefined && bucket.resetTime === undefined) return "malformed";
  const usedPercent = bucket.remainingFraction === undefined
    ? undefined
    : parseUsedPercent(bucket.remainingFraction);
  if (bucket.remainingFraction !== undefined && usedPercent === undefined) return "malformed";
  const resetsAt = parseResetTime(bucket.resetTime);
  if (usedPercent === undefined && resetsAt === undefined) return "malformed";

  const bucketName = cleanLabel(bucket.displayName)
    ?? cleanLabel(bucket.window)
    ?? cleanLabel(bucket.bucketId);
  const label = groupName && bucketName && groupName.toLowerCase() !== bucketName.toLowerCase()
    ? `${groupName} · ${bucketName}`
    : (bucketName ?? groupName ?? "quota");

  const result: QuotaWindow = { label };
  if (usedPercent !== undefined) result.usedPercent = usedPercent;
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  return result;
}

/** Pure interpretation of an Antigravity retrieveUserQuotaSummary response. */
export function interpretAntigravity(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401) {
    throw new UsageError("auth", "Credentials were rejected by Antigravity");
  }
  if (status === 403) {
    if (isSubscriptionError(status, data)) {
      throw new UsageError("subscription", "Antigravity quota summary requires a paid subscription");
    }
    throw new UsageError("auth", "Access to Antigravity usage was denied");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  const root = record(data);
  if (!root || !Array.isArray(root.groups)) {
    throw new UsageError("unsupported", "No usable quota groups in Antigravity response");
  }

  const windows: QuotaWindow[] = [];
  let malformed = 0;
  for (const rawGroup of root.groups) {
    const group = record(rawGroup);
    if (!group || !Array.isArray(group.buckets)) {
      malformed++;
      continue;
    }
    const groupName = cleanLabel(group.displayName);
    for (const rawBucket of group.buckets) {
      const parsed = bucketWindow(rawBucket, groupName);
      if (parsed === "malformed") malformed++;
      else windows.push(parsed);
    }
  }

  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota windows in Antigravity response");
  }
  const result: ProviderUsage = {
    providerId: "antigravity",
    providerName: "Antigravity",
    domainLabel: "Antigravity subscription allowance",
    capturedAt: now,
    windows,
  };
  if (malformed > 0) {
    result.partialNotice = `${malformed} quota window(s) missing or malformed`;
  }
  return result;
}

export const antigravityAdapter: QuotaAdapter = {
  id: "antigravity",
  name: "Antigravity",
  officialOrigin: PRIMARY_ORIGIN,
  allowedOAuthOrigins: [FALLBACK_ORIGIN],
  domainLabel: "Antigravity subscription allowance",
  async fetchQuota(
    auth: QuotaFetchAuth,
    _getJson: QuotaRequester,
    postJson?: QuotaPostRequester,
  ): Promise<ProviderUsage> {
    if (!auth.oauth) {
      throw new UsageError("auth", "Antigravity quota requires subscription OAuth credentials");
    }
    const token = extractAntigravityToken(auth.apiKey);
    if (!postJson) {
      throw new UsageError("request", "Quota POST transport unavailable");
    }
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
    };

    let lastResponse: { status: number; data: unknown } | undefined;
    let lastError: unknown;
    for (let i = 0; i < ENDPOINTS.length; i++) {
      const isLast = i === ENDPOINTS.length - 1;
      let response: { status: number; data: unknown };
      try {
        response = await postJson(`${ENDPOINTS[i]!}${QUOTA_PATH}`, headers, {});
      } catch (error) {
        if (error instanceof UsageError && error.kind === "canceled") throw error;
        lastError = error;
        if (isLast && lastResponse === undefined) throw error;
        continue;
      }
      lastResponse = response;
      if (response.status === 200 || isLast || isSubscriptionError(response.status, response.data)
        || !FALLBACK_STATUSES.has(response.status)) {
        return interpretAntigravity(response.status, response.data);
      }
    }
    if (lastResponse !== undefined) return interpretAntigravity(lastResponse.status, lastResponse.data);
    throw lastError instanceof UsageError ? lastError : new UsageError("request", "Antigravity quota request failed");
  },
};
