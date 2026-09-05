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
