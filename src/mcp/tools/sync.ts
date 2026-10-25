import { statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { toCalendarDate } from "../../garmin/index.ts";
import {
  ACTIVITIES_DOMAIN,
  ALL_DOMAIN_NAMES,
  DOMAINS,
  FIT_FILES_DOMAIN,
  SELECTABLE_DOMAIN_NAMES,
} from "../../sync/domains.ts";
import { SyncBusyError } from "../../sync/engine.ts";
import type { AppContext } from "../context.ts";
import { render, responseFormatSchema } from "../format.ts";

export function registerSyncTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "garmin_sync",
    {
      title: "Sync Garmin data",
      description: `Start downloading Garmin data into the local cache. Runs in the background and returns immediately; follow progress with garmin_sync_status.

You rarely need this: other tools sync automatically on first use and when the cache is over an hour old. Use it to:
  - fetch the latest data right now (e.g. "I just finished a run"),
  - extend history further back (from="2019-01-01"),
  - re-download everything (mode="full"), e.g. after editing many activities in Garmin Connect.

Domains (default: all except fit_files): ${ALL_DOMAIN_NAMES.join(", ")}.
"fit_files" downloads the original FIT file of every activity (one request each, ~2 activities/s). That's optional: FIT files are otherwise fetched on demand by garmin_get_activity_laps and garmin_get_activity_streams.`,
      inputSchema: z.strictObject({
        mode: z
          .enum(["auto", "full"])
          .default("auto")
          .describe(
            "auto: new data plus any history still missing. full: forget what's cached and re-download.",
          ),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "Extend history back to this date (yyyy-MM-dd). History starts at your first activity by default; an earlier date fetches older wellness data. A later date has no effect: history is never narrowed.",
          ),
        domains: z
          .array(z.enum(SELECTABLE_DOMAIN_NAMES as [string, ...string[]]))
          .min(1)
          .optional()
          .describe('Only sync these domains. Defaults to all except "fit_files".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ mode, from, domains }) => {
      if (ctx.sync.running) {
        return {
          content: [
            { type: "text", text: `A sync is already running in this session.\n\n${statusText(ctx)}` },
          ],
        };
      }
      try {
        const run = ctx.sync.start({
          mode,
          ...(from ? { from: toCalendarDate(from) } : {}),
          ...(domains ? { domains } : {}),
        });
        run.done.catch(() => {});
      } catch (error) {
        if (error instanceof SyncBusyError) {
          return { content: [{ type: "text", text: `${error.message}\n\n${statusText(ctx)}` }] };
        }
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: `Garmin sync started (${mode}${from ? `, from ${from}` : ""}). It runs in the background; activities come first, then health history and recent per-day detail. Check progress with garmin_sync_status.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "garmin_sync_status",
    {
      title: "Garmin sync status",
      description: `Show what's in the local Garmin cache and the progress of the current or last sync.

Returns: the running/last sync (progress, errors), and per data domain the date range covered, number of days, whether all history is in, and the last successful sync.`,
      inputSchema: z.strictObject({ response_format: responseFormatSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => render(response_format, statusData(ctx), () => statusText(ctx)),
  );
}

export function statusData(ctx: AppContext) {
  const { store } = ctx;
  const now = new Date();
  store.markOrphanedRuns(store.activeLease(now, ctx.sync.leaseStaleMs)?.owner, now.toISOString());
  const run = store.latestRun();
  const states = new Map(store.allSyncStates().map((s) => [s.domain, s]));
  const days = new Map(store.dailyStats().map((d) => [d.domain, d]));
  const activities = store.activityStats();
  const fit = store.fitStats();
  return {
    sync: run
      ? {
          status: run.status,
          mode: run.mode,
          started_at: run.started_at,
          finished_at: run.finished_at,
          progress: `${run.done_tasks}/${run.total_tasks}`,
          current: run.current,
          errors: run.error_count,
          last_error: run.last_error,
        }
      : null,
    history_start: store.getMeta("history_start") ?? null,
    domains: [ACTIVITIES_DOMAIN, ...DOMAINS.map((d) => d.name)].map((name) => {
      const s = states.get(name);
      const d = days.get(name);
      return {
        domain: name,
        scope:
          name === ACTIVITIES_DOMAIN ? "history" : (DOMAINS.find((x) => x.name === name)?.scope ?? "history"),
        ...(name === ACTIVITIES_DOMAIN
          ? { activities: activities.count, earliest: activities.earliest, latest: activities.latest }
          : { days: d?.days ?? 0, earliest: d?.earliest ?? null, latest: d?.latest ?? null }),
        all_history: Boolean(s?.backfill_complete),
        last_success_at: s?.last_success_at ?? null,
        last_error: s?.last_error ?? null,
      };
    }),
    fit_files: {
      downloaded: fit.files,
      size_mb: Math.round((fit.bytes / 1_048_576) * 10) / 10,
      all_downloaded:
        Boolean(states.get(FIT_FILES_DOMAIN)?.backfill_complete) && store.activitiesWithoutFit().length === 0,
    },
    cache_file: ctx.config.dbFile,
    cache_size_mb: fileSizeMb(ctx.config.dbFile),
    detail_days: ctx.config.detailDays,
    auto_sync: ctx.config.autoSync,
  };
}

function statusText(ctx: AppContext): string {
  const data = statusData(ctx);
  const lines = ["# Garmin cache", ""];
  if (data.sync) {
    const s = data.sync;
    lines.push(
      s.status === "running"
        ? `**Sync running** (${s.mode}): ${s.progress} steps${s.current ? `, now: ${s.current}` : ""}`
        : `Last sync: **${s.status}** (${s.mode}), finished ${s.finished_at ?? "?"}, ${s.progress} steps`,
    );
    if (s.errors) lines.push(`Errors: ${s.errors} (last: ${s.last_error})`);
  } else {
    lines.push("No sync has run yet. Tools start one automatically, or call garmin_sync.");
  }
  lines.push(
    "",
    "| Domain | Scope | Count | From | To | All history | Last synced |",
    "|---|---|---|---|---|---|---|",
  );
  for (const d of data.domains) {
    const count = "activities" in d ? `${d.activities} activities` : `${d.days} days`;
    lines.push(
      `| ${d.domain} | ${d.scope === "recent" ? `last ${data.detail_days} d` : "history"} | ${count} | ${d.earliest ?? "–"} | ${d.latest ?? "–"} | ${d.all_history ? "✅" : "…"} | ${d.last_success_at?.slice(0, 16).replace("T", " ") ?? "–"}${d.last_error ? ` ⚠️ ${d.last_error}` : ""} |`,
    );
  }
  lines.push(
    "",
    `FIT files: ${data.fit_files.downloaded} downloaded (${data.fit_files.size_mb} MB)${data.fit_files.all_downloaded ? ", all activities" : "; others download on demand (or sync domain fit_files)"}`,
  );
  lines.push(
    "",
    `Cache: ${data.cache_file} (${data.cache_size_mb} MB), auto-sync ${data.auto_sync ? "on" : "off"}, history from ${data.history_start ?? "first activity"}`,
  );
  return lines.join("\n");
}

function fileSizeMb(file: string): number {
  try {
    return Math.round((statSync(file).size / 1_048_576) * 10) / 10;
  } catch {
    return 0;
  }
}
