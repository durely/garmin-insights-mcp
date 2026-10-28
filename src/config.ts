import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CalendarDate, isCalendarDate } from "./garmin/dates.ts";
import { GarminApiError } from "./garmin/errors.ts";

export const SERVER_NAME = "garmin-insights-mcp";
export const SERVER_VERSION = "0.5.1";

export interface Config {
  baseUrl: string;
  /** Key file location; the env var GARMIN_PERSONAL_API_KEY takes precedence. Read lazily via loadApiKey(). */
  apiKeyFile: string;
  apiKeyExpires: CalendarDate | undefined;
  dataDir: string;
  tokenCacheFile: string;
  dbFile: string;
  /** Refresh the cache automatically when tools find it older than staleAfterMs. */
  autoSync: boolean;
  staleAfterMs: number;
  /** Days of per-day detail (HRV readings, intraday HR, SpO2, Body Battery curve) kept synced. */
  detailDays: number;
  timeZone: string;
  requestsPerSecond: number;
}

const DEFAULT_KEY_FILE = join(homedir(), ".config/garmin/connect-personal-api-key");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Clients that install from the MCP Registry can pass a field the user left empty as "", so blank means unset.
  const get = (name: string) => env[name]?.trim() || undefined;
  const expires = get("GARMIN_API_KEY_EXPIRES");
  if (expires && !isCalendarDate(expires)) {
    throw new Error(`GARMIN_API_KEY_EXPIRES must be a date like 2027-10-24, got "${expires}"`);
  }

  const rps = Number(get("GARMIN_MCP_REQUESTS_PER_SECOND") ?? 4);
  if (!Number.isFinite(rps) || rps <= 0 || rps > 20) {
    throw new Error("GARMIN_MCP_REQUESTS_PER_SECOND must be a number between 0 and 20");
  }

  const detailDays = Number(get("GARMIN_MCP_DETAIL_DAYS") ?? 150);
  if (!Number.isInteger(detailDays) || detailDays < 1 || detailDays > 3650) {
    throw new Error("GARMIN_MCP_DETAIL_DAYS must be a whole number of days between 1 and 3650");
  }
  const autoSync = !["false", "0", "no", "off"].includes(
    (get("GARMIN_MCP_AUTO_SYNC") ?? "true").toLowerCase(),
  );

  const dataDir = get("GARMIN_MCP_DATA_DIR") ?? join(homedir(), ".garmin-insights-mcp");
  return {
    baseUrl: (get("GARMIN_PERSONAL_API_BASE_URL") ?? "https://personal.connectapi.garmin.com").replace(
      /\/$/,
      "",
    ),
    apiKeyFile: get("GARMIN_PERSONAL_API_KEY_FILE") ?? DEFAULT_KEY_FILE,
    apiKeyExpires: expires as CalendarDate | undefined,
    dataDir,
    tokenCacheFile: join(dataDir, "token.json"),
    dbFile: join(dataDir, "garmin.db"),
    autoSync,
    staleAfterMs: 60 * 60 * 1000,
    detailDays,
    timeZone: get("GARMIN_MCP_TIMEZONE") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    requestsPerSecond: rps,
  };
}

export const MISSING_KEY_HELP =
  "No Garmin Personal API key configured. Create one at https://connect.garmin.com/app/settings/personalApiToken, " +
  "then run this server's `auth` command in your own terminal (it checks the key and saves it), " +
  "or save it to ~/.config/garmin/connect-personal-api-key (chmod 600) yourself. Don't paste the key into a chat.";

export type ApiKeySource = { kind: "env" } | { kind: "file"; path: string } | { kind: "missing" };

/** Resolved on every call so a key added or rotated while the server runs is picked up. */
export function apiKeySource(config: Config, env: NodeJS.ProcessEnv = process.env): ApiKeySource {
  if (env.GARMIN_PERSONAL_API_KEY?.trim()) return { kind: "env" };
  if (existsSync(config.apiKeyFile)) return { kind: "file", path: config.apiKeyFile };
  return { kind: "missing" };
}

export async function loadApiKey(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const source = apiKeySource(config, env);
  if (source.kind === "env") return (env.GARMIN_PERSONAL_API_KEY ?? "").trim();
  if (source.kind === "file") {
    const key = (await readFile(source.path, "utf8")).trim();
    if (key) return key;
  }
  throw new GarminApiError("missing_key", MISSING_KEY_HELP);
}
