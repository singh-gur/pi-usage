import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type FooterFormat = "full" | "compact" | "off";
export type PollIntervalMinutes = 0 | 1 | 5 | 15 | 30;

export interface UsageSettings {
  footerFormat: FooterFormat;
  pollIntervalMinutes: PollIntervalMinutes;
  refreshAfterTurn: boolean;
}

export type UsageSettingsFile = Partial<UsageSettings>;

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = {
  footerFormat: "full",
  pollIntervalMinutes: 5,
  refreshAfterTurn: true,
};

export const SETTINGS_FILENAME = "pi-usage.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
const FOOTER_FORMATS = new Set<FooterFormat>(["full", "compact", "off"]);
const POLL_INTERVALS = new Set<PollIntervalMinutes>([0, 1, 5, 15, 30]);
const KNOWN_KEYS = new Set<keyof UsageSettings>(["footerFormat", "pollIntervalMinutes", "refreshAfterTurn"]);

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
  return { ...DEFAULT_USAGE_SETTINGS, ...global, ...project };
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
  if (input.refreshAfterTurn !== undefined) {
    if (typeof input.refreshAfterTurn === "boolean") settings.refreshAfterTurn = input.refreshAfterTurn;
    else warnings.push(`Ignoring invalid ${scope} setting "refreshAfterTurn"`);
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
