/**
 * Grok (xAI subscription) coding-credit billing adapter.
 *
 * Distinct identity-then-billing flow against the official Grok CLI proxy:
 *   1. GET /v1/user                 → validate `userId` before billing.
 *   2. GET /v1/billing?format=credits → modern percent/current-period shape.
 *   3. GET /v1/billing (optional)   → legacy monthly shape; only queried when
 *      the credits response exposes no usable quota or the account is on
 *      unified billing. Its failure never hides a valid credits result.
 *
 * Protocol (verified against xai-org/grok-build `billing.rs` and
 * `auth/manager/enrichment.rs`): headers `Authorization: Bearer`,
 * `X-XAI-Token-Auth: xai-grok-cli`, `x-grok-client-version`,
 * `x-grok-client-mode`, and `x-userid` (billing only). Cent wrappers carry
 * `{val}`; proto3 JSON omits zero-valued scalars, so `{}` means 0 and an
 * absent `creditUsagePercent` in a real credits config means 0% at reset.
 * Non-OAuth (API-key) resolution is rejected: subscription billing requires
 * the Pi OAuth token.
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

const ORIGIN = "https://cli-chat-proxy.grok.com";
const USER_URL = `${ORIGIN}/v1/user`;
const CREDITS_URL = `${ORIGIN}/v1/billing?format=credits`;
const MONTHLY_URL = `${ORIGIN}/v1/billing`;

/** Version header value of the official grok CLI (xai-grok-version 1.0.16). Adapter protocol value, not this package's version. */
const CLIENT_VERSION = "1.0.16";

/** Printable ASCII, non-empty, bounded; a `userId` failing this never reaches a billing request. */
const USER_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const MAX_CENTS = 1_000_000_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestHeaders(token: string, userId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": CLIENT_VERSION,
    "x-grok-client-mode": process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "headless",
  };
  if (userId !== undefined) headers["x-userid"] = userId;
  return headers;
}

function requireSuccess(status: number, endpoint: string): void {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by Grok");
  }
  if (status !== 200) {
    throw new UsageError("request", `Grok ${endpoint} endpoint returned HTTP ${status}`);
  }
}

/** Pure validation of the /v1/user identity payload; invalid identity prevents billing. */
export function interpretUserId(data: unknown): string {
  const userId = record(data)?.userId;
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw new UsageError("unsupported", "Grok identity response did not contain a usable user id");
  }
  return userId;
}

/** `config` object of a billing response; null/absent config means no data (official proto3 nullability), a non-object config is unsupported. */
function billingConfig(data: unknown): Record<string, unknown> | undefined {
  const root = record(data);
  if (!root || root.config === undefined || root.config === null) return undefined;
  const config = record(root.config);
  if (!config) {
    throw new UsageError("unsupported", "Grok billing response had an unusable config object");
  }
  return config;
}

function boundedCents(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_CENTS
    ? raw
    : undefined;
}

/** Cent wrapper `{val}` or bare number. `{}` (val omitted) is proto3 zero, not malformed. */
function parseCents(value: unknown): number | undefined {
  if (typeof value === "number") return boundedCents(value);
  const wrapper = record(value);
  if (!wrapper) return undefined;
  if (wrapper.val === undefined) return 0;
  return boundedCents(wrapper.val);
}

/** Reported percentages are only valid in the documented 0–100 range; anything else stays unknown. */
function parsePercent(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

function periodType(config: Record<string, unknown>): string {
  const type = record(config.currentPeriod)?.type;
  return typeof type === "string" ? type.toUpperCase() : "";
}

function periodLabel(config: Record<string, unknown>): string {
  const type = periodType(config);
  if (type.includes("WEEK")) return "current period (weekly)";
  if (type.includes("MONTH")) return "current period (monthly)";
  return "current period";
}

/**
 * Primary window from the credits response: reported percent preferred,
 * validated legacy cent pair as fallback, proto3 zero-omission as last
 * resort (only when a real credits config proves the newer shape and no
 * usage field is present at all — absent, not malformed).
 */
function creditsWindow(config: Record<string, unknown> | undefined): QuotaWindow | undefined {
  if (!config) return undefined;
  const window: QuotaWindow = { label: periodLabel(config) };
  const percent = parsePercent(config.creditUsagePercent);
  const usedCents = parseCents(config.used);
  const limitCents = parseCents(config.monthlyLimit);
  if (percent !== undefined) {
    window.usedPercent = percent;
  } else if (usedCents !== undefined && limitCents !== undefined && limitCents > 0) {
    window.usedPercent = Math.min(100, (usedCents / limitCents) * 100);
    window.used = { value: usedCents / 100, unit: "USD" };
    window.limit = { value: limitCents / 100, unit: "USD" };
    window.remaining = { value: Math.max(0, (limitCents - usedCents) / 100), unit: "USD" };
  } else if (
    config.creditUsagePercent === undefined &&
    config.used === undefined &&
    config.monthlyLimit === undefined &&
    record(config.currentPeriod) !== undefined
  ) {
    // proto3 JSON omits zero-valued scalars: a credits config with a current
    // period and no usage fields at all is 0% used (e.g. just after reset).
    window.usedPercent = 0;
  } else {
    return undefined;
  }
  const resetsAt = parseResetTime(record(config.currentPeriod)?.end) ?? parseResetTime(config.billingPeriodEnd);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

/** Legacy monthly window from `used`/`monthlyLimit` cents; undefined when either is absent or malformed. */
function monthlyWindow(config: Record<string, unknown> | undefined): QuotaWindow | undefined {
  if (!config) return undefined;
  const usedCents = parseCents(config.used);
  const limitCents = parseCents(config.monthlyLimit);
  if (usedCents === undefined || limitCents === undefined || limitCents <= 0) return undefined;
  const window: QuotaWindow = {
    label: "monthly",
    usedPercent: Math.min(100, (usedCents / limitCents) * 100),
    used: { value: usedCents / 100, unit: "USD" },
    limit: { value: limitCents / 100, unit: "USD" },
    remaining: { value: Math.max(0, (limitCents - usedCents) / 100), unit: "USD" },
  };
  // A weekly-typed current period does not describe the monthly window.
  const periodEnd = periodType(config).includes("WEEK") ? undefined : parseResetTime(record(config.currentPeriod)?.end);
  const resetsAt = parseResetTime(config.billingPeriodEnd) ?? periodEnd;
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

export const grokAdapter: QuotaAdapter = {
  id: "xai",
  name: "Grok",
  officialOrigin: ORIGIN,
  // Pi's built-in xai provider base URL is the model API origin (api.x.ai),
  // not the billing proxy. Credentials are only ever sent to officialOrigin;
  // this just proves Pi's built-in definition was not replaced by a proxy.
  allowedProviderOrigin: "https://api.x.ai",
  domainLabel: "Grok coding credits",
  async fetchQuota(auth: QuotaFetchAuth, getJson: GetJson): Promise<ProviderUsage> {
    if (!auth.oauth) {
      // Pi's xai provider also accepts plain API keys; subscription billing
      // does not. API credentials never reach these endpoints.
      throw new UsageError("auth", "Grok quota requires subscription OAuth credentials");
    }

    const identity = await getJson(USER_URL, requestHeaders(auth.apiKey));
    requireSuccess(identity.status, "identity");
    const userId = interpretUserId(identity.data);

    const credits = await getJson(CREDITS_URL, requestHeaders(auth.apiKey, userId));
    requireSuccess(credits.status, "billing");
    const creditsConfig = billingConfig(credits.data);
    const primary = creditsWindow(creditsConfig);

    const windows: QuotaWindow[] = primary ? [primary] : [];
    // Unified-billing accounts expose their shared pool only on the legacy
    // monthly shape; accounts without a usable credits window need it too.
    const unified = creditsConfig?.isUnifiedBillingUser === true;
    let partialNotice: string | undefined;
    if (!primary || unified) {
      try {
        const monthly = await getJson(MONTHLY_URL, requestHeaders(auth.apiKey, userId));
        requireSuccess(monthly.status, "monthly billing");
        const window = monthlyWindow(billingConfig(monthly.data));
        if (window) windows.push(window);
      } catch (error) {
        if (!primary) throw error; // monthly was the only chance at quota
        partialNotice = "Monthly billing data was unavailable";
      }
    }

    if (windows.length === 0) {
      throw new UsageError("unsupported", "No usable quota window in Grok billing response");
    }
    return {
      providerId: "xai",
      providerName: "Grok",
      domainLabel: "Grok coding credits",
      capturedAt: Date.now(),
      windows,
      ...(partialNotice !== undefined ? { partialNotice } : {}),
    };
  },
};
