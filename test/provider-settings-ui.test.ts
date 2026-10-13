import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToggle, describeProvider, providersSummary, toggleValue, type ProviderPanelContext } from "../src/provider-settings-ui.ts";
import type { UsageSettingsFile } from "../src/settings.ts";

test("provider toggles: values read from the stored fields, with inherit only at project scope", () => {
  assert.equal(toggleValue(undefined, "show", false), "on");
  assert.equal(toggleValue(undefined, "poll", true), "inherit");
  assert.equal(toggleValue({ disabled: true }, "show", false), "off", "show is the inverse of disabled");
  assert.equal(toggleValue({ disabled: false }, "show", true), "on");
  assert.equal(toggleValue({ poll: false }, "poll", false), "off");
  assert.equal(toggleValue({ refreshAfterTurn: true }, "turn", true), "on");
});

test("provider toggles: global on removes the key, project on writes an explicit override, empties are pruned", () => {
  const global: UsageSettingsFile = {};
  applyToggle(global, "codex", "poll", "off", false);
  applyToggle(global, "codex", "show", "off", false);
  assert.deepEqual(global.providers, { codex: { poll: false, disabled: true } });
  applyToggle(global, "codex", "poll", "on", false);
  assert.deepEqual(global.providers, { codex: { disabled: true } });
  applyToggle(global, "codex", "show", "on", false);
  assert.equal(global.providers, undefined, "an all-default provider leaves no trace in the file");

  const project: UsageSettingsFile = {};
  applyToggle(project, "grok", "show", "on", true);
  assert.deepEqual(project.providers, { grok: { disabled: false } }, "project can re-enable what global disabled");
  applyToggle(project, "grok", "show", "inherit", true);
  assert.equal(project.providers, undefined);
});

test("provider description says what refreshes", () => {
  assert.equal(describeProvider(undefined), "on · timed + after-turn refresh");
  assert.equal(describeProvider({ poll: false }), "on · after-turn refresh only");
  assert.equal(describeProvider({ refreshAfterTurn: false }), "on · timed refresh only");
  assert.equal(describeProvider({ poll: false, refreshAfterTurn: false }), "on · manual refresh only");
  assert.equal(describeProvider({ disabled: true, poll: false }), "hidden · no requests");
});

test("providers summary counts customized providers using the effective (merged) state", () => {
  const ctx = (project: boolean, file: UsageSettingsFile, globalProviders: UsageSettingsFile["providers"]): ProviderPanelContext => ({
    providers: [{ id: "a", name: "A", configured: true }, { id: "b", name: "B", configured: false }, { id: "c", name: "C", configured: true }],
    project, file, globalProviders,
    flags: () => ({ pollLabel: "5 min", pollOff: false, turnOff: false }),
    theme: { fg: (_c, t) => t, bold: (t) => t },
    onChange: () => {},
  });
  assert.equal(providersSummary(ctx(false, {}, undefined)), "all default");
  assert.equal(providersSummary(ctx(false, { providers: { a: { disabled: true }, b: { poll: false } } }, undefined)), "2 customized");
  assert.equal(providersSummary(ctx(true, {}, { a: { disabled: true } })), "1 customized", "project scope includes inherited global changes");
  assert.equal(providersSummary(ctx(true, { providers: { a: { disabled: false } } }, { a: { disabled: true } })), "all default", "a project override can undo a global one");
});
