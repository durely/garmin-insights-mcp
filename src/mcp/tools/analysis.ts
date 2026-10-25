import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type ActivityAnalysis, analyzeActivity, type Family, paceText } from "../../analysis/activity.ts";
import { calibrateScale, fitnessSeries, type LoadSettings } from "../../analysis/load.ts";
import { mean, round } from "../../analysis/stats.ts";
import {
  dailyLoads,
  loadCoverage,
  type Period,
  periodStart,
  recoveryAnalysis,
  trainingPeriods,
} from "../../analysis/training.ts";
import {
  addDays,
  type CalendarDate,
  type SummarizedActivity,
  spanDays,
  toCalendarDate,
  today,
} from "../../garmin/index.ts";
import { QueryError, runQuery, SCHEMA_GUIDE } from "../../query/run.ts";
import { activityRows, loadRows, medianRestingHr, recoveryRows } from "../../store/analysis.ts";
import { fromSummarized, sportFamily } from "../activity-view.ts";
import type { AppContext } from "../context.ts";
import {
  CHARACTER_LIMIT,
  formatDuration,
  formatKm,
  renderDerived,
  responseFormatSchema,
  type ToolResult,
} from "../format.ts";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Local calendar date, yyyy-MM-dd");
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerAnalysisTools(server: McpServer, ctx: AppContext): void {
  // ---- one activity ----
  server.registerTool(
    "garmin_analyze_activity",
    {
      title: "Analyze an activity",
      description: `Compute training metrics for one activity from its second-by-second FIT data:
- time in heart rate zones (the user's Garmin zones for that sport) and, with an FTP, in power zones (Coggan)
- power: average, normalized power (NP), variability index, intensity factor and TSS (needs FTP)
- aerobic decoupling: drift of power or pace per heartbeat between the first and second half (<5% is good for steady efforts of 45+ min)
- first vs second half (negative/positive split)
- best efforts: power over 5 s–60 min, heart rate over 1–60 min, fastest 400 m–marathon (running), 5–90 km (cycling), 100 m–3.8 km (swimming)
- Edwards TRIMP (zone-weighted minutes) and detected work intervals with their consistency

FTP comes from ftp_w, else from the activity's own record (Garmin cycling FTP). Works for multisport legs too.`,
      inputSchema: z.strictObject({
        activity_id: z.number().int().positive().describe("Garmin activity ID from garmin_list_activities"),
        ftp_w: z
          .number()
          .int()
          .min(50)
          .max(600)
          .optional()
          .describe("Functional threshold power in watts, for power zones, IF and TSS"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id, ftp_w, response_format }, extra) => {
      const signal = extra.mcpReq.signal;
      const result = await analyzeOne(ctx, activity_id, ftp_w, signal);
      return renderDerived(response_format, result as unknown as Record<string, unknown>, () =>
        analysisMarkdown(result),
      );
    },
  );

  // ---- training summary ----
  server.registerTool(
    "garmin_training_summary",
    {
      title: "Training summary",
      description: `Summarize training per week or month: sessions, hours, distance, elevation and training load, per sport; intensity distribution (share of time in low = HR zones 1–2, moderate = zone 3, high = zones 4–5, with a rough pattern: polarized, pyramidal, threshold-heavy); and the load trend at the end of each period: fitness (CTL, 42-day), fatigue (ATL, 7-day), form (TSB = CTL − ATL) and the acute:chronic ratio (ACWR; above ~1.5 is a commonly cited risk zone).

Load is Garmin's training load per activity; activities without it (older devices, some third-party uploads) get an estimate from average heart rate (Banister TRIMP) scaled to Garmin's load using the user's own activities. The response says how much is estimated. Multisport legs count toward their sport; walking is included as its own sport.

Defaults to the last 12 weeks by week. Filter with sport (e.g. running, cycling, or a type like virtual_ride).`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        group_by: z.enum(["week", "month"]).default("week"),
        sport: z.string().min(2).optional().describe("Only this sport (parent type) or activity type"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, group_by, sport, response_format }, extra) => {
      const note = (await ctx.freshness.ensure("activities")).note;
      const end = end_date ? toCalendarDate(end_date) : today(ctx.config.timeZone);
      const start = start_date
        ? toCalendarDate(start_date)
        : (periodStart(addDays(end, group_by === "week" ? -7 * 11 : -365), group_by) as CalendarDate);
      if (spanDays(start, end) < 1) throw new Error(`start_date ${start} is after end_date ${end}.`);
      const { rows, settings, fitness } = await loadContext(ctx, end, extra.mcpReq.signal);
      const periods = trainingPeriods(rows, settings, {
        start,
        end,
        period: group_by as Period,
        ...(sport ? { sport } : {}),
        fitness,
      });
      const notes = [
        note,
        sport ? "CTL, ATL, TSB and ACWR always cover all sports; the other columns are filtered." : undefined,
      ].filter((n): n is string => Boolean(n));
      return fitToLimit(periods, (items, dropped) => {
        const allNotes = dropped
          ? [
              ...notes,
              `Only the most recent ${items.length} of ${periods.length} periods fit; use group_by="month" or a later start_date for older ones.`,
            ]
          : notes;
        const data = {
          start_date: start,
          end_date: end,
          group_by,
          ...(sport ? { sport } : {}),
          ...(allNotes.length ? { notes: allNotes } : {}),
          load_model: loadModel(rows, settings),
          periods: items,
        };
        return renderDerived(response_format, data, () => trainingMarkdown(data, items));
      });
    },
  );

  // ---- recovery ----
  server.registerTool(
    "garmin_recovery_trends",
    {
      title: "Recovery trends",
      description: `Relate training load to recovery markers, day by day: resting HR, overnight HRV, sleep score and duration, Body Battery max and stress, each against the user's own rolling 28-day baseline.

Returns: a status (last 7 days vs the previous 28: HRV, resting HR, sleep, load; plus current fitness/fatigue/form), days flagged for low HRV, elevated resting HR or poor sleep, weekly averages, and correlations such as "previous day's load vs next morning's HRV" with their strength. Correlation is not causation, and short periods give noisy results.

Defaults to the last 8 weeks; at most 180 days.`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, response_format }, extra) => {
      for (const d of ["activities", "daily_summaries", "sleep", "hrv"]) await ctx.freshness.ensure(d);
      const end = end_date ? toCalendarDate(end_date) : today(ctx.config.timeZone);
      const start = start_date ? toCalendarDate(start_date) : addDays(end, -55);
      const days = spanDays(start, end);
      if (days < 1) throw new Error(`start_date ${start} is after end_date ${end}.`);
      if (days > 180) throw new Error(`At most 180 days per call; ${start}..${end} is ${days} days.`);
      const { rows, settings, fitness } = await loadContext(ctx, end, extra.mcpReq.signal);
      const recovery = recoveryAnalysis(
        recoveryRows(ctx.store, addDays(start, -28), end),
        dailyLoads(rows, settings),
        fitness,
        start,
      );
      return fitToLimit(recovery.days, (days, dropped) => {
        const data = {
          start_date: start,
          end_date: end,
          load_model: loadModel(rows, settings),
          ...recovery,
          ...(dropped
            ? {
                note: `Daily rows: only the most recent ${days.length} of ${recovery.days.length} days fit; the status, weeks and correlations cover the full range.`,
              }
            : {}),
          days,
        };
        return renderDerived(response_format, compactDays(data), () =>
          recoveryMarkdown({ ...data, days: recovery.days }),
        );
      });
    },
  );

  // ---- compare ----
  server.registerTool(
    "garmin_compare_activities",
    {
      title: "Compare activities",
      description: `Compare 2–6 activities side by side: date, type, duration, distance, pace/speed, heart rate, power (avg/NP), elevation, training effect and load, cadence, and efficiency factor (speed or NP per heartbeat; higher means more output for the same heart rate, a classic way to track aerobic progress on similar sessions).

With deep=true, also analyzes each one's FIT data (downloads files if needed): aerobic decoupling, time in low/moderate/high HR zones and best efforts.

Example: "Am I getting fitter on my Tuesday interval run?" → list those runs, then compare them.`,
      inputSchema: z.strictObject({
        activity_ids: z.array(z.number().int().positive()).min(2).max(6),
        deep: z.boolean().default(false).describe("Also run FIT-based analysis for each activity"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_ids, deep, response_format }, extra) => {
      await ctx.freshness.ensure("activities");
      const found = activityRows(ctx.store, activity_ids);
      const missing = activity_ids.filter((id) => !found.some((r) => r.id === id));
      if (missing.length)
        throw new Error(
          `Not in the local cache: ${missing.join(", ")}. Check the IDs with garmin_list_activities.`,
        );
      const items = activity_ids.map((id) => {
        const raw = JSON.parse(found.find((r) => r.id === id)?.raw_json ?? "{}") as SummarizedActivity;
        return {
          view: fromSummarized(raw),
          cadence:
            raw.averageRunningCadenceInStepsPerMinute ?? raw.averageBikingCadenceInRevPerMinute ?? null,
        };
      });
      const deepResults: Array<ActivityAnalysis | { error: string }> = [];
      if (deep) {
        for (const id of activity_ids) {
          deepResults.push(
            await analyzeOne(ctx, id, undefined, extra.mcpReq.signal).catch((e: unknown) => ({
              error: (e as Error).message,
            })),
          );
        }
      }
      const data = {
        activities: items.map(({ view, cadence }, i) => ({
          ...view,
          avg_cadence: cadence,
          efficiency_factor: efficiency(view),
          ...(deep ? { analysis: summarizeDeep(deepResults[i]) } : {}),
        })),
      };
      return renderDerived(response_format, data, () => compareMarkdown(data.activities));
    },
  );

  // ---- SQL ----
  server.registerTool(
    "garmin_query",
    {
      title: "Query the Garmin cache with SQL",
      description: `Run one read-only SQLite query against the local Garmin cache, for analyses the other tools don't cover (custom aggregations, correlations, records, comparisons across years).

${SCHEMA_GUIDE}

Rules: one SELECT or WITH statement; at most max_rows rows returned (default 200); 10-second timeout. Prefer aggregating in SQL over returning many rows.
Example: SELECT strftime('%Y', start_date) AS year, sport, ROUND(SUM(distance_m)/1000) AS km FROM activities WHERE is_multisport_parent = 0 GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      inputSchema: z.strictObject({
        sql: z.string().min(6).max(10_000).describe("A single SELECT or WITH query"),
        max_rows: z.number().int().min(1).max(1000).default(200),
        response_format: z.enum(["json", "markdown"]).default("markdown"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, max_rows, response_format }) => {
      let result: Awaited<ReturnType<typeof runQuery>>;
      try {
        result = await runQuery(ctx.config.dbFile, sql, { maxRows: max_rows, timeoutMs: 10_000 });
      } catch (error) {
        if (error instanceof QueryError)
          return { isError: true, content: [{ type: "text", text: error.message }] };
        throw error;
      }
      // Stay within the response size limit by returning fewer rows.
      let rows = result.rows;
      const build = (r: unknown[][]) => ({
        columns: result.columns,
        row_count: r.length,
        truncated: result.truncated || r.length < result.rows.length,
        ms: result.ms,
        rows: r,
      });
      let data = build(rows);
      let text = response_format === "json" ? JSON.stringify(data) : queryMarkdown(data);
      while (rows.length > 1 && text.length > CHARACTER_LIMIT) {
        rows = rows.slice(0, Math.ceil(rows.length / 2));
        data = build(rows);
        text = response_format === "json" ? JSON.stringify(data) : queryMarkdown(data);
      }
      return response_format === "json"
        ? { content: [{ type: "text", text }], structuredContent: data }
        : { content: [{ type: "text", text }] };
    },
  );

  // ---- schema resource and prompts ----
  server.registerResource(
    "garmin-schema",
    "garmin://schema",
    {
      title: "Garmin cache schema",
      description: "Views and tables available to garmin_query",
      mimeType: "text/plain",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: SCHEMA_GUIDE }] }),
  );

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly training review",
      description: "Review the past week of training and recovery against the recent trend",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review my past week of training and recovery.
1. garmin_training_summary for the last 8 weeks (by week): compare this week's volume, load, intensity distribution and form (TSB/ACWR) with the previous weeks.
2. garmin_list_activities for the last 7 days, and garmin_analyze_activity for the one or two key sessions.
3. garmin_recovery_trends for the last 4 weeks: HRV, resting HR and sleep against my baseline, and any flagged days.
Finish with: what went well, what to watch, and a concrete suggestion for next week. Be honest about uncertainty (estimated load, short baselines).`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "activity_deep_dive",
    {
      title: "Activity deep dive",
      description: "Analyze one activity in depth: pacing, intervals, heart rate, power and efficiency",
      argsSchema: z.object({ activity_id: z.string().describe("Garmin activity ID") }),
    },
    async ({ activity_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Do a deep dive into Garmin activity ${activity_id}.
1. garmin_get_activity for the overview, garmin_get_activity_laps for splits and intervals.
2. garmin_analyze_activity for zones, decoupling, best efforts and intervals.
3. Use garmin_get_activity_streams on the most interesting part (e.g. the work intervals or the last third) to look at heart rate drift and pacing.
4. Find 2–3 similar earlier sessions with garmin_list_activities and compare with garmin_compare_activities.
Explain what the session says about my fitness, pacing and execution, in plain language.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "recovery_check",
    {
      title: "Recovery check",
      description:
        "Should I train hard today? A readiness check from sleep, HRV, resting HR, Body Battery and recent load",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `How recovered am I today, and how hard should I train?
1. garmin_recovery_trends for the last 4 weeks (status, flags, form).
2. garmin_get_daily_health for the last 7 days, and garmin_get_sleep for last night.
3. garmin_get_intraday for today (Body Battery and heart rate so far).
Give a clear recommendation (rest, easy, moderate or hard) with the two or three reasons that matter most.`,
          },
        },
      ],
    }),
  );
}

// ---- shared ----

async function analyzeOne(
  ctx: AppContext,
  activityId: number,
  ftpOverride: number | undefined,
  signal: AbortSignal,
) {
  const parsed = await ctx.fit.getParsed(activityId, signal);
  const session =
    parsed.sessionIndex !== null ? parsed.summary.sessions[parsed.sessionIndex] : parsed.summary.sessions[0];
  const ref = ctx.store.getActivityRef(activityId);
  const family = toFamily(
    parsed.sessionIndex !== null ? (session?.sport ?? null) : (ref?.type_key ?? session?.sport ?? null),
  );
  const zones = await ctx.zones.forFamily(family, signal).catch(() => null);
  const { ftp, source: ftpSource } = await resolveFtp(
    ctx,
    activityId,
    family,
    ftpOverride,
    parsed.summary.metrics.lactate_threshold_power_w,
    signal,
  );
  const analysis = analyzeActivity(parsed, {
    sessionIndex: parsed.sessionIndex,
    family,
    hrZones: zones,
    ftp,
  });
  return {
    activity_id: activityId,
    sport: session ? `${session.sport}/${session.sub_sport}` : null,
    family,
    zones_used: zones?.source ?? null,
    ftp_source: ftpSource,
    ...analysis,
  };
}

/**
 * FTP for power metrics: the explicit argument, else Garmin's cycling FTP from the activity record
 * (fetched once and cached), else Garmin's lactate threshold power from the FIT file as a proxy.
 */
async function resolveFtp(
  ctx: AppContext,
  activityId: number,
  family: Family,
  override: number | undefined,
  ltPower: number | null,
  signal: AbortSignal,
): Promise<{ ftp: number | null; source: string | null }> {
  if (override) return { ftp: override, source: "ftp_w argument" };
  if (family !== "bike") return { ftp: null, source: null };
  let cached = ctx.store.getActivityDetail(activityId);
  if (!cached) {
    try {
      const detail = await ctx.client.getActivity(activityId, signal);
      if (detail) {
        const workouts = await ctx.client.getActivityWorkouts(activityId, signal);
        const fetchedAt = new Date().toISOString();
        ctx.store.saveActivityDetail(activityId, detail, workouts, fetchedAt);
        cached = { detail, workouts, fetched_at: fetchedAt };
      }
    } catch {
      // Power metrics without FTP are still useful; carry on.
    }
  }
  const recorded = (cached?.detail.summaryDTO as { functionalThresholdPower?: number } | undefined)
    ?.functionalThresholdPower;
  if (recorded && recorded > 0) return { ftp: recorded, source: "Garmin FTP on the activity" };
  if (ltPower && ltPower > 0) return { ftp: ltPower, source: "Garmin lactate threshold power (FTP proxy)" };
  return { ftp: null, source: null };
}

function toFamily(sportOrType: string | null): Family {
  const f = sportFamily(sportOrType ?? undefined);
  return f;
}

async function loadContext(ctx: AppContext, end: CalendarDate, signal: AbortSignal) {
  const rows = loadRows(ctx.store);
  const restingHr = medianRestingHr(ctx.store, addDays(end, -365), end) ?? 50;
  const maxHr =
    (await ctx.zones.maxHr(signal).catch(() => null)) ?? Math.max(185, ...rows.map((r) => r.avg_hr ?? 0));
  const settings: LoadSettings = { restingHr, maxHr, scale: calibrateScale(rows, restingHr, maxHr) };
  const first = (rows[0]?.start_date ?? end) as CalendarDate;
  const fitness = fitnessSeries(dailyLoads(rows, settings), first, end);
  return { rows, settings, fitness };
}

function loadModel(rows: ReturnType<typeof loadRows>, settings: LoadSettings) {
  return {
    ...loadCoverage(rows, settings),
    resting_hr: settings.restingHr,
    max_hr: settings.maxHr,
    trimp_to_garmin_scale: round(settings.scale, 3),
  };
}

function efficiency(view: ReturnType<typeof fromSummarized>): number | null {
  if (!view.avg_hr) return null;
  if (view.normalized_power_w ?? view.avg_power_w)
    return round((view.normalized_power_w ?? view.avg_power_w ?? 0) / view.avg_hr, 2);
  if (view.avg_speed_mps) return round((view.avg_speed_mps * 60) / view.avg_hr, 3); // meters per minute per beat
  return null;
}

function summarizeDeep(result: ActivityAnalysis | { error: string } | undefined) {
  if (!result) return null;
  if ("error" in result) return result;
  const z = result.hr_zones;
  const share = (names: string[]) =>
    z
      ? round(
          z.filter((x) => names.some((n) => x.zone.startsWith(n))).reduce((a, x) => a + x.pct, 0),
          0,
        )
      : null;
  return {
    decoupling_pct: result.decoupling?.decoupling_pct ?? null,
    hr_low_pct: share(["Z0", "Z1", "Z2"]),
    hr_moderate_pct: share(["Z3"]),
    hr_high_pct: share(["Z4", "Z5"]),
    best_20min_power_w: result.best_power.find((b) => b.window_s === 1200)?.watts ?? null,
    normalized_power_w: result.power?.normalized_w ?? null,
    fastest: result.fastest.slice(0, 3),
    trimp_edwards: result.trimp_edwards,
  };
}

function compactDays<T extends { days: object[] }>(data: T): Record<string, unknown> {
  return {
    ...data,
    days: data.days.map((d) =>
      Object.fromEntries(
        Object.entries(d).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)),
      ),
    ),
  };
}

/** Renders items, dropping the oldest ones until the output fits the response size limit. */
function fitToLimit<T>(items: T[], build: (kept: T[], dropped: boolean) => ToolResult): ToolResult {
  let kept = items;
  let result = build(kept, false);
  while (kept.length > 1 && (result.content[0]?.text.length ?? 0) > CHARACTER_LIMIT) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4))); // drop the oldest quarter
    result = build(kept, true);
  }
  return result;
}

// ---- markdown ----

const v = (x: unknown, suffix = "") => (x === null || x === undefined ? "–" : `${x}${suffix}`);

function analysisMarkdown(r: Awaited<ReturnType<typeof analyzeOne>>): string {
  const lines = [`# Analysis of activity ${r.activity_id}${r.sport ? ` (${r.sport})` : ""}`, ""];
  lines.push(
    `Duration ${formatDuration(r.duration_s)}, ${r.samples} samples. ${r.zones_used ? `HR zones: ${r.zones_used}.` : "No HR zones available."}`,
  );
  if (r.hr_zones) {
    lines.push("", "## Time in heart rate zones", "", "| Zone | Range | Time | % |", "|---|---|---|---|");
    for (const z of r.hr_zones)
      lines.push(`| ${z.zone} | ${z.range} | ${formatDuration(z.seconds)} | ${z.pct} |`);
  }
  if (r.power) {
    const p = r.power;
    lines.push(
      "",
      "## Power",
      "",
      `Average ${v(p.avg_w, " W")}, NP ${v(p.normalized_w, " W")}, VI ${v(p.variability_index)}${p.ftp_w ? `, FTP ${p.ftp_w} W (${r.ftp_source}), IF ${v(p.intensity_factor)}, TSS ${v(p.tss)}` : " (no FTP: pass ftp_w for zones, IF and TSS)"}`,
    );
    if (r.power_zones) {
      lines.push("", "| Zone | Range | Time | % |", "|---|---|---|---|");
      for (const z of r.power_zones)
        lines.push(`| ${z.zone} | ${z.range} | ${formatDuration(z.seconds)} | ${z.pct} |`);
    }
  }
  if (r.decoupling) {
    const d = r.decoupling;
    lines.push(
      "",
      "## Aerobic decoupling",
      "",
      `${d.decoupling_pct}% (${d.metric} per heartbeat: ${d.first_half_ef} → ${d.second_half_ef}). ${d.decoupling_pct < 5 ? "Under 5%: well coupled." : "5% or more: heart rate drifted relative to output."} ${d.note}`,
    );
  }
  if (r.halves) {
    lines.push(
      "",
      `Halves by distance: ${formatDuration(r.halves.first_half_s)} / ${formatDuration(r.halves.second_half_s)} (${r.halves.split} split).`,
    );
  }
  if (r.best_power.length || r.best_hr.length || r.fastest.length) {
    lines.push("", "## Best efforts", "");
    if (r.best_power.length)
      lines.push(`Power: ${r.best_power.map((b) => `${windowLabel(b.window_s)} ${b.watts} W`).join(" · ")}`);
    if (r.best_hr.length)
      lines.push(`Heart rate: ${r.best_hr.map((b) => `${windowLabel(b.window_s)} ${b.bpm}`).join(" · ")}`);
    if (r.fastest.length)
      lines.push(
        `Fastest: ${r.fastest.map((f) => `${distanceLabel(f.meters)} ${formatDuration(f.seconds)} (${f.pace})`).join(" · ")}`,
      );
  }
  if (r.intervals) {
    const i = r.intervals;
    const avg = i.metric === "power_w" ? `${i.avg_metric} W` : paceText(r.family, i.avg_metric);
    lines.push(
      "",
      "## Intervals",
      "",
      `${i.work_laps} work laps (by ${i.detected_by}), avg ${formatDuration(i.avg_duration_s)} at ${avg}; variation ${i.consistency_cv_pct}%${i.hr_first_work_lap && i.hr_last_work_lap ? `; HR first → last ${i.hr_first_work_lap} → ${i.hr_last_work_lap}` : ""}.`,
    );
  }
  if (r.trimp_edwards !== null) lines.push("", `Edwards TRIMP: ${r.trimp_edwards}.`);
  return lines.join("\n");
}

function trainingMarkdown(
  data: {
    start_date: string;
    end_date: string;
    group_by: string;
    sport?: string;
    notes?: string[];
    load_model: ReturnType<typeof loadModel>;
  },
  periods: ReturnType<typeof trainingPeriods>,
): string {
  const m = data.load_model;
  const lines = [
    `# Training ${data.start_date} – ${data.end_date} (per ${data.group_by}${data.sport ? `, ${data.sport}` : ""})`,
    ...(data.notes ?? []).map((n) => `_${n}_`),
    "",
    "| Period | Sessions | Hours | km | ↑ m | Load | Low/Mod/High % | CTL | ATL | TSB | ACWR |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const p of periods) {
    // With little zone data the split is misleading: show it only when zones cover half the time.
    const i =
      p.intensity && p.intensity.zone_coverage_pct >= 50
        ? `${p.intensity.low_pct}/${p.intensity.moderate_pct}/${p.intensity.high_pct}`
        : "–";
    lines.push(
      `| ${p.period} | ${p.sessions} | ${p.duration_h} | ${p.distance_km} | ${p.elevation_m} | ${p.load}${p.load_estimated_pct ? ` (${p.load_estimated_pct}% est.)` : ""} | ${i} | ${v(p.ctl)} | ${v(p.atl)} | ${v(p.tsb)} | ${v(p.acwr)} |`,
    );
  }
  const sports = new Map<string, { sessions: number; hours: number; km: number; load: number }>();
  for (const p of periods) {
    for (const s of p.by_sport) {
      const t = sports.get(s.sport) ?? { sessions: 0, hours: 0, km: 0, load: 0 };
      t.sessions += s.sessions;
      t.hours += s.duration_h;
      t.km += s.distance_km;
      t.load += s.load;
      sports.set(s.sport, t);
    }
  }
  if (sports.size) {
    lines.push("", "## By sport", "", "| Sport | Sessions | Hours | km | Load |", "|---|---|---|---|---|");
    for (const [sport, t] of [...sports.entries()].sort((a, b) => b[1].hours - a[1].hours)) {
      lines.push(
        `| ${sport} | ${t.sessions} | ${round(t.hours, 1)} | ${round(t.km, 1)} | ${Math.round(t.load)} |`,
      );
    }
  }
  const patterns = periods.map((p) => p.intensity?.pattern).filter(Boolean);
  lines.push(
    "",
    `Load: ${m.garmin_pct}% of activities have Garmin's training load, ${m.estimated_pct}% estimated from heart rate (scale ${v(m.trimp_to_garmin_scale)}), ${m.missing_pct}% without load. Intensity uses Garmin's HR zone times (shown when they cover at least half the training time)${patterns.length ? `; most common pattern: ${mode(patterns as string[])}` : ""}. CTL/ATL/TSB use 42/7-day weighting of daily load.`,
  );
  return lines.join("\n");
}

function recoveryMarkdown(
  data: ReturnType<typeof recoveryAnalysis> & { start_date: string; end_date: string },
): string {
  const s = data.status;
  const l7 = s.last_7_days;
  const p28 = s.previous_28_days;
  const delta = (a: number | null, b: number | null, digits = 1) =>
    a !== null && b !== null ? ` (${a - b >= 0 ? "+" : ""}${round(a - b, digits)})` : "";
  const lines = [
    `# Recovery ${data.start_date} – ${data.end_date}`,
    "",
    "## Status: last 7 days vs previous 28",
    "",
    `- HRV: ${v(l7.hrv, " ms")} vs ${v(p28.hrv, " ms")}${delta(l7.hrv, p28.hrv)}${s.latest_hrv_status ? `, latest status ${s.latest_hrv_status}` : ""}`,
    `- Resting HR: ${v(l7.resting_hr)} vs ${v(p28.resting_hr)}${delta(l7.resting_hr, p28.resting_hr)}`,
    `- Sleep: ${v(l7.sleep_h, " h")}, score ${v(l7.sleep_score)} vs ${v(p28.sleep_h, " h")}, score ${v(p28.sleep_score)}`,
    `- Load per day: ${v(l7.load_per_day)} vs ${v(p28.load_per_day)}`,
  ];
  if (s.fitness)
    lines.push(
      `- Fitness ${s.fitness.ctl}, fatigue ${s.fitness.atl}, form ${s.fitness.tsb}, ACWR ${v(s.fitness.acwr)}`,
    );
  const flagged = data.days.filter((d) => d.flags.length);
  lines.push("", `## Flagged days (${flagged.length})`, "");
  lines.push(
    flagged.length
      ? flagged
          .slice(-15)
          .map(
            (d) =>
              `- ${d.date}: ${d.flags.join(", ")} (load the day before: ${data.days.find((x) => x.date === addDays(d.date as CalendarDate, -1))?.load ?? "–"})`,
          )
          .join("\n")
      : "None.",
  );
  const weeks = new Map<string, typeof data.days>();
  for (const d of data.days)
    weeks.set(periodStart(d.date, "week"), [...(weeks.get(periodStart(d.date, "week")) ?? []), d]);
  lines.push(
    "",
    "## Weekly averages",
    "",
    "| Week | Load/day | HRV | RHR | Sleep h | Score | BB max | Stress |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const [w, list] of weeks) {
    lines.push(
      `| ${w} | ${v(round(mean(list.map((d) => d.load)), 0))} | ${v(round(mean(list.map((d) => d.hrv)), 1))} | ${v(round(mean(list.map((d) => d.resting_hr)), 1))} | ${v(round((mean(list.map((d) => d.sleep_s)) ?? Number.NaN) / 3600, 1))} | ${v(round(mean(list.map((d) => d.sleep_score)), 0))} | ${v(round(mean(list.map((d) => d.body_battery_max)), 0))} | ${v(round(mean(list.map((d) => d.stress_avg)), 0))} |`,
    );
  }
  lines.push("", "## Correlations", "", "| Question | r | Days | Reading |", "|---|---|---|---|");
  for (const c of data.correlations) lines.push(`| ${c.question} | ${v(c.r)} | ${c.n} | ${c.reading} |`);
  lines.push(
    "",
    "Baselines are rolling 28-day averages; flags mark days more than one standard deviation off. Correlation is not causation.",
  );
  return lines.join("\n");
}

function compareMarkdown(
  items: Array<
    ReturnType<typeof fromSummarized> & {
      avg_cadence: number | null;
      efficiency_factor: number | null;
      analysis?: unknown;
    }
  >,
): string {
  const rows: Array<[string, (a: (typeof items)[number]) => unknown]> = [
    ["Date", (a) => a.start_local?.slice(0, 16)],
    ["Type", (a) => a.type],
    ["Name", (a) => a.name],
    ["Duration", (a) => formatDuration(a.duration_s)],
    ["Distance", (a) => formatKm(a.distance_m)],
    ["Pace / speed", (a) => (a.avg_speed_mps ? paceText(a.sport as Family, a.avg_speed_mps) : "–")],
    ["HR avg / max", (a) => `${v(a.avg_hr)} / ${v(a.max_hr)}`],
    ["Power avg / NP", (a) => (a.avg_power_w ? `${a.avg_power_w} / ${v(a.normalized_power_w)} W` : "–")],
    ["Cadence", (a) => (a.avg_cadence ? Math.round(a.avg_cadence) : "–")],
    ["Elevation ↑", (a) => v(a.elevation_gain_m, " m")],
    ["Training effect", (a) => (a.aerobic_te !== null ? `${a.aerobic_te} / ${v(a.anaerobic_te)}` : "–")],
    ["Training load", (a) => v(a.training_load)],
    ["Efficiency factor", (a) => v(a.efficiency_factor)],
  ];
  if (items.some((a) => a.analysis)) {
    const an = (a: (typeof items)[number]) => (a.analysis ?? {}) as Record<string, unknown>;
    rows.push(
      ["Decoupling %", (a) => v(an(a).decoupling_pct ?? an(a).error)],
      [
        "HR low/mod/high %",
        (a) => `${v(an(a).hr_low_pct)}/${v(an(a).hr_moderate_pct)}/${v(an(a).hr_high_pct)}`,
      ],
      ["Best 20 min power", (a) => v(an(a).best_20min_power_w, " W")],
    );
  }
  const header = `| | ${items.map((a) => a.id).join(" | ")} |`;
  const sep = `|---|${items.map(() => "---").join("|")}|`;
  return [
    "# Activity comparison",
    "",
    header,
    sep,
    ...rows.map(([label, fn]) => `| ${label} | ${items.map((a) => String(fn(a) ?? "–")).join(" | ")} |`),
    "",
    "Efficiency factor: NP (or average power) per heartbeat for power activities, meters per minute per beat otherwise. Compare it across similar sessions only.",
  ].join("\n");
}

function queryMarkdown(data: {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  ms: number;
}): string {
  if (data.rows.length === 0) return `No rows (${data.ms} ms).`;
  const cell = (x: unknown) =>
    x === null || x === undefined ? "" : String(x).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${data.columns.join(" | ")} |`,
    `|${data.columns.map(() => "---").join("|")}|`,
    ...data.rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
    "",
    `${data.row_count} row(s) in ${data.ms} ms${data.truncated ? "; more rows exist (raise max_rows, aggregate, or add filters)" : ""}.`,
  ].join("\n");
}

function windowLabel(s: number): string {
  return s < 60 ? `${s}s` : `${s / 60}min`;
}

function distanceLabel(m: number): string {
  if (m === 1609) return "mile";
  if (m === 21097) return "half";
  if (m === 42195) return "marathon";
  return m >= 1000 ? `${m / 1000}k` : `${m}m`;
}

function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
