import { UsageError, type ProviderUsage, type QuotaAdapter, type QuotaFetchAuth, type QuotaRequester, type ResetOffer } from "./types.ts";

export function resetResponse(status: number, data: unknown): Record<string, unknown> {
  if (status === 401 || status === 403) throw new UsageError("auth", "Reset credentials were rejected");
  if (status !== 200) throw new UsageError("request", `Reset endpoint returned HTTP ${status}`);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new UsageError("unsupported", "Unrecognized reset response");
  }
  return data as Record<string, unknown>;
}

export function availableResetOffers(offers: ResetOffer[], now = Date.now()): ResetOffer[] {
  return offers.filter((offer) => offer.expiresAt === undefined || offer.expiresAt > now);
}

/** Optional inventory failure never hides successful quota measurements. */
export async function attachResets(adapter: QuotaAdapter, auth: QuotaFetchAuth,
  getJson: QuotaRequester, usage: ProviderUsage): Promise<ProviderUsage> {
  if (!adapter.fetchResets) return usage;
  try {
    usage.resets = await adapter.fetchResets(auth, getJson);
  } catch {
    usage.resets = { offers: [], notice: "Reset availability could not be checked" };
  }
  return usage;
}

/** Only an explicitly identified 5-hour window can trigger a notice. */
export function lowQuotaResetAvailable(usage: ProviderUsage, threshold: number, now = Date.now()): boolean {
  if (usage.error || threshold <= 0 || !usage.resets) return false;
  const available = availableResetOffers(usage.resets.offers, now).length > 0
    || (usage.providerId === "zai" && (usage.resets.availableCount ?? 0) > 0);
  return available && usage.windows.some((window) => window.durationSeconds === 18_000
    && window.usedPercent !== undefined && window.usedPercent >= 0 && window.usedPercent <= 100
    && 100 - window.usedPercent < threshold
    && (window.resetsAt === undefined || window.resetsAt > now));
}
