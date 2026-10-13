import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type FooterFormat = "full" | "compact" | "off";
export type PollIntervalMinutes = 0 | 1 | 5 | 15 | 30;

/** Per-provider reporting switches (provider id keys). */
export interface ProviderUsageSettings {
  /** Exclude this provider from the timed poll (false disables). */
  poll?: boolean;
  /** Exclude this provider from the after-turn (agent_settled) refresh. */
  refreshAfterTurn?: boolean;
  /** Fully disabled: no requests ever; hidden from the footer and /usage. */
  disabled?: boolean;
}

export type ProviderUsageSettingsMap = { [providerId: string]: ProviderUsageSettings };

export interface UsageSettings {
  footerFormat: FooterFormat;
  pollIntervalMinutes: PollIntervalMinutes;
  refreshAfterTurn: boolean;
  /** Retained setting name; now controls the cache-read percentage in the footer. */
  showSessionBar: boolean;
  /** Notify below this remaining 5-hour percentage; zero disables notices. */
  resetThresholdPercent: number;
  providers?: ProviderUsageSettingsMap;
}

export type UsageSettingsFile = Partial<UsageSettings>;

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = {
  footerFormat: "full",
  pollIntervalMinutes: 5,
  refreshAfterTurn: true,
  showSessionBar: true,
  resetThresholdPercent: 10,
};

export const SETTINGS_FILENAME = "pi-usage.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
const FOOTER_FORMATS = new Set<FooterFormat>(["full", "compact", "off"]);
const POLL_INTERVALS = new Set<PollIntervalMinutes>([0, 1, 5, 15, 30]);
const PROVIDER_SETTINGS_KEYS = new Set<keyof ProviderUsageSettings>(["poll", "refreshAfterTurn", "disabled"]);
const KNOWN_KEYS = new Set<keyof UsageSettings>(["footerFormat", "pollIntervalMinutes", "refreshAfterTurn", "showSessionBar", "resetThresholdPercent", "providers"]);

export interface UsageSettingsPaths {
  global: string;
  project: string;
}

export interface LoadedUsageSettings {
  settings: UsageSettings;
  global: UsageSettingsFile;
  project: UsageSettingsFile;
  paths: UsageSettingsPaths;
  warnings: string[];
}

export function usageSettingsPaths(cwd: string, agentDir = getAgentDir()): UsageSettingsPaths {
  return {
    global: join(agentDir, SETTINGS_FILENAME),
    project: join(cwd, CONFIG_DIR_NAME, SETTINGS_FILENAME),
  };
}

export function mergeUsageSettings(global: UsageSettingsFile, project: UsageSettingsFile = {}): UsageSettings {
  return {
    ...DEFAULT_USAGE_SETTINGS,
    ...global,
    ...project,
    // Per-provider entries merge field-by-field so a project override can
    // flip one switch without erasing the rest of the global entry.
    providers: mergedProviderSettings(global.providers, project.providers),
  };
}

function mergedProviderSettings(
  global: ProviderUsageSettingsMap | undefined,
  project: ProviderUsageSettingsMap | undefined,
): ProviderUsageSettingsMap {
  const merged: ProviderUsageSettingsMap = {};
  for (const providerId of new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})])) {
    merged[providerId] = { ...global?.[providerId], ...project?.[providerId] };
  }
  return merged;
}

export function parseUsageSettings(value: unknown, scope: "global" | "project"): {
  settings: UsageSettingsFile;
  warnings: string[];
} {
  const warnings: string[] = [];
  const settings: UsageSettingsFile = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { settings, warnings: [`Ignoring ${scope} ${SETTINGS_FILENAME}: expected a JSON object`] };
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key as keyof UsageSettings)) warnings.push(`Ignoring unknown ${scope} setting "${key}"`);
  }

  if (input.footerFormat !== undefined) {
    if (FOOTER_FORMATS.has(input.footerFormat as FooterFormat)) settings.footerFormat = input.footerFormat as FooterFormat;
    else warnings.push(`Ignoring invalid ${scope} setting "footerFormat"`);
  }
  if (input.pollIntervalMinutes !== undefined) {
    if (POLL_INTERVALS.has(input.pollIntervalMinutes as PollIntervalMinutes)) {
      settings.pollIntervalMinutes = input.pollIntervalMinutes as PollIntervalMinutes;
    } else {
      warnings.push(`Ignoring invalid ${scope} setting "pollIntervalMinutes"`);
    }
  }
  if (input.providers !== undefined) {
    const rawProviders = input.providers;
    if (typeof rawProviders === "object" && rawProviders !== null && !Array.isArray(rawProviders)) {
      const providers: ProviderUsageSettingsMap = {};
      for (const [providerId, rawEntry] of Object.entries(rawProviders as Record<string, unknown>)) {
        if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
          warnings.push(`Ignoring invalid ${scope} provider settings for "${providerId}"`);
          continue;
        }
        const entry: ProviderUsageSettings = {};
        const raw = rawEntry as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
          if (!PROVIDER_SETTINGS_KEYS.has(key as keyof ProviderUsageSettings)) {
            warnings.push(`Ignoring unknown ${scope} provider setting "${key}" for "${providerId}"`);
            continue;
          }
          if (typeof raw[key] !== "boolean") {
            warnings.push(`Ignoring invalid ${scope} provider setting "${key}" for "${providerId}"`);
            continue;
          }
          entry[key as keyof ProviderUsageSettings] = raw[key] as boolean;
        }
        if (Object.keys(entry).length > 0) providers[providerId] = entry;
      }
      if (Object.keys(providers).length > 0) settings.providers = providers;
    } else {
      warnings.push(`Ignoring invalid ${scope} setting "providers"`);
    }
  }
  if (input.refreshAfterTurn !== undefined) {
    if (typeof input.refreshAfterTurn === "boolean") settings.refreshAfterTurn = input.refreshAfterTurn;
    else warnings.push(`Ignoring invalid ${scope} setting "refreshAfterTurn"`);
  }
  if (input.showSessionBar !== undefined) {
    if (typeof input.showSessionBar === "boolean") settings.showSessionBar = input.showSessionBar;
    else warnings.push(`Ignoring invalid ${scope} setting "showSessionBar"`);
  }
  if (input.resetThresholdPercent !== undefined) {
    const value = input.resetThresholdPercent;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) settings.resetThresholdPercent = value;
    else warnings.push(`Ignoring invalid ${scope} setting "resetThresholdPercent"`);
  }
  return { settings, warnings };
}

async function readSettingsFile(path: string, scope: "global" | "project"): Promise<{
  settings: UsageSettingsFile;
  warnings: string[];
}> {
  try {
    const content = await readFile(path);
    if (content.byteLength > MAX_SETTINGS_BYTES) {
      return { settings: {}, warnings: [`Ignoring ${scope} ${SETTINGS_FILENAME}: file is too large`] };
    }
    return parseUsageSettings(JSON.parse(content.toString("utf8")), scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, warnings: [] };
    const reason = error instanceof SyntaxError ? "invalid JSON" : "could not be read";
    return { settings: {}, warnings: [`Ignoring ${scope} ${SETTINGS_FILENAME}: ${reason}`] };
  }
}

export async function loadUsageSettings(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
): Promise<LoadedUsageSettings> {
  const paths = usageSettingsPaths(cwd, agentDir);
  const global = await readSettingsFile(paths.global, "global");
  const project = projectTrusted
    ? await readSettingsFile(paths.project, "project")
    : { settings: {}, warnings: [] };
  return {
    settings: mergeUsageSettings(global.settings, project.settings),
    global: global.settings,
    project: project.settings,
    paths,
    warnings: [...global.warnings, ...project.warnings],
  };
}

export async function saveUsageSettings(path: string, settings: UsageSettingsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
