import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretOpenCodeGo, opencodeGoAdapter } from "../src/providers/opencode-go.ts";
import { interpretOpenRouter, openrouterAdapter } from "../src/providers/openrouter.ts";
import { codexAccountId, interpretCodex, codexAdapter } from "../src/providers/codex.ts";
import { interpretKimi, kimiAdapter } from "../src/providers/kimi.ts";
import { interpretZai, zaiAdapter } from "../src/providers/zai.ts";
import { UsageError } from "../src/types.ts";

const NOW = 1_700_000_000_000;
const ISO = new Date(NOW + 3_600_000).toISOString();

function expectError(kind: string, fn: () => unknown): UsageError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected UsageError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail("expected a throw");
}

// ---------------------------------------------------------------- OpenCode Go

function goPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usage: {
      rolling: { status: "ok", percent: 12.5, resetsAt: ISO },
      weekly: { status: "ok", percent: 3, resetsAt: ISO },
      monthly: { status: "ok", percent: 1, resetsAt: ISO },
      ...overrides,
    },
  };
}

test("opencode-go: valid payload yields all windows with consumed percent", () => {
  const result = interpretOpenCodeGo(200, goPayload(), NOW);
  assert.equal(result.providerId, "opencode-go");
  assert.deepEqual(
    result.windows.map((w) => w.label),
    ["rolling", "weekly", "monthly"],
  );
  assert.equal(result.windows[0]!.usedPercent, 12.5);
  assert.equal(result.windows[0]!.resetsAt, NOW + 3_600_000);
  assert.equal(result.windows[0]!.status, "ok");
  assert.equal(result.partialNotice, undefined);
});

test("opencode-go: zero usage is preserved as a legitimate zero", () => {
  const result = interpretOpenCodeGo(200, goPayload({ rolling: { status: "ok", percent: 0, resetsAt: ISO } }), NOW);
  assert.equal(result.windows[0]!.usedPercent, 0);
});

test("opencode-go: rate-limited status is preserved", () => {
  const result = interpretOpenCodeGo(200, goPayload({ rolling: { status: "rate-limited", percent: 100, resetsAt: ISO } }), NOW);
  assert.equal(result.windows[0]!.status, "rate-limited");
});

test("opencode-go: unknown window status is labeled unknown, data kept", () => {
  const result = interpretOpenCodeGo(200, goPayload({ weekly: { status: "weird", percent: 9, resetsAt: ISO } }), NOW);
  assert.equal(result.windows[1]!.status, "unknown");
  assert.equal(result.windows[1]!.usedPercent, 9);
});

test("opencode-go: malformed window is dropped with a partial notice, others survive", () => {
  const result = interpretOpenCodeGo(
    200,
    goPayload({ monthly: { status: "ok", percent: "not-a-number", resetsAt: null } }),
    NOW,
  );
  assert.equal(result.windows.length, 2);
  assert.equal(result.partialNotice, "1 usage window(s) missing or malformed");
});

test("opencode-go: missing resetsAt keeps the window via percent", () => {
  const result = interpretOpenCodeGo(200, goPayload({ monthly: { status: "ok", percent: 5 } }), NOW);
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[2]!.resetsAt, undefined);
});

test("opencode-go: unusable resetsAt value stays unknown", () => {
  const result = interpretOpenCodeGo(200, goPayload({ monthly: { status: "ok", percent: 5, resetsAt: "not-a-date" } }), NOW);
  assert.equal(result.windows[2]!.resetsAt, undefined);
});

test("opencode-go: no usable windows is unsupported", () => {
  expectError("unsupported", () => interpretOpenCodeGo(200, { usage: {} }, NOW));
});

test("opencode-go: missing usage object is unsupported", () => {
  expectError("unsupported", () => interpretOpenCodeGo(200, { something: "else" }, NOW));
  expectError("unsupported", () => interpretOpenCodeGo(200, null, NOW));
});

test("opencode-go: 401 maps to auth error", () => {
  expectError("auth", () =>
    interpretOpenCodeGo(401, { type: "error", error: { type: "AuthError", message: "Unauthorized" } }, NOW),
  );
});

test("opencode-go: 403 entitlement envelope maps to subscription error", () => {
  const error = expectError("subscription", () =>
    interpretOpenCodeGo(
      403,
      { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } },
      NOW,
    ),
  );
  assert.equal(error.message, "OpenCode Go subscription required");
});

test("opencode-go: 403 without envelope still maps to subscription", () => {
  expectError("subscription", () => interpretOpenCodeGo(403, null, NOW));
});

test("opencode-go: other statuses are sanitized request errors", () => {
  const error = expectError("request", () => interpretOpenCodeGo(503, { oops: "internal detail" }, NOW));
  assert.equal(error.message, "Usage endpoint returned HTTP 503");
});

test("opencode-go: adapter sends bearer auth to the fixed endpoint", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: goPayload() };
  };
  const result = await opencodeGoAdapter.fetchQuota({ apiKey: "secret-key", oauth: false }, getJson);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(calls[0]!.headers.authorization, "Bearer secret-key");
  assert.equal(result.providerId, "opencode-go");
});

// ----------------------------------------------------------------- OpenRouter

const OR_PAYLOAD = {
  data: {
    label: "sk-or-v1-au7...890",
    creator_user_id: "user_2dH",
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: "monthly",
    usage: 25.5,
  },
};

test("openrouter: valid key data maps to a USD spending window", () => {
  const result = interpretOpenRouter(200, OR_PAYLOAD, NOW);
  assert.equal(result.providerId, "openrouter");
  assert.equal(result.domainLabel, "Key spending allowance");
  const window = result.windows[0]!;
  assert.deepEqual(window.used, { value: 25.5, unit: "USD" });
  assert.deepEqual(window.limit, { value: 100, unit: "USD" });
  assert.deepEqual(window.remaining, { value: 74.5, unit: "USD" });
  assert.equal(window.resetCadence, "monthly");
  assert.equal(window.resetsAt, undefined);
});

test("openrouter: result does not surface key labels or user ids", () => {
  const result = interpretOpenRouter(200, OR_PAYLOAD, NOW);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-or"));
  assert.ok(!serialized.includes("user_"));
});

test("openrouter: null limit means no cap, not zero and not unlimited", () => {
  const result = interpretOpenRouter(200, { data: { limit: null, usage: 25.5 } }, NOW);
  const window = result.windows[0]!;
  assert.deepEqual(window.used, { value: 25.5, unit: "USD" });
  assert.equal(window.limit, undefined);
  assert.equal(window.remaining, undefined);
});

test("openrouter: zero spending is preserved", () => {
  const result = interpretOpenRouter(200, { data: { limit: 10, usage: 0, limit_remaining: 10 } }, NOW);
  assert.equal(result.windows[0]!.used!.value, 0);
});

test("openrouter: non-finite fields are excluded, valid ones survive", () => {
  const result = interpretOpenRouter(
    200,
    { data: { limit: 10, usage: "lots", limit_remaining: "NaN", limit_reset: 42 } },
    NOW,
  );
  const window = result.windows[0]!;
  assert.deepEqual(window.limit, { value: 10, unit: "USD" });
  assert.equal(window.used, undefined);
  assert.equal(window.remaining, undefined);
  assert.equal(window.resetCadence, undefined);
});

test("openrouter: no usable fields is unsupported", () => {
  expectError("unsupported", () => interpretOpenRouter(200, { data: { label: "x" } }, NOW));
  expectError("unsupported", () => interpretOpenRouter(200, {}, NOW));
});

test("openrouter: 401 maps to auth error", () => {
  expectError("auth", () => interpretOpenRouter(401, { error: { message: "bad key" } }, NOW));
});

test("openrouter: other statuses are sanitized request errors", () => {
  const error = expectError("request", () => interpretOpenRouter(502, null, NOW));
  assert.equal(error.message, "Key endpoint returned HTTP 502");
});

test("openrouter: adapter sends bearer auth to the fixed endpoint", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: OR_PAYLOAD };
  };
  await openrouterAdapter.fetchQuota({ apiKey: "sk-or-test", oauth: false }, getJson);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0]!.headers.authorization, "Bearer sk-or-test");
});

// ---------------------------------------------------------------------- Codex

function jwtWith(payload: object): string {
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

const CODEX_CLAIM = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } };

const CODEX_PAYLOAD = {
  rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_786_624_439 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: 1_786_624_439 },
  },
  additional_rate_limits: [
    {
      limit_name: "codex_other",
      metered_feature: "codex_other",
      rate_limit: {
        primary_window: { used_percent: 88, limit_window_seconds: 1_800, reset_at: 1_786_624_439 },
      },
    },
  ],
};

test("codex: shared and additional groups parse separately with window durations", () => {
  const result = interpretCodex(200, CODEX_PAYLOAD, NOW);
  assert.equal(result.providerId, "openai-codex");
  assert.deepEqual(
    result.windows.map((w) => w.label),
    ["primary (shared) · 5h", "secondary (shared) · 1w", "codex_other · 30m"],
  );
  assert.equal(result.windows[0]!.usedPercent, 42);
  assert.equal(result.windows[0]!.resetsAt, 1_786_624_439_000);
  assert.equal(result.partialNotice, undefined);
});

test("codex: zero used percent is preserved", () => {
  const payload = { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 3_600 } } };
  const result = interpretCodex(200, payload, NOW);
  assert.equal(result.windows[0]!.usedPercent, 0);
});

test("codex: missing reset_at stays unknown", () => {
  const payload = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3_600 } } };
  const result = interpretCodex(200, payload, NOW);
  assert.equal(result.windows[0]!.resetsAt, undefined);
});

test("codex: malformed secondary cannot hide valid shared and additional quota", () => {
  const payload = {
    rate_limit: { primary_window: CODEX_PAYLOAD.rate_limit.primary_window, secondary_window: { used_percent: "x" } },
    additional_rate_limits: CODEX_PAYLOAD.additional_rate_limits,
  };
  const result = interpretCodex(200, payload, NOW);
  assert.deepEqual(
    result.windows.map((w) => w.label),
    ["primary (shared) · 5h", "codex_other · 30m"],
  );
  assert.equal(result.partialNotice, "1 quota group(s) missing or malformed");
});

test("codex: invalid shared quota leaves additional groups visible", () => {
  const result = interpretCodex(200, { rate_limit: null, additional_rate_limits: CODEX_PAYLOAD.additional_rate_limits }, NOW);
  assert.deepEqual(result.windows.map((w) => w.label), ["codex_other · 30m"]);
  assert.ok(result.partialNotice);
});

test("codex: nothing usable is unsupported", () => {
  expectError("unsupported", () => interpretCodex(200, { rate_limit: {} }, NOW));
  expectError("unsupported", () => interpretCodex(200, {}, NOW));
});

test("codex: auth and request status mapping", () => {
  expectError("auth", () => interpretCodex(401, null, NOW));
  expectError("request", () => interpretCodex(500, null, NOW));
});

test("codex: account id derivation validates the runtime token claim", () => {
  assert.equal(codexAccountId(jwtWith(CODEX_CLAIM)), "acct-123");
  assert.ok(codexAccountId(jwtWith({})) instanceof UsageError);
  assert.ok(codexAccountId("not-a-jwt") instanceof UsageError);
  assert.ok(codexAccountId(jwtWith({ "https://api.openai.com/auth": { chatgpt_account_id: "bad id\n" } })) instanceof UsageError);
});

test("codex: adapter sends bearer + runtime-derived account header", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: CODEX_PAYLOAD };
  };
  const token = jwtWith(CODEX_CLAIM);
  await codexAdapter.fetchQuota({ apiKey: token, oauth: true }, getJson);
  assert.equal(calls[0]!.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0]!.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0]!.headers["chatgpt-account-id"], "acct-123");
});

test("codex: non-OAuth resolution is rejected without a request", async () => {
  let requests = 0;
  const getJson = async () => {
    requests++;
    return { status: 200, data: CODEX_PAYLOAD };
  };
  const error = await codexAdapter
    .fetchQuota({ apiKey: "sk-api-key", oauth: false }, getJson)
    .catch((e) => e);
  assert.ok(error instanceof UsageError && error.kind === "auth");
  assert.equal(requests, 0);
});

// ---------------------------------------------------------------------- Kimi

const KIMI_PAYLOAD = {
  usage: { limit: 100, used: 30, remaining: 70, resetTime: new Date(NOW + 86_400_000).toISOString() },
  limits: [
    { detail: { limit: 50, used: 10, remaining: 40 }, window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" } },
    { detail: { limit: 200, used: 0, remaining: 200 }, window: { duration: 7, timeUnit: "TIME_UNIT_DAY" } },
  ],
};

test("kimi: main usage and rolling limits parse with window units", () => {
  const result = interpretKimi(200, KIMI_PAYLOAD, NOW);
  assert.equal(result.providerId, "kimi-coding");
  assert.deepEqual(
    result.windows.map((w) => w.label),
    ["weekly", "5h window", "7d window"],
  );
  assert.deepEqual(result.windows[0]!.used, { value: 30, unit: "uses" });
  assert.deepEqual(result.windows[0]!.remaining, { value: 70, unit: "uses" });
  assert.equal(result.windows[2]!.used!.value, 0);
  assert.equal(result.partialNotice, undefined);
});

test("kimi: finite numeric strings are accepted", () => {
  const result = interpretKimi(200, { usage: { limit: "100", used: "30", remaining: "70" } }, NOW);
  assert.deepEqual(result.windows[0]!.limit, { value: 100, unit: "uses" });
  assert.deepEqual(result.windows[0]!.used, { value: 30, unit: "uses" });
});

test("kimi: missing used derives from valid limit and remaining", () => {
  const result = interpretKimi(200, { usage: { limit: 100, remaining: 25 } }, NOW);
  assert.deepEqual(result.windows[0]!.used, { value: 75, unit: "uses" });
});

test("kimi: missing remaining derives from valid limit and used", () => {
  const result = interpretKimi(200, { usage: { limit: 100, used: 40 } }, NOW);
  assert.deepEqual(result.windows[0]!.remaining, { value: 60, unit: "uses" });
});

test("kimi: present-but-invalid fields drop the bucket, never become zero", () => {
  const result = interpretKimi(
    200,
    { usage: { limit: 100, used: "garbage" }, limits: KIMI_PAYLOAD.limits },
    NOW,
  );
  assert.deepEqual(result.windows.map((w) => w.label), ["5h window", "7d window"]);
  assert.equal(result.partialNotice, "1 quota bucket(s) missing or malformed");
});

test("kimi: unusable limit is dropped rather than shown", () => {
  const result = interpretKimi(200, { usage: { limit: -5, used: 3 } }, NOW);
  assert.ok(!result.windows.some((w) => w.limit));
  assert.deepEqual(result.windows[0]!.used, { value: 3, unit: "uses" });
});

test("kimi: time units map from the returned unit, not position", () => {
  const quota = { limit: 10, used: 1 };
  const cases: Array<[unknown, string]> = [
    [{ detail: quota, window: { duration: 720, timeUnit: "TIME_UNIT_MINUTE" } }, "12h window"],
    [{ detail: quota, window: { duration: 90, timeUnit: "TIME_UNIT_MINUTE" } }, "90m window"],
    [{ detail: quota, window: { duration: 300, timeUnit: "TIME_UNIT_SECOND" } }, "300s window"],
    [{ detail: quota, window: { duration: 5, timeUnit: "TIME_UNIT_WEIRD" } }, "rolling window"],
    [{ detail: quota }, "rolling window"],
  ];
  for (const [item, expected] of cases) {
    const result = interpretKimi(200, { limits: [item] }, NOW);
    assert.equal(result.windows[0]!.label, expected);
  }
});

test("kimi: limits entries without detail wrapper parse directly", () => {
  const result = interpretKimi(200, { limits: [{ limit: 10, used: 2, window: { duration: 1, timeUnit: "TIME_UNIT_DAY" } }] }, NOW);
  assert.deepEqual(result.windows[0]!.used, { value: 2, unit: "uses" });
  assert.equal(result.windows[0]!.label, "1d window");
});

test("kimi: no usable buckets is unsupported", () => {
  expectError("unsupported", () => interpretKimi(200, { usage: {}, limits: [] }, NOW));
  expectError("unsupported", () => interpretKimi(200, null, NOW));
});

test("kimi: auth and request status mapping", () => {
  expectError("auth", () => interpretKimi(401, null, NOW));
  expectError("request", () => interpretKimi(500, null, NOW));
});

test("kimi: adapter sends bearer auth to the fixed endpoint", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: KIMI_PAYLOAD };
  };
  await kimiAdapter.fetchQuota({ apiKey: "kimi-key", oauth: false }, getJson);
  assert.equal(calls[0]!.url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(calls[0]!.headers.authorization, "Bearer kimi-key");
});

// ---------------------------------------------------------------------- Z.ai

const ZAI_CREDIT_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 2005, remaining: 0, percentage: 100, nextResetTime: 1_786_624_439_633 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 2005, remaining: 7994, percentage: 20, nextResetTime: 1_787_210_351_998 },
    ],
    level: "lite",
  },
};

test("zai: credit limits map usage=limit, currentValue=used, percentage=consumed", () => {
  const result = interpretZai(200, ZAI_CREDIT_PAYLOAD, NOW);
  assert.equal(result.providerId, "zai");
  const fiveHour = result.windows[0]!;
  assert.equal(fiveHour.label, "5-hour");
  assert.deepEqual(fiveHour.limit, { value: 2000, unit: "credits" });
  assert.deepEqual(fiveHour.used, { value: 2005, unit: "credits" });
  assert.deepEqual(fiveHour.remaining, { value: 0, unit: "credits" });
  assert.equal(fiveHour.usedPercent, 100);
  assert.equal(fiveHour.resetsAt, 1_786_624_439_633);
  assert.equal(result.windows[1]!.label, "weekly");
  assert.equal(result.windows[1]!.usedPercent, 20);
  assert.equal(result.partialNotice, undefined);
});

test("zai: reordered limits keep window identity by (unit, number)", () => {
  const payload = { ...ZAI_CREDIT_PAYLOAD, data: { limits: [...ZAI_CREDIT_PAYLOAD.data.limits].reverse() } };
  const result = interpretZai(200, payload, NOW);
  assert.equal(result.windows[0]!.label, "weekly");
  assert.equal(result.windows[1]!.label, "5-hour");
});

test("zai: classic TOKENS_LIMIT percentage-only entries parse", () => {
  const payload = { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 }] } };
  const result = interpretZai(200, payload, NOW);
  assert.equal(result.windows[0]!.label, "5-hour");
  assert.equal(result.windows[0]!.usedPercent, 12);
  assert.equal(result.windows[0]!.limit, undefined);
  assert.equal(result.windows[0]!.used, undefined);
});

test("zai: TIME_LIMIT tool allowance is a separate window", () => {
  const payload = { data: { limits: [...ZAI_CREDIT_PAYLOAD.data.limits, { type: "TIME_LIMIT", percentage: 40, usage: 1000, currentValue: 400 }] } };
  const result = interpretZai(200, payload, NOW);
  const mcp = result.windows[2]!;
  assert.equal(mcp.label, "MCP tools (monthly)");
  assert.deepEqual(mcp.limit, { value: 1000, unit: "units" });
  assert.deepEqual(mcp.used, { value: 400, unit: "units" });
});

test("zai: unknown (unit, number) identifiers stay unknown", () => {
  const payload = { data: { limits: [{ type: "CREDIT_LIMIT", unit: 9, number: 2, percentage: 5 }] } };
  const result = interpretZai(200, payload, NOW);
  assert.equal(result.windows[0]!.label, "unknown (9/2)");
});

test("zai: null or zero nextResetTime stays unknown", () => {
  const payload = { data: { limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: null },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 5, nextResetTime: 0 },
  ] } };
  const result = interpretZai(200, payload, NOW);
  assert.equal(result.windows[0]!.resetsAt, undefined);
  assert.equal(result.windows[1]!.resetsAt, undefined);
});

test("zai: API-level envelope error with HTTP 200 is a request error", () => {
  expectError("request", () => interpretZai(200, { code: 200, success: false, msg: "denied" }, NOW));
  expectError("request", () => interpretZai(200, { code: 500, success: true }, NOW));
});

test("zai: missing limits and unrecognized shapes are unsupported", () => {
  expectError("unsupported", () => interpretZai(200, { code: 200, success: true, data: {} }, NOW));
  expectError("unsupported", () => interpretZai(200, { data: { limits: [{ type: "MYSTERY", percentage: 1 }] } }, NOW));
  expectError("unsupported", () => interpretZai(200, null, NOW));
});

test("zai: malformed entries drop with a notice, valid ones survive", () => {
  const payload = { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: "x" }, ZAI_CREDIT_PAYLOAD.data.limits[0]] } };
  const result = interpretZai(200, payload, NOW);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]!.label, "5-hour");
  assert.ok(result.partialNotice);
});

test("zai: auth and request status mapping", () => {
  expectError("auth", () => interpretZai(401, null, NOW));
  expectError("request", () => interpretZai(503, null, NOW));
});

test("zai: adapter sends the raw key without a Bearer prefix", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: ZAI_CREDIT_PAYLOAD };
  };
  await zaiAdapter.fetchQuota({ apiKey: "zai.rawkey", oauth: false }, getJson);
  assert.equal(calls[0]!.url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(calls[0]!.headers.authorization, "zai.rawkey");
});

// ----------------------------------------------------------------------- Grok

import { grokAdapter, interpretUserId } from "../src/providers/grok.ts";

/** Scripted per-endpoint getJson with call recording. */
function grokGetJson(
  responses: { user?: unknown; credits?: unknown; monthly?: unknown },
  opts: { userStatus?: number; creditsStatus?: number; monthlyStatus?: number; monthlyThrows?: Error } = {},
) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    if (url.includes("/v1/user")) return { status: opts.userStatus ?? 200, data: responses.user };
    if (url.includes("format=credits")) return { status: opts.creditsStatus ?? 200, data: responses.credits };
    if (opts.monthlyThrows) throw opts.monthlyThrows;
    return { status: opts.monthlyStatus ?? 200, data: responses.monthly };
  };
  return { getJson, calls };
}

const GROK_USER = { userId: "user-abc-123", email: "x@y.z" };
const GROK_CREDITS_MODERN = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: ISO, end: ISO },
  },
};

test("grok: non-OAuth resolution is rejected before any request", async () => {
  const { getJson, calls } = grokGetJson({ user: GROK_USER, credits: GROK_CREDITS_MODERN });
  await expectAsyncError("auth", () => grokAdapter.fetchQuota({ apiKey: "sk-key", oauth: false }, getJson));
  assert.equal(calls.length, 0, "API keys must never reach Grok endpoints");
});

async function expectAsyncError(kind: string, fn: () => Promise<unknown>): Promise<UsageError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected UsageError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail("expected a throw");
}

test("grok: identity is fetched first and gates billing requests", async () => {
  const { getJson, calls } = grokGetJson({ user: GROK_USER, credits: GROK_CREDITS_MODERN });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.endsWith("/v1/user"));
  assert.ok(calls[1]!.url.endsWith("/v1/billing?format=credits"));
  assert.equal(calls[1]!.headers["x-userid"], "user-abc-123");
  assert.equal(calls[1]!.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(calls[0]!.headers.authorization, "Bearer tok");
  assert.ok(!("x-userid" in calls[0]!.headers), "identity request carries no user id");
  assert.equal(calls[0]!.headers["x-grok-client-version"], "1.0.16");
  assert.equal(result.windows[0]!.usedPercent, 42.5);
  assert.equal(result.windows[0]!.label, "current period (weekly)");
  assert.equal(result.domainLabel, "Grok coding credits");
});

test("grok: invalid identity prevents billing requests", async () => {
  for (const bad of [undefined, { userId: "" }, { userId: 42 }, { userId: "a\tb" }, { userId: "x".repeat(257) }, null]) {
    const { getJson, calls } = grokGetJson({ user: bad, credits: GROK_CREDITS_MODERN });
    await expectAsyncError("unsupported", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
    assert.equal(calls.length, 1, `billing must not run for identity ${JSON.stringify(bad)}`);
  }
});

test("grok: identity endpoint auth failure is an auth error before billing", async () => {
  const { getJson, calls } = grokGetJson({ user: GROK_USER }, { userStatus: 401 });
  await expectAsyncError("auth", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
  assert.equal(calls.length, 1);
});

test("grok: modern percent with monthly period type", async () => {
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: {
      config: {
        creditUsagePercent: 7,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: ISO, end: ISO },
      },
    },
  });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]!.label, "current period (monthly)");
});

test("grok: legacy cent pair inside credits derives percent and USD values", async () => {
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: {
      config: {
        used: { val: 1234 },
        monthlyLimit: { val: 2000 },
        billingPeriodEnd: ISO,
      },
    },
  });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  const window = result.windows[0]!;
  assert.equal(window.usedPercent, 61.7);
  assert.equal(window.used!.value, 12.34);
  assert.equal(window.limit!.value, 20);
  assert.equal(window.remaining!.value, 7.66);
  assert.equal(window.used!.unit, "USD");
  assert.equal(window.resetsAt, NOW + 3_600_000);
});

test("grok: proto3 zero omission — credits config with a period and no usage fields is 0%", async () => {
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: ISO } } },
  });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(result.windows[0]!.usedPercent, 0);
});

test("grok: present-but-invalid percent never becomes zero", async () => {
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: { config: { creditUsagePercent: "bogus", currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } },
  });
  // No usable credits window → optional monthly probe runs and also yields nothing.
  await expectAsyncError("unsupported", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
});

test("grok: out-of-range percent and malformed cents stay unknown", async () => {
  assert.equal(interpretUserId({ userId: "ok" }), "ok");
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: {
      config: {
        creditUsagePercent: 150,
        used: { val: "nope" },
        monthlyLimit: -5,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      },
    },
  });
  // percent present-but-invalid, used/monthlyLimit present-but-invalid → no
  // proto3 omission case → falls through to the optional monthly probe.
  await expectAsyncError("unsupported", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
});

test("grok: unified billing probes monthly; both windows stay separate", async () => {
  const { getJson, calls } = grokGetJson({
    user: GROK_USER,
    credits: {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: ISO },
        isUnifiedBillingUser: true,
      },
    },
    monthly: { config: { used: { val: 500 }, monthlyLimit: { val: 1000 }, billingPeriodEnd: ISO } },
  });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(calls.length, 3);
  assert.ok(calls[2]!.url.endsWith("/v1/billing"));
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0]!.label, "current period (weekly)");
  assert.equal(result.windows[1]!.label, "monthly");
  assert.equal(result.windows[1]!.usedPercent, 50);
});

test("grok: optional monthly failure does not hide a valid credits result", async () => {
  // Unified billing forces the monthly probe; its failure leaves the valid
  // credits window intact with a partial notice.
  const { getJson, calls } = grokGetJson(
    {
      user: GROK_USER,
      credits: { config: { creditUsagePercent: 42.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: ISO }, isUnifiedBillingUser: true } },
    },
    { monthlyThrows: new UsageError("request", "Grok monthly billing endpoint returned HTTP 500") },
  );
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]!.usedPercent, 42.5);
  assert.ok(result.partialNotice);
  assert.equal(calls.length, 3);
});

test("grok: valid non-unified credits skip the monthly endpoint entirely", async () => {
  const { getJson, calls } = grokGetJson({ user: GROK_USER, credits: GROK_CREDITS_MODERN });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(calls.length, 2, "no monthly request when credits quota is usable");
  assert.equal(result.partialNotice, undefined);
});

test("grok: monthly failure is fatal only when credits exposed no quota", async () => {
  const { getJson } = grokGetJson({ user: GROK_USER, credits: { config: {} } }, { monthlyStatus: 500 });
  await expectAsyncError("request", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
});

test("grok: unusable credits fall back to a valid legacy monthly result", async () => {
  const { getJson } = grokGetJson({
    user: GROK_USER,
    credits: { config: null },
    monthly: { config: { used: { val: 250 }, monthlyLimit: { val: 1000 }, billingPeriodEnd: ISO } },
  });
  const result = await grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]!.label, "monthly");
  assert.equal(result.error, undefined);
});

test("grok: billing 403 after valid identity is an auth error", async () => {
  const { getJson, calls } = grokGetJson({ user: GROK_USER }, { creditsStatus: 403 });
  await expectAsyncError("auth", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
  assert.equal(calls.length, 2);
});

test("grok: null and non-object config responses are not usable windows", async () => {
  const { getJson } = grokGetJson({ user: GROK_USER, credits: null, monthly: null });
  await expectAsyncError("unsupported", () => grokAdapter.fetchQuota({ apiKey: "tok", oauth: true }, getJson));
});

// ---------------------------------------------------------- GitHub Copilot

import { githubCopilotAdapter, interpretGitHubCopilot } from "../src/providers/github-copilot.ts";

const COPILOT_UTC_RESET = "2026-10-01T08:00:00Z";

function copilotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copilot_plan: "pro",
    token_based_billing: true,
    quota_reset_date_utc: COPILOT_UTC_RESET,
    quota_snapshots: {
      premium_interactions: { percent_remaining: 62.5, unlimited: false, has_quota: true },
      completions: { percent_remaining: 10, unlimited: true },
      chat: { percent_remaining: 5, unlimited: false },
    },
    organization_login_list: ["acme-org"],
    analytics_tracking_id: "tid-123",
    ...overrides,
  };
}

test("copilot: AI-credit billing mode maps remaining percent to a single window", () => {
  const result = interpretGitHubCopilot(200, copilotPayload(), NOW);
  assert.equal(result.providerId, "github-copilot");
  assert.equal(result.providerName, "GitHub Copilot");
  assert.equal(result.domainLabel, "AI-credit allowance");
  assert.deepEqual(result.windows, [
    { label: "main allowance", usedPercent: 37.5, resetsAt: Date.parse(COPILOT_UTC_RESET) },
  ]);
});

test("copilot: billing flag selects legacy or neutral domain labels", () => {
  assert.equal(
    interpretGitHubCopilot(200, copilotPayload({ token_based_billing: false }), NOW).domainLabel,
    "Legacy premium-request allowance",
  );
  assert.equal(
    interpretGitHubCopilot(200, copilotPayload({ token_based_billing: "yes" }), NOW).domainLabel,
    "Copilot allowance",
  );
  assert.equal(interpretGitHubCopilot(200, copilotPayload({ token_based_billing: undefined }), NOW).domainLabel, "Copilot allowance");
});

test("copilot: explicit free plan meters the chat snapshot, not completions", () => {
  const result = interpretGitHubCopilot(
    200,
    copilotPayload({
      copilot_plan: "free",
      quota_reset_date_utc: undefined,
      quota_reset_date: "2026-10-01",
      limited_user_reset_date: "2026-09-01",
    }),
    NOW,
  );
  assert.equal(result.windows[0]!.usedPercent, 95, "chat snapshot percent (5 remaining)");
  assert.equal(result.windows[0]!.resetDate, "2026-10-01", "quota_reset_date wins over limited_user_reset_date");

  const fallback = interpretGitHubCopilot(
    200,
    copilotPayload({ copilot_plan: "free", quota_reset_date_utc: undefined, quota_reset_date: "2026-13-01", limited_user_reset_date: "2026-09-01" }),
    NOW,
  );
  assert.equal(fallback.windows[0]!.resetDate, "2026-09-01", "invalid quota_reset_date falls back to limited_user_reset_date");
});

test("copilot: zero and fractional remaining percentages are preserved", () => {
  const zero = interpretGitHubCopilot(200, copilotPayload({ quota_snapshots: { premium_interactions: { percent_remaining: 0, unlimited: false } } }), NOW);
  assert.equal(zero.windows[0]!.usedPercent, 100, "zero remaining is real exhaustion");
  const fractional = interpretGitHubCopilot(200, copilotPayload({ quota_snapshots: { premium_interactions: { percent_remaining: 0.5, unlimited: false } } }), NOW);
  assert.equal(fractional.windows[0]!.usedPercent, 99.5);
});

test("copilot: missing, malformed, or out-of-range percentages are unsupported", () => {
  for (const percent_remaining of [undefined, "lots", 101, -1, null, Number.POSITIVE_INFINITY]) {
    expectError(
      "unsupported",
      () => interpretGitHubCopilot(200, copilotPayload({ quota_snapshots: { premium_interactions: { percent_remaining, unlimited: false } } }), NOW),
    );
  }
});

test("copilot: unlimited personal plan reports unlimited, ignoring placeholder percent", () => {
  const result = interpretGitHubCopilot(
    200,
    copilotPayload({ quota_snapshots: { premium_interactions: { percent_remaining: 100, unlimited: true } } }),
    NOW,
  );
  assert.equal(result.windows[0]!.status, "unlimited");
  assert.equal(result.windows[0]!.usedPercent, undefined, "placeholder percentage is not a balance");
});

test("copilot: unlimited organization and unknown plans report organization-managed", () => {
  for (const copilot_plan of ["business", "enterprise", "mystery-plan", undefined]) {
    const payload = copilotPayload({
      ...(copilot_plan === undefined ? { copilot_plan: undefined } : { copilot_plan }),
      quota_snapshots: { premium_interactions: { percent_remaining: 100, unlimited: true } },
    });
    const result = interpretGitHubCopilot(200, payload, NOW);
    assert.equal(result.windows[0]!.status, "organization-managed", `plan ${String(copilot_plan)}`);
  }
});

test("copilot: timestamped reset wins; invalid resets stay absent without losing usage", () => {
  const timestamped = interpretGitHubCopilot(200, copilotPayload(), NOW);
  assert.equal(timestamped.windows[0]!.resetsAt, Date.parse(COPILOT_UTC_RESET));

  const dateOnly = interpretGitHubCopilot(
    200,
    copilotPayload({ quota_reset_date_utc: "not-a-date", quota_reset_date: "2026-10-01" }),
    NOW,
  );
  assert.equal(dateOnly.windows[0]!.resetsAt, undefined);
  assert.equal(dateOnly.windows[0]!.resetDate, "2026-10-01");
  assert.equal(dateOnly.windows[0]!.usedPercent, 37.5, "valid usage survives invalid reset data");

  const noReset = interpretGitHubCopilot(
    200,
    copilotPayload({ quota_reset_date_utc: undefined, quota_reset_date: "2026-02-31" }),
    NOW,
  );
  assert.equal(noReset.windows[0]!.resetDate, undefined, "calendar-invalid dates are absent");
  assert.equal(noReset.windows[0]!.resetsAt, undefined);
  assert.equal(noReset.windows[0]!.usedPercent, 37.5);

  const utcDateOnly = interpretGitHubCopilot(
    200,
    copilotPayload({ quota_reset_date_utc: "2026-10-01" }),
    NOW,
  );
  assert.equal(utcDateOnly.windows[0]!.resetsAt, undefined, "date-only utc value manufactures no midnight countdown");
  assert.equal(utcDateOnly.windows[0]!.resetDate, "2026-10-01");
});

test("copilot: status errors are fixed and sanitized", () => {
  const rejected = expectError("auth", () => interpretGitHubCopilot(401, { message: "bad token" }, NOW));
  assert.equal(rejected.message, "Credentials were rejected by GitHub Copilot");
  const denied = expectError("auth", () => interpretGitHubCopilot(403, { message: "forbidden detail" }, NOW));
  assert.equal(denied.message, "Access to GitHub Copilot usage was denied");
  assert.ok(!denied.message.includes("expired") && !denied.message.includes("subscription"), "403 does not assert a cause");
  const request = expectError("request", () => interpretGitHubCopilot(503, { oops: true }, NOW));
  assert.equal(request.message, "Usage endpoint returned HTTP 503");
});

test("copilot: unusable 200 bodies are unsupported", () => {
  expectError("unsupported", () => interpretGitHubCopilot(200, null, NOW));
  expectError("unsupported", () => interpretGitHubCopilot(200, {}, NOW));
  expectError("unsupported", () => interpretGitHubCopilot(200, { quota_snapshots: {} }, NOW));
  expectError("unsupported", () => interpretGitHubCopilot(200, copilotPayload({ copilot_plan: "free", quota_snapshots: { premium_interactions: { percent_remaining: 50, unlimited: false } } }), NOW));
});

test("copilot: results never surface organization or tracking identifiers", () => {
  const result = interpretGitHubCopilot(200, copilotPayload({ copilot_plan: "business", quota_snapshots: { premium_interactions: { percent_remaining: 40, unlimited: false } } }), NOW);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("acme-org"));
  assert.ok(!serialized.includes("tid-123"));
});

test("copilot: adapter sends bearer auth with source-derived client headers to the fixed endpoint", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const getJson = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { status: 200, data: copilotPayload() };
  };
  await githubCopilotAdapter.fetchQuota({ apiKey: "ghu-session", oauth: true }, getJson);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/copilot_internal/user");
  assert.deepEqual(calls[0]!.headers, {
    accept: "application/json",
    authorization: "Bearer ghu-session",
    "user-agent": "GitHubCopilotChat/0.35.0",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
    "copilot-integration-id": "vscode-chat",
  });
});

test("copilot: non-OAuth resolution is rejected without a request", async () => {
  let requests = 0;
  const getJson = async () => {
    requests++;
    return { status: 200, data: copilotPayload() };
  };
  const error = await githubCopilotAdapter
    .fetchQuota({ apiKey: "ghp-api-key", oauth: false }, getJson)
    .catch((e) => e);
  assert.ok(error instanceof UsageError && error.kind === "auth");
  assert.equal(requests, 0);
});
