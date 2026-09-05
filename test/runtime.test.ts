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
