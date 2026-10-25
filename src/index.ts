#!/usr/bin/env node
// Entry point. `garmin-insights-mcp` (or `... serve`) runs the MCP server on stdio;
// `... sync` downloads Garmin data into the local cache from the command line;
// `... auth` checks and saves the Personal API key.

import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuthCancelled, authCommand, readKeyFromStdin } from "./cli/auth.ts";
import { loadConfig, SERVER_NAME, SERVER_VERSION } from "./config.ts";
import { toCalendarDate } from "./garmin/index.ts";
import { log } from "./log.ts";
import { type AppContext, createAppContext } from "./mcp/context.ts";
import { createServer } from "./mcp/server.ts";
import { statusData } from "./mcp/tools/sync.ts";
import { ALL_DOMAIN_NAMES, FIT_FILES_DOMAIN, SELECTABLE_DOMAIN_NAMES } from "./sync/domains.ts";
import { SyncBusyError } from "./sync/engine.ts";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

Usage:
  ${SERVER_NAME} [serve]                 Run the MCP server on stdio (default)
  ${SERVER_NAME} sync [options]          Download Garmin data into the local cache
      --full                             Forget cached coverage and re-download everything
      --from yyyy-MM-dd                  History start date (default: first activity)
      --fit                              Also download the original FIT file of every activity
      --domains a,b                      Only these: ${SELECTABLE_DOMAIN_NAMES.join(", ")}
  ${SERVER_NAME} status                  Show what's in the local cache
  ${SERVER_NAME} auth                    Save your Personal API key (checked with Garmin first)
      --check                            Only check the configured key with Garmin
  ${SERVER_NAME} --version | --help

Environment:
  GARMIN_PERSONAL_API_KEY         API key (otherwise read from GARMIN_PERSONAL_API_KEY_FILE)
  GARMIN_PERSONAL_API_KEY_FILE    Key file, default ~/.config/garmin/connect-personal-api-key
  GARMIN_API_KEY_EXPIRES          Key expiry date (yyyy-MM-dd), for reminders in garmin_status
  GARMIN_MCP_TIMEZONE             IANA time zone for calendar dates, default: system time zone
  GARMIN_MCP_DATA_DIR             Data directory (cache + token), default ~/.garmin-insights-mcp
  GARMIN_MCP_AUTO_SYNC            Refresh the cache automatically when it's over an hour old (default true)
  GARMIN_MCP_DETAIL_DAYS          Days of per-day detail to keep synced (default 150)
  GARMIN_MCP_REQUESTS_PER_SECOND  Request throttle, default 4
  GARMIN_MCP_LOG_LEVEL            debug | info | warn | error (logs go to stderr)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    full: { type: "boolean" },
    from: { type: "string" },
    domains: { type: "string" },
    fit: { type: "boolean" },
    check: { type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(HELP);
} else if (values.version) {
  process.stdout.write(`${SERVER_VERSION}\n`);
} else if (positionals[0] === "auth") {
  // Before the app context: auth needs no cache or data directory.
  try {
    process.exitCode = await authCommand(
      loadConfig(),
      { check: values.check ?? false },
      { readKey: () => readKeyFromStdin(), write: (text) => process.stderr.write(text), env: process.env },
    );
  } catch (error) {
    if (!(error instanceof AuthCancelled)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 130;
  }
} else {
  const command = positionals[0] ?? "serve";
  const ctx = createAppContext(loadConfig());
  if (command === "serve") serve(ctx);
  else if (command === "sync") process.exitCode = await syncCommand(ctx);
  else if (command === "status") process.stdout.write(`${JSON.stringify(statusData(ctx), null, 2)}\n`);
  else {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
  }
}

function serve(ctx: AppContext): void {
  serveStdio(() => createServer(ctx));
  log.info(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`, { timeZone: ctx.config.timeZone });

  // When the client goes away, stop any background sync (progress is kept) and release the lease.
  const shutdown = () => {
    ctx.sync.stop();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => ctx.sync.abandon()); // also covers the forced exit above
}

async function syncCommand(ctx: AppContext): Promise<number> {
  let domains = values.domains?.split(",").map((d) => d.trim());
  const unknown = domains?.filter((d) => !SELECTABLE_DOMAIN_NAMES.includes(d));
  if (unknown?.length) {
    process.stderr.write(
      `Unknown domain(s): ${unknown.join(", ")}. Choose from ${SELECTABLE_DOMAIN_NAMES.join(", ")}.\n`,
    );
    return 2;
  }
  if (values.fit) domains = [...(domains ?? ALL_DOMAIN_NAMES), FIT_FILES_DOMAIN];
  let run: ReturnType<typeof ctx.sync.start>;
  try {
    run = ctx.sync.start({
      mode: values.full ? "full" : "auto",
      ...(values.from ? { from: toCalendarDate(values.from) } : {}),
      ...(domains ? { domains } : {}),
    });
  } catch (error) {
    if (error instanceof SyncBusyError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  process.on("SIGINT", () => {
    process.stderr.write("\nStopping after the current request; progress is kept...\n");
    ctx.sync.stop();
  });
  process.on("SIGTERM", () => ctx.sync.stop()); // e.g. docker stop
  process.on("exit", () => ctx.sync.abandon());

  const timer = setInterval(() => {
    const r = ctx.store.latestRun();
    if (r)
      process.stderr.write(`\r${r.done_tasks}/${r.total_tasks} ${(r.current ?? "").padEnd(50).slice(0, 50)}`);
  }, 1000);
  const summary = await run.done;
  clearInterval(timer);
  process.stderr.write(
    `\nSync ${summary.status}: ${summary.tasksDone}/${summary.tasksTotal} steps, ${summary.errors.length} error(s)\n`,
  );
  for (const e of summary.errors) process.stderr.write(`  - ${e}\n`);
  return summary.status === "completed" && summary.errors.length === 0 ? 0 : 1;
}
