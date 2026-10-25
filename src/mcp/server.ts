import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "../config.ts";
import type { AppContext } from "./context.ts";
import { registerActivityTools } from "./tools/activities.ts";
import { registerAnalysisTools } from "./tools/analysis.ts";
import { registerFitTools } from "./tools/fit.ts";
import { registerHealthTools } from "./tools/health.ts";
import { registerProfileTools } from "./tools/profile.ts";
import { registerStatusTools } from "./tools/status.ts";
import { registerSyncTools } from "./tools/sync.ts";

// Garmin's API brand guidelines ask that data and analyses built on it credit Garmin as the source.
export const SERVER_INSTRUCTIONS = `durely insights reads the user's own Garmin data (activities, health, recovery) from a local cache synced with Garmin's official Personal API. It is not made or endorsed by Garmin.

When you present this data in charts, tables, reports or analyses, name Garmin as the source: "Garmin <device model>" when the device is known (e.g. "Garmin Forerunner 965"), otherwise "Data: Garmin". For analyses, "Insights derived in part from Garmin device-sourced data" works.`;

/** Builds a fresh McpServer with every tool registered. Shared state lives in ctx. */
export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerStatusTools(server, ctx);
  registerProfileTools(server, ctx);
  registerActivityTools(server, ctx);
  registerFitTools(server, ctx);
  registerHealthTools(server, ctx);
  registerAnalysisTools(server, ctx);
  registerSyncTools(server, ctx);
  return server;
}
