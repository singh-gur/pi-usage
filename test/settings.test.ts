import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USAGE_SETTINGS,
  loadUsageSettings,
  mergeUsageSettings,
  parseUsageSettings,
  saveUsageSettings,
  usageSettingsPaths,
} from "../src/settings.ts";

test("settings: defaults and project overrides merge without mutation", () => {
  const global = { footerFormat: "compact" as const, pollIntervalMinutes: 15 as const };
  const merged = mergeUsageSettings(global, { refreshAfterTurn: false });
  assert.deepEqual(merged, {
    footerFormat: "compact",
    pollIntervalMinutes: 15,
    refreshAfterTurn: false,
  });
  assert.deepEqual(DEFAULT_USAGE_SETTINGS, {
    footerFormat: "full",
    pollIntervalMinutes: 5,
    refreshAfterTurn: true,
  });
});

test("settings: parser keeps valid fields and warns about invalid or unknown fields", () => {
  const parsed = parseUsageSettings({
    footerFormat: "compact",
    pollIntervalMinutes: 2,
    refreshAfterTurn: "yes",
    futureSetting: true,
  }, "global");
  assert.deepEqual(parsed.settings, { footerFormat: "compact" });
  assert.equal(parsed.warnings.length, 3);
  assert.ok(parsed.warnings.some((warning) => warning.includes("pollIntervalMinutes")));
  assert.ok(parsed.warnings.some((warning) => warning.includes("refreshAfterTurn")));
  assert.ok(parsed.warnings.some((warning) => warning.includes("futureSetting")));

  const root = parseUsageSettings([], "project");
  assert.deepEqual(root.settings, {});
  assert.match(root.warnings[0]!, /expected a JSON object/);
});

test("settings: global and trusted project files load with project precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const paths = usageSettingsPaths(cwd, agentDir);
  try {
    await saveUsageSettings(paths.global, { footerFormat: "compact", pollIntervalMinutes: 15 });
    await saveUsageSettings(paths.project, { pollIntervalMinutes: 0, refreshAfterTurn: false });

    const trusted = await loadUsageSettings(cwd, true, agentDir);
    assert.deepEqual(trusted.settings, {
      footerFormat: "compact",
      pollIntervalMinutes: 0,
      refreshAfterTurn: false,
    });
    assert.deepEqual(trusted.warnings, []);

    const untrusted = await loadUsageSettings(cwd, false, agentDir);
    assert.deepEqual(untrusted.settings, {
      footerFormat: "compact",
      pollIntervalMinutes: 15,
      refreshAfterTurn: true,
    });
    assert.deepEqual(untrusted.project, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings: save creates readable JSON and malformed files fall back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const paths = usageSettingsPaths(cwd, agentDir);
  try {
    await saveUsageSettings(paths.global, { footerFormat: "off", refreshAfterTurn: false });
    assert.deepEqual(JSON.parse(await readFile(paths.global, "utf8")), {
      footerFormat: "off",
      refreshAfterTurn: false,
    });

    await writeFile(paths.global, "{not json", "utf8");
    const loaded = await loadUsageSettings(cwd, true, agentDir);
    assert.deepEqual(loaded.settings, DEFAULT_USAGE_SETTINGS);
    assert.deepEqual(loaded.warnings, ["Ignoring global pi-usage.json: invalid JSON"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
