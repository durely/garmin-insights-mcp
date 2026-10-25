import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { toCalendarDate } from "../../garmin/index.ts";
import { ACTIVITY_SORT_COLUMNS } from "../../store/store.ts";
import { ACTIVITIES_DOMAIN } from "../../sync/domains.ts";
import { type ActivityView, activityLine, fromDetail, fromSummarized, speedText } from "../activity-view.ts";
import type { AppContext } from "../context.ts";
import { CHARACTER_LIMIT, formatDuration, formatKm, render, responseFormatSchema } from "../format.ts";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Local calendar date, yyyy-MM-dd");

const ListInput = z.strictObject({
  start_date: dateSchema.optional().describe("Only activities on or after this local date, yyyy-MM-dd"),
  end_date: dateSchema.optional().describe("Only activities on or before this local date, yyyy-MM-dd"),
  activity_type: z
    .string()
    .min(2)
    .optional()
    .describe(
      "Garmin activity type or parent type. Parent types include their subtypes: running (trail_running, treadmill_running, track_running, virtual_run), cycling (road_biking, virtual_ride, indoor_cycling, mountain_biking, gravel_cycling), swimming (lap_swimming, open_water_swimming), walking, hiking, multi_sport, fitness_equipment (strength_training, indoor_cardio, indoor_rowing), racket_sports, water_sports, other.",
    ),
  search: z
    .string()
    .min(2)
    .max(100)
    .optional()
    .describe("Text to match in the activity name (case-insensitive)"),
  min_distance_km: z.number().min(0).optional().describe("Minimum distance in km"),
  max_distance_km: z.number().min(0).optional().describe("Maximum distance in km"),
  min_duration_min: z.number().min(0).optional().describe("Minimum duration in minutes"),
  max_duration_min: z.number().min(0).optional().describe("Maximum duration in minutes"),
  include_multisport_legs: z
    .boolean()
    .default(false)
    .describe(
      "false (default): multisport activities appear once, as the parent. true: show their individual legs (swim/bike/run/transitions) instead of the parent, e.g. so triathlon bike legs count as cycling volume. Never double counts.",
    ),
  sort_by: z
    .enum(Object.keys(ACTIVITY_SORT_COLUMNS) as [keyof typeof ACTIVITY_SORT_COLUMNS])
    .default("date")
    .describe("Sort field"),
  sort_order: z.enum(["desc", "asc"]).default("desc").describe("desc = newest/largest first"),
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum activities to return (1-100)"),
  offset: z.number().int().min(0).default(0).describe("Number of activities to skip, for pagination"),
  response_format: responseFormatSchema,
});

export function registerActivityTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "garmin_list_activities",
    {
      title: "List Garmin activities",
      description: `Search the user's Garmin activities (all history, from the local cache), newest first by default.

Returns one page of compact summaries plus the total number of matches: id, date, type, name, duration, distance, pace/speed, HR, power, elevation, training effect, training load, TSS/IF and VO2max where available, plus time in HR/power zones (JSON mode).

Examples:
  - "My runs this month" -> activity_type="running", start_date="2026-10-01"
  - "Longest rides ever" -> activity_type="cycling", sort_by="distance"
  - "Zwift sessions" -> activity_type="virtual_ride"
  - "Triathlon bike legs" -> include_multisport_legs=true, activity_type="road_biking"

The cache refreshes automatically when it's more than an hour old. Use garmin_get_activity for one activity's full details (splits, FTP, workout).`,
      inputSchema: ListInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { note } = await ctx.freshness.ensure(ACTIVITIES_DOMAIN);
      const { total, items: raw } = ctx.store.queryActivities({
        startDate: input.start_date ? toCalendarDate(input.start_date) : undefined,
        endDate: input.end_date ? toCalendarDate(input.end_date) : undefined,
        type: input.activity_type,
        search: input.search,
        minDistanceM: kmToMeters(input.min_distance_km),
        maxDistanceM: kmToMeters(input.max_distance_km),
        minDurationS: minutesToSeconds(input.min_duration_min),
        maxDurationS: minutesToSeconds(input.max_duration_min),
        multisport: input.include_multisport_legs ? "legs" : "parents",
        sortBy: input.sort_by,
        sortOrder: input.sort_order,
        limit: input.limit,
        offset: input.offset,
      });
      const all = raw.map(fromSummarized);

      const build = (items: ActivityView[]) => {
        const nextOffset = input.offset + items.length;
        const hasMore = nextOffset < total;
        const data = {
          total,
          count: items.length,
          offset: input.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
          ...(note ? { note } : {}),
          activities: items,
        };
        return render(input.response_format, data, () => {
          if (items.length === 0) return noResultsText(input.include_multisport_legs, note);
          const lines = [
            `# Garmin activities: ${input.offset + 1}–${nextOffset} of ${total}`,
            ...(note ? ["", `_${note}_`] : []),
            "",
            ...items.map(activityLine),
          ];
          if (hasMore) lines.push("", `More results: call again with offset=${nextOffset}.`);
          return lines.join("\n");
        });
      };

      // Stay under CHARACTER_LIMIT by returning fewer activities, never by truncating text.
      let items = all;
      let result = build(items);
      while (items.length > 1 && (result.content[0]?.text.length ?? 0) > CHARACTER_LIMIT) {
        items = items.slice(0, Math.ceil(items.length / 2));
        result = build(items);
      }
      return result;
    },
  );

  server.registerTool(
    "garmin_get_activity",
    {
      title: "Get Garmin activity details",
      description: `Get full details for one Garmin activity by ID.

Returns: name, description, type, start time and time zone, device, summary metrics (duration, distance, speeds, HR min/avg/max, power avg/max/NP/20-min, FTP, cadence, stride, calories, training effect + message, training load, TSS, IF, temperature, intensity minutes), split summaries (e.g. run/walk/stand intervals), the structured workout if one was followed, and multisport parent/child IDs.

Get IDs from garmin_list_activities. Example: "Tell me about yesterday's run" -> list activities for that date, then call this with its id.`,
      inputSchema: z.strictObject({
        activity_id: z
          .number()
          .int()
          .positive()
          .describe("Garmin activity ID from garmin_list_activities, e.g. 12345678901"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ activity_id, response_format }, extra) => {
      // Details rarely change after upload, so they're fetched once and cached.
      let cached = ctx.store.getActivityDetail(activity_id);
      if (!cached) {
        const signal = extra.mcpReq.signal;
        const detail = await ctx.client.getActivity(activity_id, signal);
        if (!detail) {
          throw new Error(
            `Activity ${activity_id} returned no data. Check the ID with garmin_list_activities.`,
          );
        }
        const workouts = await ctx.client.getActivityWorkouts(activity_id, signal);
        const fetchedAt = new Date().toISOString();
        ctx.store.saveActivityDetail(activity_id, detail, workouts, fetchedAt);
        cached = { detail, workouts, fetched_at: fetchedAt };
      }
      const view = fromDetail(cached.detail, cached.workouts);

      return render(response_format, view as unknown as Record<string, unknown>, () => {
        const s = view.summary as Record<string, number | string | undefined>;
        const lines = [
          `# ${view.name ?? "Activity"} [${view.id}]`,
          "",
          `${view.type ?? "?"} · ${view.start_local ?? "?"} (${view.time_zone ?? "local"})${view.location ? ` · ${view.location}` : ""}${view.device_manufacturer ? ` · ${view.device_manufacturer}` : ""}`,
        ];
        if (view.description) lines.push("", `> ${view.description}`);
        if (view.parent_id) lines.push("", `Leg of multisport activity ${view.parent_id}.`);
        if (view.child_ids.length) lines.push("", `Multisport legs: ${view.child_ids.join(", ")}`);
        lines.push(
          "",
          "## Summary",
          "",
          `- Duration ${formatDuration(num(s.duration_s))} (moving ${formatDuration(num(s.moving_s))}), distance ${formatKm(num(s.distance_m))}, avg ${speedText(view.sport, num(s.avg_speed_mps) ?? null)}`,
        );
        const extras: Array<[string, unknown]> = [
          [
            "Heart rate (min/avg/max)",
            s.avg_hr ? `${s.min_hr ?? "–"}/${s.avg_hr}/${s.max_hr ?? "–"} bpm` : undefined,
          ],
          [
            "Power (avg/NP/max/20min)",
            s.avg_power_w
              ? `${s.avg_power_w}/${s.normalized_power_w ?? "–"}/${s.max_power_w ?? "–"}/${s.max_20min_power_w ?? "–"} W`
              : undefined,
          ],
          ["FTP", s.ftp_w ? `${s.ftp_w} W` : undefined],
          ["Cadence", s.avg_run_cadence ?? s.avg_bike_cadence ?? s.avg_swim_cadence],
          [
            "Elevation",
            s.elevation_gain_m != null
              ? `↑${s.elevation_gain_m} m ↓${s.elevation_loss_m ?? "–"} m`
              : undefined,
          ],
          [
            "Training effect",
            s.aerobic_te != null
              ? `${s.aerobic_te} aerobic / ${s.anaerobic_te ?? 0} anaerobic (${s.te_label ?? ""})`
              : undefined,
          ],
          ["Training load", s.training_load],
          ["TSS / IF", s.tss != null ? `${s.tss} / ${s.intensity_factor ?? "–"}` : undefined],
          ["Calories", s.calories],
          ["Temperature", s.avg_temperature_c != null ? `${s.avg_temperature_c} °C` : undefined],
        ];
        for (const [label, value] of extras)
          if (value != null && value !== "") lines.push(`- ${label}: ${value}`);
        if (view.splits.length) {
          lines.push(
            "",
            "## Splits",
            "",
            "| Type | Count | Duration | Distance | Avg HR |",
            "|---|---|---|---|---|",
          );
          for (const sp of view.splits) {
            lines.push(
              `| ${sp.type ?? "?"} | ${sp.count ?? "–"} | ${formatDuration(num(sp.duration_s))} | ${formatKm(num(sp.distance_m))} | ${sp.avg_hr ?? "–"} |`,
            );
          }
        }
        if (view.workouts.length) {
          lines.push(
            "",
            "## Workout",
            "",
            ...view.workouts.map((w) => `- ${w.name ?? "(unnamed)"} (${w.sport ?? "?"})`),
          );
        }
        return lines.join("\n");
      });
    },
  );
}

function kmToMeters(km: number | undefined): number | undefined {
  return km === undefined ? undefined : Math.round(km * 1000);
}

function minutesToSeconds(min: number | undefined): number | undefined {
  return min === undefined ? undefined : Math.round(min * 60);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function noResultsText(includeLegs: boolean, note: string | undefined): string {
  return [
    "No activities match these filters.",
    "Try a wider date range, drop the distance/duration filters, or check activity_type.",
    includeLegs ? "" : "Multisport legs are hidden; set include_multisport_legs=true to search them.",
    note ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}
