import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import factory from "../src/index.ts";
import { UsageView, renderUsageLines, type UsageEntry } from "../src/ui.ts";
import type { ProviderUsage } from "../src/types.ts";

// ------------------------------------------------------------- test doubles

interface CustomHandle {
  component: { render(width: number): string[]; handleInput(data: string): void; invalidate(): void };
  done: (value: undefined) => void;
  doneCalled: () => boolean;
}

interface Harness {
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
}

function setupExtension(): Harness {
  const commands = new Map();
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
  };
  factory(pi as never);

  return { commands, fetchCalls };
}

const IDENTITY_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function makeCtx(options: {
  mode: string;
  configured?: Record<string, boolean>;
  authByKey?: Record<string, string | undefined>;
  oauthByKey?: Record<string, boolean>;
  fetchRoutes?: Record<string, () => Response | Promise<Response>>;
}) {
  const configured = options.configured ?? {};
  const authByKey = options.authByKey ?? {};
  const oauthByKey = options.oauthByKey ?? {};
  const routes = options.fetchRoutes ?? {};

  let customHandlesCurrent: CustomHandle[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const custom = (factoryFn: (tui: unknown, theme: unknown, kb: unknown, done: (v: undefined) => void) => unknown) =>
    new Promise<undefined>((resolve) => {
      let doneCalled = false;
      const done = () => {
        doneCalled = true;
        resolve(undefined);
      };
      const tui = { requestRender: () => {}, terminal: { rows: 40 } };
      const component = factoryFn(tui, IDENTITY_THEME, {}, done) as CustomHandle["component"];
      customHandlesCurrent.push({ component, done, doneCalled: () => doneCalled });
    });

  const ctx = {
    mode: options.mode,
    modelRegistry: {
      getProviderAuthStatus: (id: string) => ({ configured: configured[id] ?? false }),
      getProviderAuth: async (id: string) =>
        authByKey[id] ? { auth: { apiKey: authByKey[id] }, source: oauthByKey[id] ? "OAuth" : "stored" } : undefined,
      getProvider: () => ({}),
    },
    ui: { custom, notify: (message: string, level: string) => notifications.push({ message, level }) },
  };
  // Expose handles for assertions.
  (ctx as { handles?: CustomHandle[] }).handles = customHandlesCurrent;
  return { ctx, handles: customHandlesCurrent, notifications };
}

function installFetch(routes: Record<string, (url: string) => Response | Promise<Response>>, log: Array<{ url: string; headers: Record<string, string> }>) {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[new URL(url).host];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route(url);
  }) as typeof fetch;
}

const GO_BODY = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 12.5, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    weekly: { status: "ok", percent: 3, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    monthly: { status: "ok", percent: 1, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  },
});
const OR_BODY = JSON.stringify({ data: { limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage: 25.5 } });

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ------------------------------------------------------------------- tests

test("extension: registers the /usage command without LLM triggers", () => {
  const harness = setupExtension();
  assert.ok(harness.commands.has("usage"));
  assert.equal(harness.commands.size, 1);
  assert.equal(typeof harness.commands.get("usage")!.handler, "function");
});

test("extension: non-tui modes stay silent with no fetch and no custom UI", async () => {
  const harness = setupExtension();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}");
  }) as typeof fetch;
  for (const mode of ["print", "json", "rpc"]) {
    const { ctx, handles } = makeCtx({ mode, configured: { "opencode-go": true, openrouter: true }, authByKey: { "opencode-go": "k", openrouter: "k" } });
    await harness.commands.get("usage")!.handler("", ctx);
    assert.equal(handles.length, 0, `${mode} must not open custom UI`);
  }
  assert.equal(fetches, 0);
});

test("extension: independent provider completion; failure does not hide success", async () => {
  const harness = setupExtension();
  const routes: Record<string, () => Response | Promise<Response>> = {
    "opencode.ai": () => new Response(GO_BODY, { status: 200 }),
    "openrouter.ai": () => new Response(JSON.stringify({ error: { message: "invalid" } }), { status: 401 }),
  };
  installFetch(routes, harness.fetchCalls);
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true, openrouter: true },
    authByKey: { "opencode-go": "go-key", openrouter: "or-key" },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();

  assert.equal(handles.length, 1);
  let lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("[OpenCode Go]"), "go tab shown");
  assert.ok(lines.includes("Coding plan allowance"), "go provider body shown");
  assert.ok(/87\.5% left/.test(lines), "go remaining allowance rendered");
  assert.ok(!lines.includes("Credentials were rejected by OpenRouter"), "inactive provider body is hidden");
  handles[0]!.component.handleInput("\x1b[C"); // next tab
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("Key spending allowance"), "openrouter provider body shown");
  assert.ok(/auth: Credentials were rejected by OpenRouter/.test(lines), "openrouter error rendered");
  assert.ok(harness.fetchCalls.some((c) => c.url === "https://opencode.ai/zen/go/v1/usage" && c.headers.authorization === "Bearer go-key"));
  assert.ok(harness.fetchCalls.some((c) => c.url === "https://openrouter.ai/api/v1/key" && c.headers.authorization === "Bearer or-key"));

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: shows loading state before providers respond, then updates", async () => {
  const harness = setupExtension();
  let releaseGo: (() => void) | undefined;
  installFetch(
    {
      "opencode.ai": () => new Promise<Response>((resolve) => (releaseGo = () => resolve(new Response(GO_BODY)))),
      "openrouter.ai": () => new Response(OR_BODY, { status: 200 }),
    },
    harness.fetchCalls,
  );
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true, openrouter: true },
    authByKey: { "opencode-go": "k", openrouter: "k" },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();
  let lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("refreshing…"), "slow active provider still loading");
  handles[0]!.component.handleInput("\x1b[C"); // OpenRouter tab
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/\$25\.50 used/.test(lines), "fast provider already rendered in its tab");
  handles[0]!.component.handleInput("\x1b[D"); // OpenCode Go tab

  releaseGo?.();
  await settle();
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/87\.5% left/.test(lines), "slow provider rendered after release");
  assert.ok(!lines.includes("refreshing…"), "no stale loading state");

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: unconfigured providers are omitted from the view entirely", async () => {
  const harness = setupExtension();
  installFetch({ "opencode.ai": () => new Response(GO_BODY, { status: 200 }) }, harness.fetchCalls);
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true, openrouter: false },
    authByKey: { "opencode-go": "k" },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();
  const lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/87\.5% left/.test(lines), "configured provider still fetched");
  for (const absent of ["OpenRouter", "Kimi", "Codex", "Z.AI"]) {
    assert.ok(!lines.includes(absent), `${absent} must not appear`);
  }
  assert.equal(harness.fetchCalls.length, 1, "unconfigured providers trigger no request");

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: nothing configured notifies instead of opening an empty view", async () => {
  const harness = setupExtension();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}");
  }) as typeof fetch;
  const { ctx, handles, notifications } = makeCtx({ mode: "tui", configured: {} });
  await harness.commands.get("usage")!.handler("", ctx);
  assert.equal(handles.length, 0, "no view opened");
  assert.equal(fetches, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.message, "No supported providers are configured in Pi");
});

test("extension: PI_OFFLINE suppresses quota networking", async () => {
  const harness = setupExtension();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}");
  }) as typeof fetch;
  const had = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const { ctx, handles } = makeCtx({
      mode: "tui",
      configured: { "opencode-go": true, openrouter: true },
      authByKey: { "opencode-go": "k", openrouter: "k" },
    });
    const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
    await settle();
    const lines = handles[0]!.component.render(100).join("\n");
    assert.ok(lines.includes("PI_OFFLINE"), "suppression is visible");
    assert.equal(fetches, 0);
    handles[0]!.done(undefined);
    await handlerPromise;
  } finally {
    if (had === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = had;
  }
});

test("extension: escape closes the view and restores interaction", async () => {
  const harness = setupExtension();
  installFetch({ "opencode.ai": () => new Response(GO_BODY), "openrouter.ai": () => new Response(OR_BODY) }, harness.fetchCalls);
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true, openrouter: true },
    authByKey: { "opencode-go": "k", openrouter: "k" },
  });
  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();
  assert.equal(handles.length, 1);
  handles[0]!.component.handleInput("\x1b"); // escape
  await handlerPromise;
  assert.ok(true, "handler resolved after dismissal");
});

// -------------------------------------------------------------- view unit tests

function goUsage(): ProviderUsage {
  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    domainLabel: "Coding plan allowance",
    capturedAt: Date.now(),
    windows: [
      { label: "rolling", usedPercent: 12.5, resetsAt: Date.now() + 7_260_000, status: "ok" },
      { label: "weekly", usedPercent: 3, status: "rate-limited" },
    ],
  };
}

test("view: renders provider sections with bars, reset info, and text-paired status", () => {
  const entries: UsageEntry[] = [
    { name: "OpenCode Go", usage: goUsage() },
    { name: "OpenRouter" },
  ];
  const lines = renderUsageLines(entries, IDENTITY_THEME);
  const text = lines.join("\n");
  assert.ok(text.includes("OpenCode Go\n  Coding plan allowance — updated just now"));
  assert.ok(/█+░+  87\.5% left/.test(text));
  assert.ok(/Resets in 2h/.test(text));
  assert.ok(text.includes("[rate-limited]"));
  assert.ok(text.includes("refreshing…"));
});

test("view: derives same-unit bars and leaves unknown ratios text-only", () => {
  const usage: ProviderUsage = {
    providerId: "p",
    providerName: "P",
    domainLabel: "Allowance",
    capturedAt: Date.now(),
    windows: [
      { label: "credits", used: { value: 25, unit: "credits" }, remaining: { value: 75, unit: "credits" }, limit: { value: 100, unit: "credits" } },
      { label: "uncapped", used: { value: 2, unit: "USD" } },
    ],
  };
  const lines = renderUsageLines([{ name: "P", usage }], IDENTITY_THEME, 60);
  const text = lines.join("\n");
  assert.match(text, /█+░+  75 \/ 100 credits left/);
  const unknownStart = lines.indexOf("  uncapped");
  assert.equal(lines[unknownStart + 1], "  $2 used");
  assert.ok(!lines[unknownStart + 1]!.includes("█"), "unknown ratio has no bar");
});

test("view: tabs isolate providers, navigate, and keep the active tab visible", () => {
  const first = goUsage();
  first.domainLabel = "First allowance";
  const second = goUsage();
  second.domainLabel = "Second allowance";
  second.windows = second.windows.slice(0, 1); // shorter tab body
  let repaints = 0;
  const view = new UsageView({
    theme: IDENTITY_THEME,
    getEntries: () => [
      { name: "Provider one long", usage: first },
      { name: "Provider two long", usage: second },
    ],
    onClose: () => {},
    requestRender: () => repaints++,
    maxRows: 4,
  });

  const firstHeight = view.render(80).length;
  let text = view.render(80).join("\n");
  assert.ok(text.includes("[Provider one long]"));
  assert.ok(text.includes("Provider two long"));
  assert.ok(text.includes("First allowance"));
  assert.ok(!text.includes("Second allowance"));

  view.handleInput("\x1b[B"); // scroll the first provider
  view.handleInput("l"); // switching tabs resets the body scroll
  text = view.render(24).join("\n");
  assert.ok(text.includes("[Provider two long]"), "narrow fallback keeps the active tab visible");
  assert.ok(text.includes("Second allowance"));
  assert.ok(!text.includes("First allowance"));
  assert.equal(view.render(80).length, firstHeight, "shorter provider keeps the tallest tab height");

  view.handleInput("h");
  assert.ok(view.render(80).join("\n").includes("First allowance"));
  view.handleInput("\x1b[Z"); // shift-tab wraps backward
  assert.ok(view.render(80).join("\n").includes("Second allowance"));
  view.handleInput("\t"); // tab wraps forward
  assert.ok(view.render(80).join("\n").includes("First allowance"));
  assert.equal(repaints, 5);
});

test("view: scroll clamps at both ends and follows input", () => {
  const manyWindows = goUsage();
  manyWindows.windows = Array.from({ length: 6 }, (_, i) => ({
    label: `w${i}`,
    usedPercent: i,
    status: "ok",
  }));
  const entries: UsageEntry[] = [{ name: "P", usage: manyWindows }];
  let closed = false;
  const view = new UsageView({
    theme: IDENTITY_THEME,
    getEntries: () => entries,
    onClose: () => (closed = true),
    requestRender: () => {},
    maxRows: 3,
  });
  const full = renderUsageLines(entries, IDENTITY_THEME).length;
  assert.ok(full > 3, "content must exceed the viewport for scrolling");
  const first = view.render(80);
  assert.equal(first.length, 4, "3 content rows + hint line");
  assert.equal(first[0], "[P]", "starts at the provider tab");
  view.handleInput("\x1b[B"); // down
  const scrolled = view.render(80);
  assert.equal(scrolled.length, 4);
  assert.ok(scrolled[1]!.trimStart().startsWith("w"), "view scrolled into window lines while tabs stay fixed");
  view.handleInput("\x1b[H"); // home
  assert.ok(view.render(80)[1]!.includes("Coding plan allowance"), "home returns the body to the top");
  view.handleInput("\x1b[A"); // up at top stays
  assert.ok(view.render(80)[1]!.includes("Coding plan allowance"), "top clamp holds");
  view.handleInput("q");
  assert.ok(closed);
});

test("view: every rendered line respects the width bound", () => {
  const entries: UsageEntry[] = [
    { name: "OpenCode Go", usage: goUsage() },
    { name: "OpenRouter", usage: goUsage() },
  ];
  const view = new UsageView({ theme: IDENTITY_THEME, getEntries: () => entries, onClose: () => {}, requestRender: () => {}, maxRows: 12 });
  for (const width of [20, 40, 80]) {
    for (const line of view.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width} exceeded: ${line}`);
    }
  }
});

// ------------------------------------------------------- phase 2 providers

const CODEX_JWT = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }),
).toString("base64url")}.sig`;

const SIX_PROVIDER_BODIES = {
  "opencode.ai": () => new Response(GO_BODY, { status: 200 }),
  "openrouter.ai": () => new Response(OR_BODY, { status: 200 }),
  "chatgpt.com": () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 },
          secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 3_600 },
        },
      }),
      { status: 200 },
    ),
  "api.kimi.com": () =>
    new Response(
      JSON.stringify({
        usage: { limit: 100, used: 30, remaining: 70 },
        limits: [{ detail: { limit: 50, used: 10, remaining: 40 }, window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" } }],
      }),
      { status: 200 },
    ),
  "api.z.ai": () =>
    new Response(
      JSON.stringify({
        code: 200,
        success: true,
        data: {
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 500, percentage: 25, nextResetTime: Date.now() + 7_260_000 },
          ],
        },
      }),
      { status: 200 },
    ),
  "cli-chat-proxy.grok.com": (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = path.startsWith("/v1/user")
      ? { userId: "grok-user-1" }
      : path.startsWith("/v1/billing") && path.includes("format=credits")
        ? {
            config: {
              creditUsagePercent: 33.5,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: new Date(Date.now() + 86_400_000).toISOString() },
            },
          }
        : { config: null };
    return new Response(JSON.stringify(body), { status: 200 });
  },
};

const ALL_CONFIGURED = {
  "opencode-go": true,
  openrouter: true,
  "openai-codex": true,
  "kimi-coding": true,
  zai: true,
  xai: true,
};

test("extension: six providers render independently without conflation", async () => {
  const harness = setupExtension();
  installFetch(SIX_PROVIDER_BODIES, harness.fetchCalls);
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: ALL_CONFIGURED,
    authByKey: {
      "opencode-go": "k",
      openrouter: "k",
      "openai-codex": CODEX_JWT,
      "kimi-coding": "k",
      zai: "k",
      xai: "grok-oauth-token",
    },
    oauthByKey: { "openai-codex": true, xai: true },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();

  let lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("[OpenCode Go]"));
  assert.ok(lines.includes("Coding plan allowance"));
  assert.ok(/87\.5% left/.test(lines));

  handles[0]!.component.handleInput("\x1b[C"); // OpenRouter
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/\$25\.50 used/.test(lines));

  handles[0]!.component.handleInput("\x1b[C"); // Codex
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/primary \(shared\) · 5h/.test(lines) && /58% left/.test(lines));

  handles[0]!.component.handleInput("\x1b[C"); // Kimi
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/5h window/.test(lines));

  handles[0]!.component.handleInput("\x1b[C"); // Z.AI
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/5-hour/.test(lines) && /75% left/.test(lines));

  handles[0]!.component.handleInput("\x1b[C"); // Grok
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("[Grok]"));
  assert.ok(lines.includes("Grok coding credits"));
  assert.ok(/current period \(weekly\)/.test(lines) && /66.5% left/.test(lines));

  // Grok: identity ran before billing and carried the verified user id.
  const grokCalls = harness.fetchCalls.filter((c) => c.url.includes("cli-chat-proxy.grok.com"));
  assert.ok(grokCalls.length >= 2);
  assert.ok(grokCalls[0]!.url.endsWith("/v1/user"));
  assert.ok(grokCalls[1]!.url.includes("format=credits"));
  assert.equal(grokCalls[1]!.headers["x-userid"], "grok-user-1");
  assert.equal(grokCalls[0]!.headers.authorization, "Bearer grok-oauth-token");

  // Codex request used the runtime-derived account header.
  const codexCall = harness.fetchCalls.find((c) => c.url.includes("chatgpt.com"));
  assert.ok(codexCall);
  assert.equal(codexCall!.headers["chatgpt-account-id"], "acct-9");
  const zaiCall = harness.fetchCalls.find((c) => c.url.includes("api.z.ai"));
  assert.equal(zaiCall!.headers.authorization, "k", "zai uses the raw key");

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: codex without OAuth provenance shows an error, others unaffected", async () => {
  const harness = setupExtension();
  installFetch(
    {
      "opencode.ai": () => new Response(GO_BODY, { status: 200 }),
      "chatgpt.com": () => new Response("{}", { status: 200 }),
    },
    harness.fetchCalls,
  );
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true, "openai-codex": true },
    authByKey: { "opencode-go": "k", "openai-codex": "sk-not-oauth" },
    oauthByKey: { "openai-codex": false },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();
  let lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/87\.5% left/.test(lines), "other providers unaffected");
  handles[0]!.component.handleInput("\x1b[C"); // Codex tab
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/auth: Codex quota requires subscription OAuth credentials/.test(lines));
  assert.ok(!harness.fetchCalls.some((c) => c.url.includes("chatgpt.com")), "no codex request issued");

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: partial-data notice renders for malformed optional windows", async () => {
  const harness = setupExtension();
  installFetch(
    {
      "opencode.ai": () =>
        new Response(
          JSON.stringify({
            usage: {
              rolling: { status: "ok", percent: 12.5, resetsAt: new Date(Date.now() + 7_260_000).toISOString() },
              weekly: { status: "ok", percent: "bogus" },
              monthly: { status: "ok", percent: 1 },
            },
          }),
          { status: 200 },
        ),
    },
    harness.fetchCalls,
  );
  const { ctx, handles } = makeCtx({
    mode: "tui",
    configured: { "opencode-go": true },
    authByKey: { "opencode-go": "k" },
  });

  const handlerPromise = harness.commands.get("usage")!.handler("", ctx);
  await settle();
  const lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/87\.5% left/.test(lines), "valid window still visible");
  assert.ok(/partial data: 1 usage window/.test(lines), "partial notice rendered");

  handles[0]!.done(undefined);
  await handlerPromise;
});

// ------------------------------------------------- scroll repaint regression

test("view: scrolling input requests a TUI repaint", () => {
  let repaints = 0;
  const entries: UsageEntry[] = [{ name: "P", usage: goUsage() }];
  const view = new UsageView({
    theme: IDENTITY_THEME,
    getEntries: () => entries,
    onClose: () => {},
    requestRender: () => repaints++,
    maxRows: 2,
  });
  view.handleInput("\x1b[B"); // down
  assert.equal(repaints, 1, "scroll key must trigger a repaint");
  view.handleInput("\x1b[A"); // up
  assert.equal(repaints, 2);
  view.handleInput("z"); // unhandled key: no repaint
  assert.equal(repaints, 2);
  view.handleInput("\x1b"); // escape closes without extra repaint
  assert.equal(repaints, 2);
});

test("view: viewport height follows the terminal, not a fixed row count", () => {
  const manyWindows = goUsage();
  manyWindows.windows = Array.from({ length: 30 }, (_, i) => ({ label: `w${i}`, usedPercent: i, status: "ok" }));
  const entries: UsageEntry[] = [{ name: "P", usage: manyWindows }];
  const total = renderUsageLines(entries, IDENTITY_THEME).length;

  const small = new UsageView({ theme: IDENTITY_THEME, getEntries: () => entries, onClose: () => {}, requestRender: () => {}, getViewportRows: () => 12 });
  assert.equal(small.render(80).length, 9, "12 terminal rows reserve 4 for chrome plus 1 hint");

  const large = new UsageView({ theme: IDENTITY_THEME, getEntries: () => entries, onClose: () => {}, requestRender: () => {}, getViewportRows: () => 60 });
  assert.equal(large.render(80).length, Math.min(total, 56) + 1, "large terminals show all content");

  // Scrolling through the small viewport reaches the last line.
  small.handleInput("\x1b[F"); // end
  const last = small.render(80).join("\n");
  assert.ok(last.includes("w29"), "end key reaches the final window");
});
