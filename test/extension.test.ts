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
  fetchRoutes?: Record<string, () => Response | Promise<Response>>;
}) {
  const configured = options.configured ?? {};
  const authByKey = options.authByKey ?? {};
  const routes = options.fetchRoutes ?? {};

  let customHandlesCurrent: CustomHandle[] = [];
  const custom = (factoryFn: (tui: unknown, theme: unknown, kb: unknown, done: (v: undefined) => void) => unknown) =>
    new Promise<undefined>((resolve) => {
      let doneCalled = false;
      const done = () => {
        doneCalled = true;
        resolve(undefined);
      };
      const tui = { requestRender: () => {} };
      const component = factoryFn(tui, IDENTITY_THEME, {}, done) as CustomHandle["component"];
      customHandlesCurrent.push({ component, done, doneCalled: () => doneCalled });
    });

  const ctx = {
    mode: options.mode,
    modelRegistry: {
      getProviderAuthStatus: (id: string) => ({ configured: configured[id] ?? false }),
      getProviderAuth: async (id: string) =>
        authByKey[id] ? { auth: { apiKey: authByKey[id] }, source: "stored" } : undefined,
      getProvider: () => ({}),
    },
    ui: { custom },
  };
  // Expose handles for assertions.
  (ctx as { handles?: CustomHandle[] }).handles = customHandlesCurrent;
  return { ctx, handles: customHandlesCurrent };
}

function installFetch(routes: Record<string, () => Response | Promise<Response>>, log: Array<{ url: string; headers: Record<string, string> }>) {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[new URL(url).host];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route();
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
  const lines = handles[0]!.component.render(100).join("\n");
  assert.ok(lines.includes("OpenCode Go — Coding plan allowance"), "go provider header shown");
  assert.ok(/12\.5% used/.test(lines), "go usage rendered");
  assert.ok(lines.includes("OpenRouter — Key spending allowance"), "openrouter header shown");
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
  assert.ok(lines.includes("refreshing…"), "slow provider still loading");
  assert.ok(/\$25\.50 used/.test(lines), "fast provider already rendered");

  releaseGo?.();
  await settle();
  lines = handles[0]!.component.render(100).join("\n");
  assert.ok(/12\.5% used/.test(lines), "slow provider rendered after release");
  assert.ok(!lines.includes("refreshing…"), "no stale loading state");

  handles[0]!.done(undefined);
  await handlerPromise;
});

test("extension: unconfigured provider shows explicit state, others still queried", async () => {
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
  assert.ok(/not configured/.test(lines), "explicit not-configured state");
  assert.ok(/12\.5% used/.test(lines), "configured provider still fetched");
  assert.equal(harness.fetchCalls.length, 1, "unconfigured provider triggers no request");

  handles[0]!.done(undefined);
  await handlerPromise;
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

test("view: renders provider sections with windows, reset info, and color-paired labels", () => {
  const entries: UsageEntry[] = [
    { name: "OpenCode Go", usage: goUsage() },
    { name: "OpenRouter" },
  ];
  const lines = renderUsageLines(entries, IDENTITY_THEME);
  const text = lines.join("\n");
  assert.ok(text.includes("OpenCode Go — Coding plan allowance"));
  assert.ok(/12\.5% used/.test(text));
  assert.ok(/resets in 2h/.test(text));
  assert.ok(text.includes("[rate-limited]"));
  assert.ok(text.includes("refreshing…"));
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
    maxRows: 3,
  });
  const full = renderUsageLines(entries, IDENTITY_THEME).length + 2; // + blank + hint
  assert.ok(full > 3, "content must exceed the viewport for scrolling");
  const first = view.render(80);
  assert.equal(first.length, 3);
  assert.ok(first[0]!.startsWith("P —"), "starts at the provider header");
  view.handleInput("\x1b[B"); // down
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B"); // beyond end
  const scrolled = view.render(80);
  assert.equal(scrolled.length, 3);
  assert.ok(scrolled[0]!.trimStart().startsWith("w"), "view scrolled into window lines");
  view.handleInput("\x1b[H"); // home
  assert.ok(view.render(80)[0]!.startsWith("P —"), "home returns to the top");
  view.handleInput("\x1b[A"); // up at top stays
  assert.ok(view.render(80)[0]!.startsWith("P —"), "top clamp holds");
  view.handleInput("q");
  assert.ok(closed);
});

test("view: every rendered line respects the width bound", () => {
  const entries: UsageEntry[] = [
    { name: "OpenCode Go", usage: goUsage() },
    { name: "OpenRouter", usage: goUsage() },
  ];
  const view = new UsageView({ theme: IDENTITY_THEME, getEntries: () => entries, onClose: () => {}, maxRows: 12 });
  for (const width of [20, 40, 80]) {
    for (const line of view.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width} exceeded: ${line}`);
    }
  }
});
