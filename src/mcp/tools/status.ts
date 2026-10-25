import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiKeySource, MISSING_KEY_HELP, SERVER_VERSION } from "../../config.ts";
import { spanDays, today } from "../../garmin/index.ts";
import type { AppContext } from "../context.ts";
import { render, responseFormatSchema } from "../format.ts";

const KEY_EXPIRY_WARNING_DAYS = 14;

export function registerStatusTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "garmin_status",
    {
      title: "Garmin connection status",
      description: `Check that the Garmin Personal API connection works and report its configuration.

Reports: where the API key comes from, whether a token could be obtained and when it expires, the API key's expiry (if GARMIN_API_KEY_EXPIRES is set), the time zone used for calendar dates, and the server version.

Use this first when another garmin_* tool fails with an authentication error, or when the user asks whether their Garmin connection is set up.`,
      inputSchema: z.strictObject({ response_format: responseFormatSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }, extra) => {
      const { config, tokens, client } = ctx;
      const source = apiKeySource(config);
      const warnings: string[] = [];

      let connected = false;
      let connectionError: string | undefined;
      let garminTimeZone: string | undefined;
      if (source.kind === "missing") {
        connectionError = MISSING_KEY_HELP;
      } else {
        try {
          await tokens.getToken();
          const profile = await client.getUserProfileSettings(extra.mcpReq.signal);
          garminTimeZone = profile?.timeZone;
          connected = true;
        } catch (error) {
          connectionError = error instanceof Error ? error.message : String(error);
        }
      }

      const token = tokens.currentTokenInfo();
      const todayLocal = today(config.timeZone);
      const keyDaysLeft = config.apiKeyExpires ? spanDays(todayLocal, config.apiKeyExpires) - 1 : undefined;
      if (keyDaysLeft !== undefined && keyDaysLeft < 0) {
        warnings.push(`The API key expired on ${config.apiKeyExpires}. Create a new one in Garmin Connect.`);
      } else if (keyDaysLeft !== undefined && keyDaysLeft <= KEY_EXPIRY_WARNING_DAYS) {
        warnings.push(`The API key expires in ${keyDaysLeft} days (${config.apiKeyExpires}).`);
      }
      if (garminTimeZone && garminTimeZone !== config.timeZone) {
        const sameOffset = offsetOf(garminTimeZone) === offsetOf(config.timeZone);
        if (!sameOffset) {
          warnings.push(
            `Garmin profile time zone is ${garminTimeZone} but this server uses ${config.timeZone}. ` +
              "Set GARMIN_MCP_TIMEZONE if dates look shifted.",
          );
        }
      }

      const data = {
        connected,
        ...(connectionError ? { error: connectionError } : {}),
        api_key_source:
          source.kind === "env"
            ? "GARMIN_PERSONAL_API_KEY"
            : source.kind === "file"
              ? source.path
              : "missing",
        api_key_expires: config.apiKeyExpires ?? null,
        api_key_days_left: keyDaysLeft ?? null,
        token_expires_at: token?.expiresAt.toISOString() ?? null,
        token_scopes: token?.scopes ?? [],
        time_zone: config.timeZone,
        garmin_profile_time_zone: garminTimeZone ?? null,
        today: todayLocal,
        requests_per_second: config.requestsPerSecond,
        data_dir: config.dataDir,
        server_version: SERVER_VERSION,
        warnings,
      };

      return render(response_format, data, () =>
        [
          `# Garmin connection: ${connected ? "✅ connected" : "❌ not connected"}`,
          ...(connectionError ? ["", `**Problem:** ${connectionError}`] : []),
          "",
          `- API key: ${data.api_key_source}${config.apiKeyExpires ? `, expires ${config.apiKeyExpires} (${keyDaysLeft} days left)` : " (expiry unknown; set GARMIN_API_KEY_EXPIRES to get a reminder)"}`,
          `- Token: ${token ? `valid until ${token.expiresAt.toISOString()}` : "none"}`,
          `- Time zone: ${config.timeZone}${garminTimeZone ? ` (Garmin profile: ${garminTimeZone})` : ""}, today is ${todayLocal}`,
          `- Throttle: ${config.requestsPerSecond} requests/s`,
          `- Server version: ${SERVER_VERSION}`,
          ...(warnings.length ? ["", "**Warnings:**", ...warnings.map((w) => `- ${w}`)] : []),
        ].join("\n"),
      );
    },
  );
}

/** Current UTC offset of a zone, e.g. "GMT+2"; used to tell harmless aliases (Paris vs Brussels) from real mismatches. */
function offsetOf(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}
