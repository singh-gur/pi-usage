import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAdapter } from "../src/providers/codex.ts";
import { anthropicAdapter } from "../src/providers/anthropic.ts";
import { zaiAdapter } from "../src/providers/zai.ts";
import { createPostJson, type GetJson, type PostJson } from "../src/http.ts";
import { attachResets, lowQuotaResetAvailable } from "../src/resets.ts";
import { UsageMonitor, type MonitorSession } from "../src/refresh.ts";
import { DEFAULT_USAGE_SETTINGS, parseUsageSettings } from "../src/settings.ts";
import { UsageView, renderUsageLines } from "../src/ui.ts";
import { UsageError, type ProviderUsage, type QuotaAdapter } from "../src/types.ts";

const auth = { apiKey: jwt("account-1"), oauth: true };
function jwt(account: string, version = 1): string {
  return `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, version })).toString("base64url")}.sig`;
}
const expires = () => new Date(Date.now() + 86_400_000).toISOString();
const credit = (overrides: Record<string, unknown> = {}) => ({
  id: "RateLimitResetCredit_1", reset_type: "codex_rate_limits", status: "available", expires_at: expires(), ...overrides,
});
const inventory = (credits = [credit()]) => ({ credits, available_count: credits.length });
const response = (data: unknown, status = 200) => ({ status, data });
const quota = (used = 95) => ({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
  secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
} });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function env(options: { adapter?: QuotaAdapter; post?: PostJson; threshold?: number; mode?: string } = {}) {
  let key = auth.apiKey;
  let body: unknown = inventory();
  let used = 95;
  let profileGate: Promise<void> | undefined;
  let authGate: Promise<void> | undefined;
  let authCalls = 0;
  const calls: string[] = [];
  const posts: unknown[] = [];
  const notices: string[] = [];
  const adapter = options.adapter ?? codexAdapter;
  const get: GetJson = async (url) => {
    calls.push(url);
    if (url.includes("/profile")) {
      await profileGate;
      return response({ organization: { uuid: "11111111-2222-3333-4444-555555555555" } });
    }
    if (url.includes("at_wall")) return response(body);
    if (url.includes("reset-credits")) return response(body);
    if (adapter.id === "anthropic") return response({ five_hour: { utilization: used } });
    return response(quota(used));
  };
  const session: MonitorSession = {
    mode: options.mode ?? "tui",
    gateway: {
      isConfigured: () => true,
      resolveAuth: async () => {
        authCalls++;
        await authGate;
        return { auth: { apiKey: key }, source: "OAuth" };
      },
      providerInfo: () => undefined,
    },
    setStatus: () => {},
    notify: (message) => { notices.push(message); },
  };
  const monitor = new UsageMonitor({ adapters: [adapter], createRequester: () => get,
    createResetRequester: () => options.post ?? (async (_url, _headers, data) => {
      posts.push(data);
      body = inventory([]);
      used = 0;
      return response({ code: "reset" });
    }),
    settings: { ...DEFAULT_USAGE_SETTINGS, pollIntervalMinutes: 0, resetThresholdPercent: options.threshold ?? 10 },
  });
  monitor.startSession(session, undefined);
  return { monitor, adapter, session, posts, calls, notices,
    setKey: (value: string) => { key = value; },
    setInventory: (value: unknown) => { body = value; },
    setUsed: (value: number) => { used = value; },
    setProfileGate: (value: Promise<void>) => { profileGate = value; },
    setAuthGate: (value: Promise<void>) => { authGate = value; },
    authCalls: () => authCalls,
  };
}

test("resets: Codex validates credit status, type, expiry, ids and count", async () => {
  const credits = [credit(), credit({ id: "expired", expires_at: new Date(0).toISOString() }),
    credit({ id: "redeemed", status: "redeemed" }), credit({ id: "future", reset_type: "new_kind" }),
    credit({ id: "bad-date", expires_at: "nope" }), credit({ id: "\x1b[31m" })];
  const result = await codexAdapter.fetchResets!(auth, async () => response({ credits, available_count: 8 }));
  assert.equal(result.availableCount, 8, "count is not inferred from the details list");
  assert.deepEqual(result.offers.map((item) => item.id), ["RateLimitResetCredit_1"]);
  for (const count of [undefined, -1, 1.5, "1"]) {
    await assert.rejects(codexAdapter.fetchResets!(auth, async () => response({ credits, available_count: count })), UsageError);
  }
  assert.deepEqual((await codexAdapter.fetchResets!(auth, async () => response({ credits, available_count: 0 }))).offers, []);
  await assert.rejects(codexAdapter.fetchResets!({ ...auth, oauth: false }, async () => { assert.fail("must not request"); }), /OAuth/);
});

test("resets: Codex uses account-bound headers, selected id, and idempotency key", async () => {
  const offer = { id: "RateLimitResetCredit_1", label: "Full reset" };
  for (const code of ["reset", "already_redeemed", "nothing_to_reset", "no_credit"]) {
    const message = await codexAdapter.redeemReset!(auth, offer, async () => { assert.fail(); }, async (url, headers, body) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
      assert.equal(headers["chatgpt-account-id"], "account-1");
      assert.deepEqual(body, { credit_id: offer.id, redeem_request_id: "request-1" });
      return response({ code });
    }, "request-1");
    assert.ok(message);
  }
  await assert.rejects(codexAdapter.redeemReset!(auth, offer, async () => response({}), async () => response({ code: "new_code" }), "r"), /unknown/);
});

test("resets: Anthropic requires all eligibility flags and a stable future weekly identity", async () => {
  const block = { eligible: true, arm: "reset", available: true, weekly_resets_at: expires() };
  const read = (juniper_tide: unknown) => anthropicAdapter.fetchResets!(auth, async (url) => {
    assert.match(url, /usage\?at_wall=1&skip_spend=1$/);
    return response({ juniper_tide });
  });
  assert.equal((await read(block)).offers.length, 1);
  for (const override of [{ eligible: false }, { eligible: "true" }, { arm: "control" }, { available: false },
    { weekly_resets_at: undefined }, { weekly_resets_at: "bad" }, { weekly_resets_at: new Date(0).toISOString() }]) {
    assert.equal((await read({ ...block, ...override })).offers.length, 0);
  }
  assert.equal((await read(undefined)).offers.length, 0);
});

test("resets: Anthropic resolves organization publicly and checks business result, not HTTP 200", async () => {
  const offer = { id: "juniper_tide:1", label: "5-hour" };
  const get: GetJson = async (url) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/profile");
    return response({ organization: { uuid: "11111111-2222-3333-4444-555555555555" } });
  };
  const result = await anthropicAdapter.redeemReset!(auth, offer, get, async (url, headers, body) => {
    assert.match(url, /\/organizations\/11111111-2222-3333-4444-555555555555\/reset_rate_limits$/);
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
    assert.deepEqual(body, { program: "juniper_tide" });
    return response({ result: "reset" });
  }, "unused");
  assert.match(result, /weekly limit unchanged/);
  await assert.rejects(anthropicAdapter.redeemReset!(auth, offer, get, async () => response({ result: "new" }), "r"), /unknown/);
  await assert.rejects(anthropicAdapter.redeemReset!(auth, offer, async () => response({ organization: { uuid: "../../elsewhere" } }),
    async () => { assert.fail("invalid identity must prevent mutation"); }, "r"), /organization/);
});

test("resets: Z.ai only lists available cards, without a redemption method", async () => {
  const result = await zaiAdapter.fetchResets!(auth, async (url, headers) => {
    assert.equal(url, "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL");
    assert.equal(headers.authorization, `Bearer ${auth.apiKey}`);
    return response({ code: 200, success: true, data: {
      fiveHourResets: [{ available: true }, { available: false }], weekResets: [{ available: true }],
    } });
  });
  assert.equal(result.availableCount, 2);
  assert.deepEqual(result.offers, []);
  assert.match(result.notice!, /redeem in ZCode/);
  assert.equal(zaiAdapter.redeemReset, undefined);
});

test("resets: inventory failures preserve successful quota and never become verified zero", async () => {
  const usage: ProviderUsage = { providerId: "p", providerName: "P", domainLabel: "quota", capturedAt: Date.now(), windows: [] };
  await attachResets({ ...codexAdapter, fetchResets: async () => { throw new Error("sensitive provider body"); } }, auth, async () => response({}), usage);
  assert.equal(usage.resets?.availableCount, undefined);
  assert.equal(usage.error, undefined);
  assert.match(usage.resets!.notice!, /could not be checked/);
  assert.ok(!JSON.stringify(usage).includes("sensitive"));
});

test("resets: thresholds are strict, 5-hour-only, expiry-aware and disableable", () => {
  const usage: ProviderUsage = { providerId: "openai-codex", providerName: "Codex", domainLabel: "quota", capturedAt: Date.now(),
    windows: [{ label: "5h", durationSeconds: 18_000, usedPercent: 95 }],
    resets: { offers: [{ id: "a", label: "Reset", expiresAt: Date.now() + 60_000 }] } };
  assert.equal(lowQuotaResetAvailable(usage, 10), true);
  assert.equal(lowQuotaResetAvailable(usage, 5), false);
  assert.equal(lowQuotaResetAvailable(usage, 0), false);
  usage.windows[0]!.durationSeconds = 604_800;
  assert.equal(lowQuotaResetAvailable(usage, 10), false);
  usage.windows[0]!.durationSeconds = 18_000;
  usage.resets!.offers[0]!.expiresAt = 0;
  assert.equal(lowQuotaResetAvailable(usage, 10), false);
  usage.resets!.offers = [];
  usage.resets!.availableCount = 1;
  assert.equal(lowQuotaResetAvailable(usage, 10), false, "a count alone cannot establish native redeemability");
  usage.providerId = "zai";
  assert.equal(lowQuotaResetAvailable(usage, 10), true, "Z.ai notice directs to external redemption");
});

test("resets: threshold setting accepts 0..100 integers and rejects invalid values", () => {
  for (const value of [0, 1, 10, 37, 100]) assert.deepEqual(parseUsageSettings({ resetThresholdPercent: value }, "project").settings, { resetThresholdPercent: value });
  for (const value of [-1, 101, NaN, Infinity, 2.5, "10", null]) {
    const result = parseUsageSettings({ resetThresholdPercent: value }, "global");
    assert.deepEqual(result.settings, {});
    assert.equal(result.warnings.length, 1);
  }
});

test("resets: monitor revalidates, posts once, refreshes quota and rejects duplicate attempts", async () => {
  const e = env();
  try {
    const selection = await e.monitor.prepareReset(e.adapter.id);
    const message = await e.monitor.redeemReset(selection, selection.offers[0]!.id);
    assert.match(message, /redeemed/);
    assert.equal(e.posts.length, 1);
    const cached = await e.monitor.serveCached(e.adapter.id);
    assert.equal(cached!.windows[0]!.usedPercent, 0);
    assert.equal(cached!.resets!.offers.length, 0);
    await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), /already attempted/);
  } finally { e.monitor.shutdown(); }
});

test("resets: monitor cancels on account changes, expired inventory and shutdown", async () => {
  for (const reason of ["account", "expiry", "shutdown", "missing"] as const) {
    const e = env();
    try {
      const selection = await e.monitor.prepareReset(e.adapter.id);
      if (reason === "account") e.setKey(jwt("other-account"));
      if (reason === "expiry") e.setInventory(inventory([credit({ expires_at: new Date(0).toISOString() })]));
      if (reason === "missing") e.setInventory(inventory([]));
      if (reason === "shutdown") e.monitor.shutdown();
      await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), UsageError);
      assert.equal(e.posts.length, 0, reason);
    } finally { e.monitor.shutdown(); }
  }
});

test("resets: changed routing and shutdown during credential resolution prevent mutation", async () => {
  const routed = env();
  try {
    const selection = await routed.monitor.prepareReset(routed.adapter.id);
    routed.session.gateway.providerInfo = () => ({ baseUrl: "https://proxy.example" });
    await assert.rejects(routed.monitor.redeemReset(selection, selection.offers[0]!.id), /custom base URL/);
    assert.equal(routed.posts.length, 0);
  } finally { routed.monitor.shutdown(); }
  const e = env();
  const gate = Promise.withResolvers<void>();
  try {
    const selection = await e.monitor.prepareReset(e.adapter.id);
    const authCalls = e.authCalls();
    e.setAuthGate(gate.promise);
    const pending = e.monitor.redeemReset(selection, selection.offers[0]!.id);
    for (let i = 0; i < 20 && e.authCalls() === authCalls; i++) await Promise.resolve();
    assert.ok(e.authCalls() > authCalls);
    e.monitor.shutdown();
    gate.resolve();
    await assert.rejects(pending, /Session changed/);
    assert.equal(e.posts.length, 0);
  } finally { gate.resolve(); e.monitor.shutdown(); }
});

test("resets: monitor suppresses duplicate concurrent mutations", async () => {
  const gate = Promise.withResolvers<{ status: number; data: unknown }>();
  let posts = 0;
  const e = env({ post: async () => { posts++; return gate.promise; } });
  try {
    const selection = await e.monitor.prepareReset(e.adapter.id);
    const first = e.monitor.redeemReset(selection, selection.offers[0]!.id);
    await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), /in progress/);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    assert.equal(posts, 1);
    gate.resolve(response({ code: "reset" }));
    await first;
  } finally { gate.resolve(response({ code: "reset" })); e.monitor.shutdown(); }
});

test("resets: ambiguous POST failures are sanitized, not retried, and invalidate cached offers", async () => {
  let posts = 0;
  const e = env({ post: async () => { posts++; throw new Error("private network body"); } });
  try {
    const selection = await e.monitor.prepareReset(e.adapter.id);
    await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), /outcome may be unknown/);
    await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), /already attempted/);
    assert.equal(posts, 1);
    assert.ok(e.calls.filter((url) => url.endsWith("/usage")).length >= 2, "quota reconciled after uncertainty");
  } finally { e.monitor.shutdown(); }
});

test("resets: session/account changes during Anthropic profile lookup prevent POST", async () => {
  for (const reason of ["account", "shutdown"] as const) {
    const e = env({ adapter: anthropicAdapter });
    const gate = Promise.withResolvers<void>();
    e.setInventory({ juniper_tide: { eligible: true, arm: "reset", available: true, weekly_resets_at: expires() } });
    try {
      const selection = await e.monitor.prepareReset(e.adapter.id);
      e.setProfileGate(gate.promise);
      const pending = e.monitor.redeemReset(selection, selection.offers[0]!.id);
      for (let i = 0; i < 100 && !e.calls.some((url) => url.includes("/profile")); i++) await Promise.resolve();
      assert.ok(e.calls.some((url) => url.includes("/profile")));
      if (reason === "account") e.setKey(jwt("changed"));
      else e.monitor.shutdown();
      gate.resolve();
      await assert.rejects(pending, UsageError);
      assert.equal(e.posts.length, 0);
    } finally { gate.resolve(); e.monitor.shutdown(); }
  }
});

test("resets: offline and non-TUI prevent redemption", async () => {
  const e = env();
  const previous = process.env.PI_OFFLINE;
  try {
    const selection = await e.monitor.prepareReset(e.adapter.id);
    process.env.PI_OFFLINE = "1";
    await assert.rejects(e.monitor.redeemReset(selection, selection.offers[0]!.id), /offline/);
    assert.equal(e.posts.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous;
    e.monitor.shutdown();
  }
  const rpc = env({ mode: "rpc" });
  try { await assert.rejects(rpc.monitor.prepareReset(rpc.adapter.id), /unavailable/); }
  finally { rpc.monitor.shutdown(); }
});

test("resets: notices only cover active provider and occur once per account/session", async () => {
  const e = env();
  try {
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 0, "inactive provider remains silent");
    e.monitor.setActiveProvider(e.adapter.id);
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 1);
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 1);
    assert.match(e.notices[0]!, /below 10%.*Open \/usage/);
    e.monitor.setSettings({ ...DEFAULT_USAGE_SETTINGS, pollIntervalMinutes: 0, resetThresholdPercent: 0 });
    e.setKey(jwt("another"));
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 1, "disabled threshold stays silent");
  } finally { e.monitor.shutdown(); }
});

test("resets: suppressed in-UI notices do not consume the later non-blocking notice", async () => {
  const e = env();
  try {
    e.session.notify = () => false;
    e.monitor.setActiveProvider(e.adapter.id);
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 0);
    e.session.notify = (message) => { e.notices.push(message); };
    await e.monitor.refreshProvider(e.adapter);
    await e.monitor.refreshProvider(e.adapter);
    assert.equal(e.notices.length, 1);
  } finally { e.monitor.shutdown(); }
});

test("resets: POST transport only accepts inspected reset routes, blocks redirects and offline", async () => {
  const original = globalThis.fetch;
  const previous = process.env.PI_OFFLINE;
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    assert.equal(init!.method, "POST");
    assert.equal(init!.redirect, "error");
    return new Response('{"code":"reset"}');
  }) as typeof fetch;
  try {
    for (const url of ["https://example.com/reset", "https://api.anthropic.com/api/organizations/invalid/reset_rate_limits",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume?other=1"]) {
      await assert.rejects(async () => createPostJson()(url, {}, {}), /unknown reset endpoint/);
    }
    assert.equal(requests, 0);
    await createPostJson()("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {}, {});
    process.env.PI_OFFLINE = "1";
    await assert.rejects(createPostJson()("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {}, {}), /PI_OFFLINE/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous;
  }
});

test("resets: POST transport bounds response size and body lifetime", async () => {
  const original = globalThis.fetch;
  const url = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
  try {
    globalThis.fetch = (async () => new Response("x".repeat(100))) as typeof fetch;
    await assert.rejects(createPostJson({ timeoutMs: 100, maxBytes: 16 })(url, {}, {}), /Response too large/);
    globalThis.fetch = (async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(new Error("private stream detail")), { once: true });
      },
    }))) as typeof fetch;
    await assert.rejects(createPostJson({ timeoutMs: 10, maxBytes: 100 })(url, {}, {}), /Request timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createPostJson(undefined, controller.signal)(url, {}, {}), /Request canceled/);
  } finally { globalThis.fetch = original; }
});

test("resets: UI shows offer expiry without identifiers and r is disabled for expired/unknown offers", () => {
  const usage: ProviderUsage = { providerId: "openai-codex", providerName: "Codex", domainLabel: "quota", capturedAt: Date.now(), windows: [],
    resets: { availableCount: 1, offers: [{ id: "private-credit-id", label: "Full reset", expiresAt: Date.now() + 60_000 }] } };
  let requests = 0;
  const view = new UsageView({ theme, getEntries: () => [{ name: "Codex", usage }], onClose: () => {},
    onReset: () => requests++, requestRender: () => {} });
  assert.match(view.render(100).join("\n"), /r reset/);
  assert.match(renderUsageLines([{ name: "Codex", usage }], theme).join("\n"), /Expires:/);
  assert.doesNotMatch(view.render(100).join("\n"), /private-credit-id/);
  view.handleInput("r");
  assert.equal(requests, 1);
  usage.resets!.offers[0]!.expiresAt = 0;
  view.handleInput("r");
  assert.equal(requests, 1);
  assert.doesNotMatch(view.render(100).join("\n"), /r reset/);
});
