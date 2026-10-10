/** Synthetic-only local preview: PI_OFFLINE=1 pnpm exec pi --no-extensions -e ./examples/session-preview.ts */
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectSessionUsage, sessionTokenTotals } from "../src/session-usage.ts";
import { UsageView, formatCacheReadPercent } from "../src/ui.ts";

export function syntheticSessionEntries(): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const [provider, model, input, output, cacheRead, cacheWrite] of [
    ["openai-codex", "gpt-5.4", 12_000, 8_000, 64_000, 0],
    ["openai-codex", "gpt-5.4-mini", 8_000, 4_000, 24_000, 0],
    ["anthropic", "claude-sonnet-4-6", 16_000, 10_000, 48_000, 18_000],
    ["anthropic", "claude-opus-4-6", 10_000, 6_000, 30_000, 12_000],
  ] as const) {
    entries.push({
      type: "message", id: String(entries.length), parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant", provider, model, api: "openai-responses", content: [],
        stopReason: "stop", timestamp: 0,
        usage: {
          input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
  }
  return entries;
}

export default function (pi: ExtensionAPI) {
  const usage = collectSessionUsage(syntheticSessionEntries());
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("usage-preview", formatCacheReadPercent(sessionTokenTotals(usage)) + " · 68% left (synthetic)");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("usage-preview", undefined);
  });
  pi.registerCommand("usage-demo", {
    description: "Preview session charts using synthetic tokens only (no quota requests)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const entries = [{ name: "Current session", sessionUsage: usage }];
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new UsageView({
        theme, getEntries: () => entries, onClose: () => done(undefined),
        requestRender: () => tui.requestRender(), getViewportRows: () => tui.terminal.rows,
      }));
    },
  });
}
