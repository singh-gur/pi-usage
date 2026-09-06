import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveQuotaAuth, type AuthGateway, type PiAuthResult } from "../src/auth.ts";
import { bounded, createGetJson, isOffline } from "../src/http.ts";
import { UsageError, parseResetTime } from "../src/types.ts";

function gateway(setup: {
  configured?: boolean;
  resolved?: PiAuthResult | undefined;
  resolveThrows?: boolean;
  providerBaseUrl?: string;
}): AuthGateway {
  return {
    isConfigured: () => setup.configured ?? false,
    resolveAuth: async () => {
      if (setup.resolveThrows) throw new Error("secret internal detail");
      return setup.resolved;
    },
    providerInfo: () => (setup.providerBaseUrl !== undefined ? { baseUrl: setup.providerBaseUrl } : {}),
  };
}

// ----------------------------------------------------------------------- auth

const OFFICIAL = "https://openrouter.ai";

test("auth: unconfigured provider is not-configured, no auth call made", async () => {
  let resolveCalls = 0;
  const gw: AuthGateway = {
    isConfigured: () => false,
    resolveAuth: async () => {
      resolveCalls++;
      return undefined;
    },
    providerInfo: () => undefined,
  };
  const result = await resolveQuotaAuth(gw, "openrouter", OFFICIAL);
  assert.ok(result instanceof UsageError);
  assert.equal(result.kind, "not-configured");
  assert.equal(resolveCalls, 0);
});

test("auth: configured provider resolves an api key", async () => {
  const result = await resolveQuotaAuth(
    gateway({ configured: true, resolved: { auth: { apiKey: "k" }, source: "OPENROUTER_API_KEY" } }),
    "openrouter",
    OFFICIAL,
  );
  assert.deepEqual(result, { apiKey: "k", oauth: false });
});

test("auth: OAuth source marks oauth provenance", async () => {
  const result = await resolveQuotaAuth(
    gateway({ configured: true, resolved: { auth: { apiKey: "tok" }, source: "OAuth" } }),
    "openrouter",
    OFFICIAL,
  );
  assert.deepEqual(result, { apiKey: "tok", oauth: true });
});

test("auth: missing api key is an auth error", async () => {
  const result = await resolveQuotaAuth(
    gateway({ configured: true, resolved: { auth: {}, source: "stored" } }),
    "openrouter",
    OFFICIAL,
  );
  assert.ok(result instanceof UsageError && result.kind === "auth");
});

test("auth: undefined resolution is an auth error", async () => {
  const result = await resolveQuotaAuth(gateway({ configured: true, resolved: undefined }), "openrouter", OFFICIAL);
  assert.ok(result instanceof UsageError && result.kind === "auth");
});

test("auth: auth resolution failure is sanitized", async () => {
  const result = await resolveQuotaAuth(gateway({ configured: true, resolveThrows: true }), "openrouter", OFFICIAL);
  assert.ok(result instanceof UsageError && result.kind === "auth");
  assert.ok(!result.message.includes("secret internal detail"));
});

test("auth: custom provider base URL is refused", async () => {
  const result = await resolveQuotaAuth(
    gateway({
      configured: true,
      resolved: { auth: { apiKey: "k" } },
      providerBaseUrl: "https://proxy.example.com/v1",
    }),
    "openrouter",
    OFFICIAL,
  );
  assert.ok(result instanceof UsageError && result.kind === "auth");
  assert.equal(result.message, "Provider routes through a custom base URL; quota lookup refused");
});

test("auth: auth-level base URL override to another origin is refused", async () => {
  const result = await resolveQuotaAuth(
    gateway({ configured: true, resolved: { auth: { apiKey: "k", baseUrl: "https://evil.example/v1" } } }),
    "openrouter",
    OFFICIAL,
  );
  assert.ok(result instanceof UsageError && result.kind === "auth");
});

test("auth: official-origin base URLs are accepted", async () => {
  const ok = await resolveQuotaAuth(
    gateway({
      configured: true,
      resolved: { auth: { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" } },
      providerBaseUrl: "https://openrouter.ai/api/v1",
    }),
    "openrouter",
    OFFICIAL,
  );
  assert.deepEqual(ok, { apiKey: "k", oauth: false });
});

test("auth: provider without any base URL (opencode-go shape) is accepted", async () => {
  const result = await resolveQuotaAuth(
    gateway({ configured: true, resolved: { auth: { apiKey: "k" } } }),
    "opencode-go",
    "https://opencode.ai",
  );
  assert.deepEqual(result, { apiKey: "k", oauth: false });
});

test("auth: built-in provider origin is accepted only without an auth-level override", async () => {
  // xai shape: Pi's built-in model API origin differs from the quota origin.
  const QUOTA = "https://cli-chat-proxy.grok.com";
  const ok = await resolveQuotaAuth(
    gateway({
      configured: true,
      resolved: { auth: { apiKey: "tok" }, source: "OAuth" },
      providerBaseUrl: "https://api.x.ai/v1",
    }),
    "xai",
    QUOTA,
    "https://api.x.ai",
  );
  assert.deepEqual(ok, { apiKey: "tok", oauth: true });

  const refused = await resolveQuotaAuth(
    gateway({
      configured: true,
      resolved: { auth: { apiKey: "tok", baseUrl: "https://api.x.ai/v1" }, source: "OAuth" },
      providerBaseUrl: "https://api.x.ai/v1",
    }),
    "xai",
    QUOTA,
    "https://api.x.ai",
  );
  assert.ok(refused instanceof UsageError && refused.kind === "auth", "auth-level override must still match the quota origin");
});

// ----------------------------------------------------------------------- http

type FetchCall = { url: string; headers: Record<string, string>; opts: RequestInit };

async function expectReject(kind: string, promise: Promise<unknown>): Promise<UsageError> {
  const error = await promise.then(
    () => assert.fail("expected rejection"),
    (e) => e,
  );
  assert.ok(error instanceof UsageError, `expected UsageError, got ${String(error)}`);
  assert.equal(error.kind, kind);
  return error;
}

function installFetch(impl: (url: URL, call: FetchCall) => Promise<Response> | Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      opts: { ...init, headers: (init?.headers ?? {}) } as RequestInit,
    };
    calls.push(call);
    return impl(new URL(String(input)), call);
  }) as typeof fetch;
  return calls;
}

test("http: GET-JSON parses a successful body and uses read-only safe options", async () => {
  const calls = installFetch(() => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
  const getJson = createGetJson();
  const response = await getJson("https://openrouter.ai/api/v1/key", { authorization: "Bearer k" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { a: 1 });
  assert.equal(calls[0]!.opts.method, "GET");
  assert.equal(calls[0]!.opts.redirect, "error");
  assert.equal(calls[0]!.headers.authorization, "Bearer k");
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/key");
});

test("http: non-error status codes are passed through for adapter mapping", async () => {
  installFetch(() => new Response("", { status: 401 }));
  const response = await createGetJson()("https://example.com/x", {});
  assert.equal(response.status, 401);
  assert.equal(response.data, null);
});

test("http: plain http and credentialed URLs are refused before any fetch", async () => {
  let fetches = 0;
  installFetch(() => {
    fetches++;
    return new Response("{}");
  });
  const getJson = createGetJson();
  await expectReject("request", getJson("http://openrouter.ai/api/v1/key", {}));
  await expectReject("request", getJson("https://user:pass@openrouter.ai/api/v1/key", {}));
  assert.equal(fetches, 0);
});

test("http: network failures are sanitized without upstream detail", async () => {
  installFetch(() => Promise.reject(new TypeError("getaddrinfo ENOTFOUND internal.host")));
  const error = await expectReject(
    "request",
    createGetJson()("https://openrouter.ai/api/v1/key", {}),
  );
  assert.equal(error.message, "Network request failed");
});

test("http: oversized bodies are rejected", async () => {
  installFetch(() => new Response("x".repeat(64), { status: 200 }));
  const getJson = createGetJson({ timeoutMs: 1_000, maxBytes: 16 });
  await expectReject("request", getJson("https://openrouter.ai/api/v1/key", {}));
});

test("http: non-JSON success bodies are rejected", async () => {
  installFetch(() => new Response("<html>not json</html>", { status: 200 }));
  await expectReject("request", createGetJson()("https://openrouter.ai/api/v1/key", {}));
});

test("http: requests time out", async () => {
  installFetch(
    (_url, call) =>
      new Promise<Response>((_resolve, reject) => {
        call.opts.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const getJson = createGetJson({ timeoutMs: 20, maxBytes: 1024 });
  await expectReject("timeout", getJson("https://openrouter.ai/api/v1/key", {}));
});

test("http: outer signal abort maps to canceled", async () => {
  const controller = new AbortController();
  installFetch(
    (_url, call) =>
      new Promise<Response>((_resolve, reject) => {
        (call.opts.signal as AbortSignal).addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const getJson = createGetJson({ timeoutMs: 5_000, maxBytes: 1024 }, controller.signal);
  const pending = getJson("https://openrouter.ai/api/v1/key", {});
  controller.abort();
  const error = await pending.catch((e) => e);
  assert.ok(error instanceof UsageError && error.kind === "canceled");
});

// ------------------------------------------------------------- bounds & misc

test("bounded: passes through fast work and bounds slow work", async () => {
  assert.equal(await bounded(Promise.resolve(7), 1_000), 7);
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 80));
  slow.catch(() => {}); // late results are discarded, never unhandled
  const error = await bounded(slow, 10).catch((e) => e);
  assert.ok(error instanceof UsageError && error.kind === "timeout");
});

test("isOffline mirrors PI_OFFLINE presence", () => {
  const had = process.env.PI_OFFLINE;
  try {
    delete process.env.PI_OFFLINE;
    assert.equal(isOffline(), false);
    process.env.PI_OFFLINE = "";
    assert.equal(isOffline(), true);
    process.env.PI_OFFLINE = "1";
    assert.equal(isOffline(), true);
  } finally {
    if (had === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = had;
  }
});

test("parseResetTime handles epoch ms, epoch s, ISO strings, and rejects junk", () => {
  assert.equal(parseResetTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseResetTime(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseResetTime("2023-11-14T22:13:20Z"), 1_700_000_000_000);
  assert.equal(parseResetTime(null), undefined);
  assert.equal(parseResetTime("not-a-date"), undefined);
  assert.equal(parseResetTime(0), undefined);
  assert.equal(parseResetTime(Number.NaN), undefined);
});

// ------------------------------------------------- monitor (cache/scheduler)

import { mock } from "node:test";
import {
  EVENT_MIN_AGE_MS,
  POLL_INTERVAL_MS,
  STATUS_KEY,
  UsageMonitor,
  type MonitorSession,
} from "../src/refresh.ts";
import type { GetJson } from "../src/http.ts";
import type { QuotaAdapter, QuotaWindow } from "../src/types.ts";

type GateResult = { status: number; data: unknown; retryAfterMs?: number };

function monitorAdapter(id: string, makeWindows: (now: number) => QuotaWindow[]): QuotaAdapter {
  return {
    id,
    name: id === "opencode-go" ? "OpenCode Go" : id,
    officialOrigin: `https://${id}.example`,
    domainLabel: "test quota",
    async fetchQuota(_auth, getJson) {
      const response = await getJson(`https://${id}.example/usage`, {});
      if (response.status !== 200) throw new UsageError("request", `HTTP ${response.status}`);
      return {
        providerId: id,
        providerName: id === "opencode-go" ? "OpenCode Go" : id,
        domainLabel: "test quota",
        capturedAt: Date.now(),
        windows: makeWindows(Date.now()),
      };
    },
  };
}

interface MonitorEnv {
  monitor: UsageMonitor;
  session: MonitorSession;
  statusCalls: Array<{ key: string; text: string | undefined }>;
  calls: string[];
  gate: { promise: Promise<GateResult>; resolve: (value: GateResult) => void };
  adapters: QuotaAdapter[];
  setKey(key: string): void;
}

function monitorEnv(options: {
  responses?: Array<GateResult>;
  gated?: boolean;
  configured?: string[];
  makeWindows?: (now: number) => QuotaWindow[];
} = {}): MonitorEnv {
  const responses = options.responses ?? [{ status: 200, data: {} }];
  const configured = new Set(options.configured ?? ["opencode-go", "openrouter"]);
  let apiKey = "key-1";
  const calls: string[] = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const gate = Promise.withResolvers<GateResult>();
  let index = 0;
  const getJson: GetJson = async (url) => {
    calls.push(url);
    if (options.gated) return gate.promise;
    const response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return response;
  };
  const adapters = [
    monitorAdapter("opencode-go", options.makeWindows ?? ((now) => [{ label: "rolling", usedPercent: 12.5, resetsAt: now + 3_600_000 }])),
    monitorAdapter("openrouter", options.makeWindows ?? ((now) => [{ label: "key", usedPercent: 40 }])),
  ];
  const session: MonitorSession = {
    gateway: {
      isConfigured: (id) => configured.has(id),
      resolveAuth: async () => ({ auth: { apiKey } }),
      providerInfo: () => undefined,
    },
    mode: "tui",
    setStatus: (key, text) => statusCalls.push({ key, text }),
  };
  const monitor = new UsageMonitor({ adapters, createRequester: () => getJson });
  return {
    monitor,
    session,
    statusCalls,
    calls,
    gate,
    adapters,
    setKey: (key) => (apiKey = key),
  };
}

/** Drain microtask chains without real timers (mock-timer safe). */
const drain = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

const lastStatus = (env: MonitorEnv) => env.statusCalls[env.statusCalls.length - 1];

test("monitor: session start refreshes only the active provider and sets the footer", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    assert.equal(env.calls.length, 1);
    assert.ok(env.calls[0]!.includes("opencode-go.example"));
    const footer = lastStatus(env);
    assert.equal(footer!.key, STATUS_KEY);
    assert.ok(/OpenCode Go 87\.5% left/.test(footer!.text!), footer!.text ?? "");
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: five-minute poll refreshes only the active provider", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    mock.timers.tick(POLL_INTERVAL_MS);
    await drain();
    mock.timers.tick(POLL_INTERVAL_MS);
    await drain();
    assert.equal(env.calls.filter((c) => c.includes("opencode-go")).length, 3, "initial + two polls");
    assert.equal(env.calls.filter((c) => c.includes("openrouter")).length, 0, "inactive provider never polled");
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: agent_settled skips fresh data and refreshes once it is 60s old", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 1, "fresh data is not re-fetched");
    mock.timers.tick(EVENT_MIN_AGE_MS + 1_000);
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 2);
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: a passed reset time forces a refresh despite fresh data", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ makeWindows: (now) => [{ label: "rolling", usedPercent: 10, resetsAt: now + 1_000 }] });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    mock.timers.tick(2_000); // reset time passes; data age only 2s
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 2, "passed reset needs fresh data, not assumed replenishment");
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: overlapping command/timer/event requests share one in-flight refresh", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ gated: true });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    const command = env.monitor.refreshProvider(env.adapters[0]!);
    const event = env.monitor.refreshProvider(env.adapters[0]!);
    await drain();
    assert.equal(env.calls.length, 1, "deduplicated");
    env.gate.resolve({ status: 200, data: {} });
    await Promise.all([command, event]);
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: failures back off exponentially and manual queries respect backoff", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ responses: [{ status: 500, data: {} }] });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    assert.equal(env.calls.length, 1);
    assert.match(lastStatus(env)!.text!, /request error · retry 30s/);

    env.monitor.onAgentSettled(); // inside 30s backoff
    await drain();
    assert.equal(env.calls.length, 1, "no request while backing off");

    const manual = await env.monitor.refreshProvider(env.adapters[0]!);
    assert.equal(env.calls.length, 1, "manual query also respects backoff");
    assert.equal(manual.error?.kind, "canceled");

    mock.timers.tick(POLL_INTERVAL_MS); // t=300s: backoff (30s) long expired
    await drain();
    assert.equal(env.calls.length, 2, "poll retries after backoff");
    assert.match(lastStatus(env)!.text!, /request error · retry 1m/, "second failure doubles backoff");
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: valid server Retry-After guidance is the backoff floor", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ responses: [{ status: 429, data: {}, retryAfterMs: 60_000 }] });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    mock.timers.tick(31_000); // past the default 30s exponential floor
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 1, "server-imposed 60s backoff is honored");
    mock.timers.tick(30_000); // t=61s: server guidance expired
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 2);
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: cache is partitioned by credential; account change never serves stale-account data", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    assert.ok(await env.monitor.serveCached("opencode-go"));

    env.setKey("key-2"); // account switch: same provider, different credentials
    assert.equal(await env.monitor.serveCached("opencode-go"), undefined, "other account's result is not served");

    mock.timers.tick(EVENT_MIN_AGE_MS + 1_000);
    env.monitor.onAgentSettled();
    await drain();
    assert.equal(env.calls.length, 2, "new account refreshes");
    assert.ok(await env.monitor.serveCached("opencode-go"));
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: obsolete results are discarded after shutdown", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ gated: true });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    env.monitor.shutdown();
    assert.deepEqual(lastStatus(env), { key: STATUS_KEY, text: undefined }, "status removed on shutdown");

    env.gate.resolve({ status: 200, data: {} }); // late completion after shutdown
    await drain();
    assert.equal(await env.monitor.serveCached("opencode-go"), undefined, "late result never enters the cache");
    const afterShutdown = env.statusCalls.length;
    mock.timers.tick(POLL_INTERVAL_MS * 3);
    await drain();
    assert.equal(env.calls.length, 1, "no further networking after shutdown");
    assert.equal(env.statusCalls.length, afterShutdown, "no status updates from disposed session");
  } finally {
    mock.timers.reset();
  }
});

test("monitor: failed refresh keeps old data visible but marked stale", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv({ responses: [{ status: 200, data: {} }, { status: 500, data: {} }] });
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    assert.match(lastStatus(env)!.text!, /87\.5% left/);

    mock.timers.tick(EVENT_MIN_AGE_MS + 1_000);
    env.monitor.onAgentSettled();
    await drain();
    const footer = lastStatus(env)!.text!;
    assert.match(footer, /87\.5% left/, "old data stays visible");
    assert.match(footer, /stale/, "but is explicitly marked stale");
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: model switch refreshes the new active provider only on provider change", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    env.monitor.setActiveProvider("openrouter");
    await drain();
    assert.equal(env.calls.filter((c) => c.includes("openrouter")).length, 1);
    env.monitor.setActiveProvider("openrouter"); // same provider: no request storm
    await drain();
    assert.equal(env.calls.filter((c) => c.includes("openrouter")).length, 1);
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: unsupported active provider clears the footer", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "zai"); // not among the env's adapters
    await drain();
    assert.deepEqual(lastStatus(env), { key: STATUS_KEY, text: undefined });
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: non-tui sessions do no networking and set no status", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const env = monitorEnv();
    env.session.mode = "rpc";
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    mock.timers.tick(POLL_INTERVAL_MS * 2);
    await drain();
    assert.equal(env.calls.length, 0);
    assert.equal(env.statusCalls.length, 0);
    env.monitor.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test("monitor: PI_OFFLINE suppresses quota networking", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  process.env.PI_OFFLINE = "1";
  try {
    const env = monitorEnv();
    env.monitor.startSession(env.session, "opencode-go");
    await drain();
    const manual = await env.monitor.refreshProvider(env.adapters[0]!);
    assert.equal(env.calls.length, 0);
    assert.equal(manual.error?.kind, "canceled");
    env.monitor.shutdown();
  } finally {
    delete process.env.PI_OFFLINE;
    mock.timers.reset();
  }
});
