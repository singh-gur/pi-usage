/**
 * GitHub Copilot quota adapter.
 *
 * GET https://api.github.com/copilot_internal/user with the Pi-resolved
 * OAuth session token. Pi's Copilot OAuth exposes the short-lived session
 * token (not the underlying GitHub OAuth token) plus an account-specific
 * routing base URL; acceptance at this undocumented endpoint is an explicit
 * live compatibility gate, not a claim supported by synthetic tests.
 *
 * Response handling follows the inspected VS Code / Copilot client contract:
 * `quota_snapshots.chat` for an explicitly reported Free plan, otherwise
 * `quota_snapshots.premium_interactions`; reset dates are top-level fields
 * (`quota_reset_date_utc` timestamped, `quota_reset_date` /
 * `limited_user_reset_date` date-only). Only percentage-based remaining
 * allowance is reported; no request counts, currency totals, or inferred
 * budgets are ever derived. Unlimited and organization-pooled snapshots map
 * to nonnumeric window states that claim no balance.
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

const USAGE_URL = "https://api.github.com/copilot_internal/user";

/**
 * Client header convention copied from the inspected Copilot clients (the
 * same values Pi's own Copilot model registry data sends). Source-derived
 * constants, not a verified endpoint requirement.
 */
const CLIENT_HEADERS: Record<string, string> = {
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
};

/**
 * Plans whose unlimited snapshots mean unrestricted personal use. Every
 * other classification (organization pools included, and unknown values)
 * is reported as organization-managed so an unclassified snapshot never
 * becomes a claim of unrestricted personal spending.
 */
const PERSONAL_PLANS = new Set(["individual", "pro", "pro-plus"]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validated calendar date (YYYY-MM-DD); timestamps and invalid dates stay undefined. */
function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return undefined;
  // V8 rolls out-of-range days (e.g. 2026-02-31) over to the next month
  // instead of failing; require an exact calendar round-trip.
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(value.slice(0, 4))
    || parsed.getUTCMonth() !== Number(value.slice(5, 7)) - 1
    || parsed.getUTCDate() !== Number(value.slice(8, 10))
    ? undefined
    : value;
}

/** Pure interpretation of a Copilot user/usage response. */
export function interpretGitHubCopilot(
  status: number,
  data: unknown,
  now: number = Date.now(),
): ProviderUsage {
  if (status === 401) {
    throw new UsageError("auth", "Credentials were rejected by GitHub Copilot");
  }
  if (status === 403) {
    // Access denied without guessing why (token expiry vs. subscription).
    throw new UsageError("auth", "Access to GitHub Copilot usage was denied");
  }
  if (status !== 200) {
    throw new UsageError("request", `Usage endpoint returned HTTP ${status}`);
  }
  const root = record(data);
  const snapshots = record(root?.quota_snapshots);
  if (!root || !snapshots) {
    throw new UsageError("unsupported", "No usable quota snapshot in GitHub Copilot response");
  }
  const plan = typeof root.copilot_plan === "string" ? root.copilot_plan : undefined;
  // Billing flag absent or invalid: neutral domain label, no assumed unit.
  const billing = root.token_based_billing;
  const domainLabel = billing === true
    ? "AI-credit allowance"
    : billing === false
      ? "Legacy premium-request allowance"
      : "Copilot allowance";
  // Free plans meter chat; every other plan meters premium interactions.
  // Completion quota is never substituted.
  const snapshot = record(plan === "free" ? snapshots.chat : snapshots.premium_interactions);
  if (!snapshot) {
    throw new UsageError("unsupported", "No usable quota snapshot in GitHub Copilot response");
  }

  const window: QuotaWindow = { label: "main allowance" };
  // Reset precedence: timestamped reset (countdown-capable) over date-only
  // fields (calendar display only); missing/invalid dates stay absent. A
  // date-only value in the utc field must not become a midnight countdown.
  const utcDateOnly = dateOnly(root.quota_reset_date_utc);
  const resetsAt = utcDateOnly === undefined ? parseResetTime(root.quota_reset_date_utc) : undefined;
  if (resetsAt !== undefined) {
    window.resetsAt = resetsAt;
  } else {
    const date = utcDateOnly ?? dateOnly(root.quota_reset_date) ?? dateOnly(root.limited_user_reset_date);
    if (date !== undefined) window.resetDate = date;
  }

  if (snapshot.unlimited === true) {
    // Placeholder percentages on unlimited snapshots carry no balance
    // information and are ignored. has_quota=false alone never implies
    // exhaustion or access guarantees.
    window.status = plan !== undefined && PERSONAL_PLANS.has(plan) ? "unlimited" : "organization-managed";
  } else {
    const remaining = finiteNumber(snapshot.percent_remaining);
    if (remaining === undefined || remaining < 0 || remaining > 100) {
      // Missing or malformed measurement is unsupported, never zero.
      throw new UsageError("unsupported", "No usable quota snapshot in GitHub Copilot response");
    }
    window.usedPercent = 100 - remaining;
  }
  return {
    providerId: "github-copilot",
    providerName: "GitHub Copilot",
    domainLabel,
    capturedAt: now,
    windows: [window],
  };
}

export const githubCopilotAdapter: QuotaAdapter = {
  id: "github-copilot",
  name: "GitHub Copilot",
  officialOrigin: "https://api.github.com",
  // Pi's Copilot OAuth routes model traffic through account-specific official
  // origins; these exact origins are the only alternates credentials may
  // resolve through (OAuth provenance enforced in resolveQuotaAuth).
  allowedOAuthOrigins: [
    "https://api.individual.githubcopilot.com",
    "https://api.business.githubcopilot.com",
    "https://api.enterprise.githubcopilot.com",
  ],
  domainLabel: "Copilot allowance",
  async fetchQuota(auth: QuotaFetchAuth, getJson: GetJson): Promise<ProviderUsage> {
    if (!auth.oauth) {
      // Subscription OAuth only; other credentials are never substituted
      // for quota access, and no token exchange is attempted.
      throw new UsageError("auth", "Copilot quota requires subscription OAuth credentials");
    }
    const response = await getJson(USAGE_URL, {
      accept: "application/json",
      authorization: `Bearer ${auth.apiKey}`,
      ...CLIENT_HEADERS,
    });
    return interpretGitHubCopilot(response.status, response.data);
  },
};
