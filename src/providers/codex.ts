/**
 * OpenAI Codex (ChatGPT subscription) quota adapter.
 *
 * GET https://chatgpt.com/backend-api/wham/usage with the Pi-resolved OAuth
 * bearer token and a `chatgpt-account-id` header derived from the same
 * runtime token's `https://api.openai.com/auth.chatgpt_account_id` claim
 * (same convention as Pi's inspected request implementation).
 *
 * Parses `rate_limit.primary_window`/`secondary_window` and keeps
 * `additional_rate_limits` groups separate; shared and model-specific
 * quotas are never merged.
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

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CodexWindowPayload {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

/**
 * Derive the ChatGPT account id from the runtime token. Decoding is not
 * independent identity verification; it only mirrors the header convention
 * of Pi's own Codex requests. Invalid or absent claims are an auth error.
 */
export function codexAccountId(token: string): string | UsageError {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return new UsageError("auth", "Codex credentials did not contain account information");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return new UsageError("auth", "Codex credentials did not contain account information");
  }
  const accountId = (payload as Record<string, Record<string, unknown>> | null)?.[ACCOUNT_CLAIM]
    ?.chatgpt_account_id;
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    return new UsageError("auth", "Codex credentials did not contain account information");
  }
  return accountId;
}

function windowDurationLabel(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800}w`;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function codexWindow(entry: unknown, label: string): QuotaWindow | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const raw = entry as CodexWindowPayload;
  const window: QuotaWindow = { label };
  const usedPercent = finiteNumber(raw.used_percent);
  if (usedPercent !== undefined) window.usedPercent = usedPercent;
  const resetsAt = parseResetTime(raw.reset_at);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  const duration = finiteNumber(raw.limit_window_seconds);
  if (duration !== undefined && duration > 0) {
    window.label = `${label} · ${windowDurationLabel(duration)}`;
  }
  return window.usedPercent !== undefined || window.resetsAt !== undefined ? window : undefined;
}

interface RateLimitPayload {
  primary_window?: unknown;
  secondary_window?: unknown;
}

/** Pure interpretation of a Codex usage response. */
export function interpretCodex(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401 || status === 403) {
    throw new UsageError("auth", "Credentials were rejected by Codex");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  const windows: QuotaWindow[] = [];
  let malformed = 0;

  const rateLimit = (data as { rate_limit?: unknown } | null)?.rate_limit;
  if (typeof rateLimit === "object" && rateLimit !== null) {
    const raw = rateLimit as RateLimitPayload;
    for (const [key, label] of [
      ["primary_window", "primary (shared)"],
      ["secondary_window", "secondary (shared)"],
    ] as const) {
      const window = codexWindow(raw[key], label);
      if (window) windows.push(window);
      else malformed++;
    }
  } else {
    malformed++;
  }

  const additional = (data as { additional_rate_limits?: unknown } | null)?.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const group of additional) {
      if (typeof group !== "object" || group === null) {
        malformed++;
        continue;
      }
      const raw = group as { limit_name?: unknown; rate_limit?: unknown };
      const name = typeof raw.limit_name === "string" && raw.limit_name.length > 0
        ? raw.limit_name
        : "additional";
      const window = codexWindow(
        (raw.rate_limit as RateLimitPayload | null)?.primary_window,
        name,
      );
      if (window) windows.push(window);
      else malformed++;
    }
  }

  if (windows.length === 0) {
    throw new UsageError("unsupported", "No usable quota windows in Codex response");
  }
  const result: ProviderUsage = {
    providerId: "openai-codex",
    providerName: "OpenAI Codex",
    domainLabel: "ChatGPT subscription allowance",
    capturedAt: now,
    windows,
  };
  if (malformed > 0) {
    result.partialNotice = `${malformed} quota group(s) missing or malformed`;
  }
  return result;
}

export const codexAdapter: QuotaAdapter = {
  id: "openai-codex",
  name: "OpenAI Codex",
  officialOrigin: "https://chatgpt.com",
  domainLabel: "ChatGPT subscription allowance",
  async fetchQuota(auth: QuotaFetchAuth, getJson: GetJson): Promise<ProviderUsage> {
    if (!auth.oauth) {
      // The provider supports subscription OAuth only; API credentials are
      // never substituted for quota access.
      throw new UsageError("auth", "Codex quota requires subscription OAuth credentials");
    }
    const accountId = codexAccountId(auth.apiKey);
    if (accountId instanceof UsageError) throw accountId;
    const response = await getJson(USAGE_URL, {
      authorization: `Bearer ${auth.apiKey}`,
      "chatgpt-account-id": accountId,
    });
    return interpretCodex(response.status, response.data);
  },
};
