import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { syntheticSessionEntries } from "../examples/session-preview.ts";
import { collectSessionUsage, emptyTokens, totalTokens, sessionTokenTotals, segmentWidths } from "../src/session-usage.ts";
import { formatSessionTokenBar, formatCacheReadPercent, renderUsageLines, UsageView } from "../src/ui.ts";

initTheme("dark");
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("session: aggregates by recorded provider/model without counting reasoning twice", () => {
  const entries = syntheticSessionEntries();
  const first = entries[0]!;
  if (first.type === "message" && first.message.role === "assistant") first.message.usage.reasoning = 2000;
  const groups = collectSessionUsage(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.models.size, 2);
  assert.deepEqual(groups[0]!.tokens, { input: 20_000, output: 12_000, cacheRead: 88_000, cacheWrite: 0 });
  assert.deepEqual(sessionTokenTotals(groups), { input: 46_000, output: 28_000, cacheRead: 166_000, cacheWrite: 30_000 });
  assert.equal(totalTokens(sessionTokenTotals(groups)), 270_000);
  assert.ok(groups.every((group) => !group.incomplete));
  assert.deepEqual(collectSessionUsage(entries), collectSessionUsage(entries), "rebuilds are idempotent");
  assert.equal(collectSessionUsage(entries.slice(0, 1))[0]!.models.size, 1, "only supplied branch entries count");
});

test("session: includes Pi v1 attributed usage entries, including unknown operation kinds", () => {
  const entries = syntheticSessionEntries();
  const usage = { input: 0, output: 0, cacheRead: 1000, cacheWrite: 100,
    totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  entries.push(
    { type: "usage", id: "warm", parentId: "3", timestamp: "", kind: "cache_warm",
      provider: "anthropic", model: "claude-sonnet-4-6", usage },
    { type: "usage", id: "future", parentId: "warm", timestamp: "", kind: "future-operation",
      provider: "other-provider", model: "other-model", usage },
  );
  const groups = collectSessionUsage(entries);
  assert.equal(groups.length, 3);
  assert.equal(groups[1]!.models.get("claude-sonnet-4-6")!.cacheRead, 49_000);
  assert.equal(groups[1]!.tokens.cacheWrite, 30_100);
  assert.equal(groups[2]!.providerId, "other-provider");
  assert.deepEqual(groups[2]!.models.get("other-model"), { input: 0, output: 0, cacheRead: 1000, cacheWrite: 100 });
  assert.equal(totalTokens(sessionTokenTotals(groups)), 272_200);
  assert.ok(groups.every((group) => !group.incomplete));
});

test("session: keeps tool/summary usage separate rather than guessing provider attribution", () => {
  const entries = syntheticSessionEntries();
  const first = entries[0]!;
  assert.ok(first.type === "message" && first.message.role === "assistant");
  const usage = first.message.usage;
  const extra: SessionEntry[] = [
    { type: "message", id: "tool", parentId: "0", timestamp: "", message: {
      role: "toolResult", toolCallId: "t", toolName: "nested-model", content: [], isError: false, timestamp: 0, usage,
    } },
    { type: "compaction", id: "compact", parentId: "tool", timestamp: "", summary: "", firstKeptEntryId: "0", tokensBefore: 0, usage },
    { type: "branch_summary", id: "branch", parentId: "compact", timestamp: "", fromId: "0", summary: "", usage },
    { type: "message", id: "ordinary-tool", parentId: "branch", timestamp: "", message: {
      role: "toolResult", toolCallId: "t2", toolName: "read", content: [], isError: false, timestamp: 0,
    } },
  ];
  const groups = collectSessionUsage([...entries, ...extra]);
  assert.equal(groups.length, 3);
  assert.equal(groups[2]!.providerId, undefined);
  assert.equal(groups[2]!.models.size, 1);
  assert.equal(totalTokens(groups[2]!.tokens), totalTokens(groups[0]!.models.get("gpt-5.4")!) * 3);
});

test("session: zero is valid; missing, negative and nonfinite counts are marked partial", () => {
  const entries = syntheticSessionEntries().slice(0, 1);
  const entry = entries[0]!;
  assert.ok(entry.type === "message" && entry.message.role === "assistant");
  Object.assign(entry.message.usage, { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: 0 });
  const groups = collectSessionUsage(entries);
  assert.deepEqual(groups[0]!.tokens, emptyTokens());
  assert.equal(groups[0]!.incomplete, true);
  delete (entry.message as { usage?: unknown }).usage;
  assert.equal(collectSessionUsage(entries)[0]!.incomplete, true);
  assert.deepEqual(collectSessionUsage([]), []);
});

test("bar: allocates exactly 20 horizontal cells proportionally, with colors only", () => {
  const tokens = { input: 50, output: 25, cacheRead: 15, cacheWrite: 10 };
  const calls: Array<{ color: string; text: string }> = [];
  const bar = formatSessionTokenBar(tokens, { ...plainTheme, fg: (color, text) => {
    calls.push({ color, text }); return text;
  } });
  assert.equal(bar, "█".repeat(20));
  assert.equal(visibleWidth(bar), 20);
  assert.equal(bar!.includes("\n"), false);
  assert.deepEqual(calls.map(({ text }) => text.length), [10, 5, 3, 2]);
  assert.equal(new Set(calls.map(({ color }) => color)).size, 4);
  assert.equal(formatSessionTokenBar(emptyTokens(), plainTheme), "░".repeat(20));
  assert.deepEqual(segmentWidths([1, 1, 1, 0], 20), [7, 7, 6, 0]);
  assert.deepEqual(segmentWidths([0, 0], 20), [0, 0]);
  assert.deepEqual(segmentWidths([9999, 1, 0, 0], 20), [20, 0, 0, 0]);
});

test("footer: shows only cache-read percentage, with an unknown ratio for empty sessions", () => {
  assert.equal(formatCacheReadPercent(emptyTokens()), "cache read —");
  assert.equal(formatCacheReadPercent({ input: 50, output: 25, cacheRead: 15, cacheWrite: 10 }), "cache read 15%");
  assert.equal(formatCacheReadPercent({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }), "cache read 0%");
  assert.equal(formatCacheReadPercent({ input: 0, output: 0, cacheRead: 100, cacheWrite: 0 }), "cache read 100%");
  assert.equal(formatCacheReadPercent(sessionTokenTotals(collectSessionUsage(syntheticSessionEntries()))), "cache read 61.5%");
});

test("charts: show compact horizontal bars with exact session, provider and model shares", () => {
  const usage = collectSessionUsage(syntheticSessionEntries());
  const text = renderUsageLines([{ name: "Current session", sessionUsage: usage }], plainTheme, 90).join("\n");
  assert.match(text, /Session tokens \(active branch\): 270,000/);
  assert.match(text, /By token category/);
  assert.match(text, /Cache read: 166,000 \(61\.5%\)/);
  assert.match(text, /Cache write: 30,000 \(11\.1%\)/);
  assert.match(text, /By provider/);
  assert.match(text, /openai-codex: 120,000 \(44\.4%\)/);
  assert.match(text, /openai-codex \/ gpt-5\.4: 84,000 \(31\.1%\)/);
  assert.match(text, /gpt-5\.4-mini: 36,000 \(13\.3%\)/);
  assert.match(text, /█+░+/);
  assert.doesNotMatch(text, /refreshing/);
});

test("charts: fit narrow widths and terminal resize, scroll, and isolate the session tab", () => {
  const entries = [
    { name: "Quota provider" },
    { name: "Current session", sessionUsage: collectSessionUsage(syntheticSessionEntries()) },
  ];
  let rows = 40;
  const view = new UsageView({ theme: plainTheme, getEntries: () => entries,
    onClose: () => {}, requestRender: () => {}, getViewportRows: () => rows });
  assert.doesNotMatch(view.render(90).join("\n"), /gpt-5\.4|claude-sonnet/);
  view.handleInput("l");
  assert.match(view.render(90).join("\n"), /gpt-5\.4/);
  assert.match(view.render(90).join("\n"), /claude-sonnet/);
  for (const width of [1, 12, 24, 47, 48, 80]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  rows = 14;
  assert.ok(view.render(24).length <= rows - 3);
  view.handleInput("\x1b[F");
  assert.match(view.render(90).join("\n"), /esc close/);
});

test("charts: sanitize stored model labels and render empty/partial/unattributed states", () => {
  const usage = collectSessionUsage(syntheticSessionEntries())[0]!;
  usage.models = new Map([["evil\x1b\n\tmodel", emptyTokens()]]);
  usage.tokens = emptyTokens();
  usage.incomplete = true;
  usage.providerId = undefined;
  const text = renderUsageLines([{ name: "Current session", sessionUsage: [usage] }], plainTheme, 90).join("\n");
  assert.match(text, /Partial usage/);
  assert.match(text, /provider and model not recorded/);
  assert.match(text, /No recorded session tokens/);
  assert.match(text, /evilmodel/);
  assert.doesNotMatch(text, /\x1b|\t/);
});

test("bar: ANSI styling retains the same compact width", () => {
  const colors = ["accent", "success", "warning", "mdLink"];
  const theme = { ...plainTheme, fg: (color: string, text: string) => `\x1b[${31 + colors.indexOf(color)}m${text}\x1b[39m` };
  const text = formatSessionTokenBar({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, theme)!;
  assert.equal(visibleWidth(text), 20);
  assert.match(text, /\x1b\[/);
});
