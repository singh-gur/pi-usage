import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretOpenCodeGo, opencodeGoAdapter } from "../src/providers/opencode-go.ts";
import { interpretOpenRouter, openrouterAdapter } from "../src/providers/openrouter.ts";
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
