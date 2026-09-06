/**
 * Normalized quota result contract shared by all provider adapters and the UI.
 * Adapters map provider-specific payloads onto this shape; the UI renders it
 * without provider-specific parsing.
 */

/** A measured quantity with a provider-scoped display unit. */
export interface QuotaValue {
  value: number;
  unit: string;
}

/** One independent quota window or group inside a provider result. */
export interface QuotaWindow {
  /** Provider-specific window/group label, e.g. "rolling", "weekly", "key spending". */
  label: string;
  /** Consumed percentage (0-100) where the provider reports one. */
  usedPercent?: number;
  /** Consumed amount where the provider reports one. */
  used?: QuotaValue;
  /** Limit/cap where the provider reports one. */
  limit?: QuotaValue;
  /** Remaining allowance where known. */
  remaining?: QuotaValue;
  /** Absolute reset time (epoch ms) where known. */
  resetsAt?: number;
  /**
   * Reset cadence label (e.g. "monthly") where the provider reports a cadence
   * instead of a timestamp. Never converted into a countdown.
   */
  resetCadence?: string;
  /** Provider-reported window status, e.g. "ok", "rate-limited". */
  status?: string;
}

/** Explicit, sanitized error categories surfaced to the UI. */
export type ProviderErrorKind =
  | "not-configured" // provider has no credentials configured in Pi
  | "auth" // missing/unauthorized credentials, or unsafe credential routing
  | "subscription" // credentials valid but subscription/entitlement missing
  | "unsupported" // response data we cannot interpret
  | "request" // network failure, bad status, oversized/undecodable body
  | "timeout" // per-provider bound exceeded
  | "canceled"; // result arrived after the invoking context moved on

export interface ProviderError {
  kind: ProviderErrorKind;
  /** Fixed sanitized message; never raw bodies, tokens, or upstream text. */
  message: string;
}

/** Normalized result for one provider refresh. */
export interface ProviderUsage {
  providerId: string;
  providerName: string;
  /** What this quota domain measures, e.g. "Coding plan allowance". */
  domainLabel: string;
  /** Epoch ms when the data was captured. */
  capturedAt: number;
  windows: QuotaWindow[];
  /** Notice shown when some windows were malformed but others survived. */
  partialNotice?: string;
  /** Present when the refresh failed; windows may still hold prior usable data. */
  error?: ProviderError;
}

/** Structural shape of the bounded HTTP function adapters use. */
export type QuotaRequester = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; data: unknown }>;

/** Credentials resolved by the auth layer and handed to an adapter. */
export interface QuotaFetchAuth {
  apiKey: string;
  oauth: boolean;
}

/** A supported provider's quota adapter. Fixed list, no plugin framework. */
export interface QuotaAdapter {
  id: string;
  name: string;
  /** Official origin credentials may be routed to; custom proxies are rejected. */
  officialOrigin: string;
  /**
   * Built-in provider base-URL origin that differs from `officialOrigin`
   * (e.g. xai's model API vs billing proxy). Accepted only when Pi resolved
   * no auth-level override; custom overrides must still match officialOrigin.
   */
  allowedProviderOrigin?: string;
  domainLabel: string;
  fetchQuota(auth: QuotaFetchAuth, getJson: QuotaRequester): Promise<ProviderUsage>;
}

/** Internal error carrying a sanitized category; adapters throw, commands catch. */
export class UsageError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "UsageError";
    this.kind = kind;
  }
}

/** Finite number check shared by all adapters; malformed values never become zero. */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Finite number or a finite numeric string (providers that quote numbers as strings). */
export function finiteNumberOrString(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Parse an epoch-ms reset timestamp from an epoch or ISO string value. */
export function parseResetTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Z.ai returns epoch milliseconds; sub-second epochs are not realistic.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
