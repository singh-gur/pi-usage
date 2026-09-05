/**
 * Pi-only credential resolution for quota adapters.
 *
 * Uses ctx.modelRegistry public APIs exclusively. Never reads credential
 * stores, env files, or browser sessions directly. Validates that the
 * effective provider origin is the official one before credentials may be
 * sent to the fixed official quota endpoints.
 */
import { UsageError } from "./types.ts";

/** Structural slice of Pi's AuthResult (public model registry API). */
export interface PiAuthResult {
  auth: {
    apiKey?: string;
    baseUrl?: string;
  };
  /** Status label; "OAuth" marks OAuth-provenance credentials. */
  source?: string;
}

/** Structural slice of Pi's composed Provider. */
export interface PiProviderInfo {
  baseUrl?: string;
}

/**
 * Structural slice of Pi's ModelRegistry used by this package. Tests mock
 * this; the extension binds the real ctx.modelRegistry.
 */
export interface AuthGateway {
  isConfigured(providerId: string): boolean;
  resolveAuth(providerId: string): Promise<PiAuthResult | undefined>;
  providerInfo(providerId: string): PiProviderInfo | undefined;
}

export interface ResolvedQuotaAuth {
  apiKey: string;
  /** True when Pi resolved these credentials from a stored OAuth login. */
  oauth: boolean;
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve credentials for a provider and confirm the effective endpoint
 * origin matches `officialOrigin`. Rejects custom provider proxies before
 * any credential leaves the process.
 */
export async function resolveQuotaAuth(
  gateway: AuthGateway,
  providerId: string,
  officialOrigin: string,
): Promise<ResolvedQuotaAuth | UsageError> {
  if (!gateway.isConfigured(providerId)) {
    return new UsageError("not-configured", "No credentials configured for this provider");
  }
  let resolved: PiAuthResult | undefined;
  try {
    resolved = await gateway.resolveAuth(providerId);
  } catch {
    return new UsageError("auth", "Credential resolution failed");
  }
  if (!resolved) {
    return new UsageError("auth", "No usable credentials resolved for this provider");
  }
  const apiKey = resolved.auth.apiKey;
  if (!apiKey) {
    return new UsageError("auth", "No usable credentials resolved for this provider");
  }
  // Effective routing = auth-level base URL override, else composed provider base URL.
  const effectiveBaseUrl = resolved.auth.baseUrl ?? gateway.providerInfo(providerId)?.baseUrl;
  if (effectiveBaseUrl !== undefined) {
    const origin = originOf(effectiveBaseUrl);
    if (origin !== officialOrigin) {
      return new UsageError(
        "auth",
        "Provider routes through a custom base URL; quota lookup refused",
      );
    }
  }
  return { apiKey, oauth: resolved.source === "OAuth" };
}
