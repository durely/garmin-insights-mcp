import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { addDays, type CalendarDate, spanDays, toCalendarDate, today } from "../../garmin/index.ts";
import {
  dailyCoverage,
  dailyHealth,
  type GroupBy,
  hrvNights,
  type Row,
  sleepNights,
  sleepScoreDetails,
  weighIns,
} from "../../store/health.ts";
import { ensureDays } from "../../sync/on-demand.ts";
import type { AppContext } from "../context.ts";
import { CHARACTER_LIMIT, compact, render, responseFormatSchema, type ToolResult } from "../format.ts";

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

export function registerHealthTools(server: McpServer, ctx: AppContext): void {
  // ---- daily health ----
  server.registerTool(
    "garmin_get_daily_health",
    {
      title: "Daily health and recovery",
      description: `Get day-by-day wellness and recovery data, from the local cache (all history).

Per day: steps (+ goal), floors, resting/min/max heart rate, stress (average, max, % of the day at rest/low/medium/high), Body Battery (min, max, charged, drained), intensity minutes (moderate, vigorous), calories (total, active), respiration, hydration, plus that night's sleep (duration, score) and HRV (last-night average, status).

group_by="week" (Monday-based) or "month" aggregates: averages per day, minimums/maximums for min_hr/max_hr/stress_max, and totals plus per-day averages for steps and intensity minutes.

Defaults to the last 14 days. Daily rows are limited to 92 days per call; use group_by="week" or "month" for longer periods (e.g. a year by week). Today's values are partial.

Examples: "How's my recovery this week?" → defaults. "Resting HR trend this year" → start_date="2026-01-01", group_by="week".`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        group_by: z.enum(["day", "week", "month"]).default("day"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, group_by, response_format }) => {
      const range = resolveRange(ctx, start_date, end_date, 14);
      if (group_by === "day" && range.days > 92) {
        throw new Error(
          `${range.days} days is too many daily rows; use group_by="week" or "month" for periods longer than 92 days.`,
        );
      }
      const note = await ensureAll(ctx, ["daily_summaries", "sleep", "hrv"]);
      const rows = dailyHealth(ctx.store, range.start, range.end, group_by as GroupBy);
      const notes = [note, range.includesToday ? "Today's values are partial." : undefined].filter(Boolean);
      return trimmed(response_format, rows, (items) => ({
        data: {
          start_date: range.start,
          end_date: range.end,
          group_by,
          ...(notes.length ? { notes } : {}),
          rows: items.map(compactRow),
        },
        markdown: () =>
          items.length === 0
            ? noData(ctx, range)
            : [
                `# Daily health ${range.start} – ${range.end}${group_by === "day" ? "" : ` (per ${group_by})`}`,
                ...notes.map((n) => `_${n}_`),
                "",
                group_by === "day" ? dailyTable(items) : groupedTable(items),
              ].join("\n"),
      }));
    },
  );

  // ---- sleep ----
  server.registerTool(
    "garmin_get_sleep",
    {
      title: "Sleep",
      description: `Get nightly sleep from the local cache: bed and wake time, total sleep, deep/light/REM/awake time, naps, sleep score with quality and Garmin's feedback, awake count, average respiration and sleep stress. JSON mode adds the sleep score's components (duration, stress, deep/light/REM %, restlessness, awake count) with Garmin's rating each.

A night belongs to the date you woke up. Defaults to the last 14 nights, at most 92 per call.`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, response_format }) => {
      const range = resolveRange(ctx, start_date, end_date, 14, 92);
      const note = await ensureAll(ctx, ["sleep"]);
      const rows = sleepNights(ctx.store, range.start, range.end);
      const details = sleepScoreDetails(ctx.store, range.start, range.end);
      return trimmed(response_format, rows, (items) => ({
        data: {
          start_date: range.start,
          end_date: range.end,
          ...(note ? { note } : {}),
          nights: items.map((r) => ({
            ...compactRow(r),
            score_components: details.get(String(r.date)) ?? {},
          })),
        },
        markdown: () =>
          items.length === 0
            ? `No sleep recorded between ${range.start} and ${range.end}.`
            : sleepTable(items, range),
      }));
    },
  );

  // ---- HRV ----
  server.registerTool(
    "garmin_get_hrv",
    {
      title: "Heart rate variability",
      description: `Get nightly HRV (heart rate variability, in ms) from the local cache: last-night average, highest 5-minute value, 7-day average, the personal baseline range (balanced low/high) and Garmin's status (BALANCED, UNBALANCED, LOW, POOR).

With readings_date, also returns that night's 5-minute HRV readings (fetched from Garmin if older than the synced detail window).

Defaults to the last 28 nights, at most 366 per call. HRV needs a compatible watch worn overnight; history starts when that began.`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        readings_date: date.optional().describe("Night (wake-up date) to include 5-minute readings for"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, readings_date, response_format }, extra) => {
      const range = resolveRange(ctx, start_date, end_date, 28, 366);
      const note = await ensureAll(ctx, ["hrv"]);
      const rows = hrvNights(ctx.store, range.start, range.end);
      let readings: { date: string; values: Array<{ time: string; hrv: number }> } | undefined;
      if (readings_date) {
        const d = toCalendarDate(readings_date);
        await ensureDays(onDemand(ctx), "hrv_readings", d, d, extra.mcpReq.signal);
        const raw = ctx.store.getDaily<{
          hrvReadings?: Array<{ hrvValue?: number; readingTimeLocal?: string }>;
        }>("hrv_readings", d, d)[0]?.data;
        readings = {
          date: d,
          values: (raw?.hrvReadings ?? [])
            .filter((r) => typeof r.hrvValue === "number" && r.readingTimeLocal)
            .map((r) => ({ time: (r.readingTimeLocal as string).slice(11, 16), hrv: r.hrvValue as number })),
        };
      }
      return trimmed(response_format, rows, (items) => ({
        data: {
          start_date: range.start,
          end_date: range.end,
          ...(note ? { note } : {}),
          nights: items.map(compactRow),
          ...(readings ? { readings } : {}),
        },
        markdown: () => hrvMarkdown(items, range, readings),
      }));
    },
  );

  // ---- intraday ----
  server.registerTool(
    "garmin_get_intraday",
    {
      title: "Intraday health data",
      description: `Get one day's health data through the day, averaged into intervals: heart rate (bpm), Body Battery (0-100), overnight HRV readings (ms) and SpO2 (pulse ox, %).

Returns per metric: min/avg/max, the day's summary values (e.g. resting HR, Body Battery charged/drained, SpO2 averages), and a columnar series (local times "HH:MM" + values). Synced for the last 150 days; older days are fetched from Garmin on demand. Garmin itself keeps intraday heart rate and HRV readings for only about 4–5 months (Body Battery longer), so older days may have just the day summary.

Defaults to today, all four metrics, 15-minute intervals. HRV and SpO2 need a compatible watch (SpO2 also needs pulse ox enabled).`,
      inputSchema: z.strictObject({
        date: date.optional().describe("Defaults to today"),
        metrics: z
          .array(z.enum(["heart_rate", "body_battery", "hrv", "spo2"]))
          .min(1)
          .default(["heart_rate", "body_battery", "hrv", "spo2"]),
        interval_min: z.number().int().min(1).max(240).default(15).describe("Minutes per point"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ date: day, metrics, interval_min, response_format }, extra) => {
      const d = day ? toCalendarDate(day) : today(ctx.config.timeZone);
      const domainOf = {
        heart_rate: "heart_rate",
        body_battery: "body_battery",
        hrv: "hrv_readings",
        spo2: "spo2",
      } as const;
      for (const m of metrics) await ensureDays(onDemand(ctx), domainOf[m], d, d, extra.mcpReq.signal);
      const out: Record<string, IntradayMetric> = {};
      for (const m of metrics) {
        const raw = ctx.store.getDaily<Record<string, unknown>>(domainOf[m], d, d)[0]?.data ?? null;
        out[m] = intraday(m, raw, interval_min, ctx.config.timeZone);
      }
      const data = { date: d, interval_min, time_zone: ctx.config.timeZone, metrics: out };
      return render(response_format, data, () => intradayMarkdown(d, out, interval_min));
    },
  );

  // ---- body composition ----
  server.registerTool(
    "garmin_get_body_composition",
    {
      title: "Weight and body composition",
      description: `Get weigh-ins from the local cache: weight (kg), BMI, body fat %, body water %, muscle and bone mass (kg), visceral fat, and where each came from (scale, manual, linked app). Includes the change over the period and the weight goal if one is set.

Only days with a weigh-in appear. Defaults to the last 365 days.`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, response_format }, extra) => {
      const range = resolveRange(ctx, start_date, end_date, 365);
      const note = await ensureAll(ctx, ["weight"]);
      const rows = weighIns(ctx.store, range.start, range.end);
      const goals = await ctx.client
        .getWeightGoals(range.start, range.end, extra.mcpReq.signal)
        .catch(() => null);
      const goalWeights = (goals?.userGoals ?? [])
        .map((g) => (g as { goalValue?: number }).goalValue)
        .filter((v): v is number => typeof v === "number");
      const weights = rows.map((r) => r.weight_kg).filter((v): v is number => typeof v === "number");
      const summary = weights.length
        ? {
            first_kg: weights[0],
            last_kg: weights.at(-1),
            change_kg: round2((weights.at(-1) as number) - (weights[0] as number)),
            min_kg: Math.min(...weights),
            max_kg: Math.max(...weights),
            weigh_ins: weights.length,
            ...(goalWeights.length ? { goal_kg: round2((goalWeights.at(-1) as number) / 1000) } : {}),
          }
        : null;
      return trimmed(response_format, rows, (items) => ({
        data: {
          start_date: range.start,
          end_date: range.end,
          ...(note ? { note } : {}),
          summary,
          weigh_ins: items.map(compactRow),
        },
        markdown: () => weightMarkdown(items, range, summary),
      }));
    },
  );

  // ---- nutrition ----
  server.registerTool(
    "garmin_get_nutrition",
    {
      title: "Nutrition and hydration",
      description: `Get food logged in Garmin Connect (or a linked app such as MyFitnessPal) per day: calories, carbs, protein and fat against the day's goals, and meals; plus hydration (ml) from the daily summary.

Food logs are fetched from Garmin on demand and cached. Defaults to the last 7 days, at most 31 per call.`,
      inputSchema: z.strictObject({
        start_date: date.optional(),
        end_date: date.optional().describe("Defaults to today"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, response_format }, extra) => {
      const range = resolveRange(ctx, start_date, end_date, 7, 31);
      await ensureDays(onDemand(ctx), "food_logs", range.start, range.end, extra.mcpReq.signal);
      await ensureAll(ctx, ["daily_summaries"]);
      const logs = new Map(
        ctx.store
          .getDaily<Record<string, unknown>>("food_logs", range.start, range.end)
          .map((r) => [r.date, r.data]),
      );
      const hydration = new Map(
        dailyHealth(ctx.store, range.start, range.end, "day").map((r) => [r.date, r.hydration_ml]),
      );
      const days: NutritionDay[] = [];
      for (let d = range.start; spanDays(d, range.end) >= 1; d = addDays(d, 1)) {
        days.push(nutritionDay(d, logs.get(d) ?? null, hydration.get(d) ?? null));
      }
      const logged = days.filter((x) => x.calories !== null || x.meals.length > 0);
      const data = {
        start_date: range.start,
        end_date: range.end,
        days_with_food_logged: logged.length,
        days,
      };
      return render(response_format, data, () => nutritionMarkdown(days, range, logged.length));
    },
  );

  // ---- women's health ----
  server.registerTool(
    "garmin_get_womens_health",
    {
      title: "Menstrual cycle",
      description: `Get menstrual cycle tracking from Garmin Connect for a date: cycle day, current phase and days until the next, period and cycle length, predicted next cycle, fertile window and ovulation date, plus that day's logged symptoms and notes (day view). Fetched live from Garmin.

Returns a clear "not tracked" message when cycle tracking isn't set up. Defaults to today.`,
      inputSchema: z.strictObject({
        date: date.optional().describe("Defaults to today"),
        response_format: responseFormatSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ date: day, response_format }, extra) => {
      const todayLocal = today(ctx.config.timeZone);
      const d = day ? toCalendarDate(day) : todayLocal;
      const summary = await ctx.client.getMenstrualCycleSummary(d, extra.mcpReq.signal);
      const dayView = await ctx.client.getMenstrualCycleDayView(d, todayLocal, extra.mcpReq.signal);
      if (!summary && !dayView) {
        return {
          content: [
            {
              type: "text",
              text: `No menstrual cycle data for ${d}: cycle tracking isn't set up in Garmin Connect.`,
            },
          ],
        };
      }
      const data = { date: d, summary: summary ?? null, day_view: dayView ?? null };
      return render(response_format, data, () => {
        const s = (summary ?? {}) as Record<string, unknown>;
        const fields: Array<[string, unknown]> = [
          ["Cycle day", s.dayInCycle],
          ["Phase", s.currentPhase],
          ["Days until next phase", s.daysUntilNextPhase],
          ["Period length", s.periodLength],
          ["Predicted cycle length", s.predictedCycleLength],
          ["Fertile window starts", s.fertileWindowStart],
          ["Predicted ovulation", s.predictedOvulationDate],
          ["Cycle start", s.startDate],
        ];
        return [
          `# Menstrual cycle on ${d}`,
          "",
          ...fields.filter(([, v]) => v != null).map(([k, v]) => `- ${k}: ${v}`),
        ].join("\n");
      });
    },
  );
}

// ---- helpers ----

function onDemand(ctx: AppContext) {
  return { store: ctx.store, client: ctx.client, timeZone: ctx.config.timeZone };
}

interface Range {
  start: CalendarDate;
  end: CalendarDate;
  days: number;
  includesToday: boolean;
}

function resolveRange(
  ctx: AppContext,
  start: string | undefined,
  end: string | undefined,
  defaultDays: number,
  maxDays?: number,
): Range {
  const todayLocal = today(ctx.config.timeZone);
  const e = end ? toCalendarDate(end) : todayLocal;
  const s = start ? toCalendarDate(start) : addDays(e, -(defaultDays - 1));
  const days = spanDays(s, e);
  if (days < 1) throw new Error(`start_date ${s} is after end_date ${e}.`);
  if (maxDays && days > maxDays)
    throw new Error(`At most ${maxDays} days per call; ${s}..${e} is ${days} days.`);
  return { start: s, end: e, days, includesToday: s <= todayLocal && todayLocal <= e };
}

/** Makes sure the domains are synced (the first sync is started and awaited if needed). */
async function ensureAll(ctx: AppContext, domains: string[]): Promise<string | undefined> {
  let note: string | undefined;
  for (const d of domains) note = (await ctx.freshness.ensure(d)).note ?? note;
  return note;
}

function compactRow(row: Row): Row {
  return compact(row) as Row;
}

/** Renders rows, dropping the oldest ones if the output would exceed the size limit. */
function trimmed(
  format: "markdown" | "json",
  rows: Row[],
  build: (items: Row[]) => { data: Record<string, unknown>; markdown: () => string },
): ToolResult {
  let items = rows;
  let { data, markdown } = build(items);
  let result = render(format, data, markdown);
  while (items.length > 1 && (result.content[0]?.text.length ?? 0) > CHARACTER_LIMIT) {
    items = items.slice(Math.floor(items.length / 2)); // keep the most recent half
    ({ data, markdown } = build(items));
    result = render(
      format,
      {
        ...data,
        truncated: `Only the most recent ${items.length} rows fit; narrow the date range for older ones.`,
      },
      markdown,
    );
  }
  return result;
}

function noData(ctx: AppContext, range: Range): string {
  const c = dailyCoverage(ctx.store);
  return `No daily health data between ${range.start} and ${range.end}.${c.earliest ? ` The cache covers ${c.earliest} to ${c.latest}.` : ""}`;
}

const v = (x: unknown, suffix = "") => (x === null || x === undefined ? "–" : `${x}${suffix}`);
/** Hours and minutes, always as h:mm (48 minutes is "0:48"). */
const hm = (s: unknown) => {
  if (typeof s !== "number") return "–";
  const minutes = Math.round(s / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
};
const round2 = (x: number) => Math.round(x * 100) / 100;

function dailyTable(rows: Row[]): string {
  const lines = [
    "| Date | Steps | RHR | Stress | Body Battery | Sleep | Score | HRV | Intensity min | Active kcal |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.date} | ${v(r.steps)} | ${v(r.resting_hr)} | ${v(r.stress_avg)} | ${v(r.body_battery_min)}–${v(r.body_battery_max)} | ${hm(r.sleep_s)} | ${v(r.sleep_score)} | ${v(r.hrv_last_night)}${r.hrv_status ? ` ${String(r.hrv_status).toLowerCase()}` : ""} | ${v(r.intensity_moderate_min)}/${v(r.intensity_vigorous_min)} | ${v(r.calories_active)} |`,
    );
  }
  lines.push("", "Intensity minutes are moderate/vigorous. Stress is Garmin's 0–100 daily average.");
  return lines.join("\n");
}

function groupedTable(rows: Row[]): string {
  const lines = [
    "| Period | Days | Steps/day | RHR | Stress | Body Battery max | Sleep | Score | HRV | Intensity min (total) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const intensity =
      typeof r.intensity_moderate_min_total === "number" || typeof r.intensity_vigorous_min_total === "number"
        ? `${v(r.intensity_moderate_min_total)}/${v(r.intensity_vigorous_min_total)}`
        : "–";
    lines.push(
      `| ${r.period} | ${r.days} | ${v(r.steps_per_day)} | ${v(r.resting_hr)} | ${v(r.stress_avg)} | ${v(r.body_battery_max)} | ${hm(r.sleep_s)} | ${v(r.sleep_score)} | ${v(r.hrv_last_night)} | ${intensity} |`,
    );
  }
  lines.push(
    "",
    "Values are per-day averages over the period; intensity minutes are moderate/vigorous totals.",
  );
  return lines.join("\n");
}

function sleepTable(rows: Row[], range: Range): string {
  const lines = [
    `# Sleep ${range.start} – ${range.end}`,
    "",
    "| Night of | Bed → wake | Sleep | Deep | Light | REM | Awake | Score | Feedback |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const bed = typeof r.start_local === "string" ? r.start_local.slice(11, 16) : "–";
    const wake = typeof r.end_local === "string" ? r.end_local.slice(11, 16) : "–";
    lines.push(
      `| ${r.date} | ${bed} → ${wake} | ${hm(r.sleep_s)} | ${hm(r.deep_s)} | ${hm(r.light_s)} | ${hm(r.rem_s)} | ${hm(r.awake_s)} | ${v(r.score)} ${r.quality ? String(r.quality).toLowerCase() : ""} | ${v(r.feedback)} |`,
    );
  }
  const scored = rows.map((r) => r.score).filter((x): x is number => typeof x === "number");
  const slept = rows.map((r) => r.sleep_s).filter((x): x is number => typeof x === "number");
  if (scored.length) {
    lines.push(
      "",
      `Average: ${hm(slept.reduce((a, b) => a + b, 0) / slept.length)} sleep, score ${(scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(0)} over ${rows.length} nights.`,
    );
  }
  return lines.join("\n");
}

function hrvMarkdown(
  rows: Row[],
  range: Range,
  readings?: { date: string; values: Array<{ time: string; hrv: number }> },
): string {
  const lines = [`# HRV ${range.start} – ${range.end}`, ""];
  if (rows.length === 0) lines.push("No HRV data in this period.");
  else {
    lines.push(
      "| Night of | Last night | 5-min high | 7-day avg | Baseline | Status |",
      "|---|---|---|---|---|---|",
    );
    for (const r of rows) {
      lines.push(
        `| ${r.date} | ${v(r.last_night_avg, " ms")} | ${v(r.last_night_5min_high)} | ${v(r.weekly_avg)} | ${v(r.baseline_low)}–${v(r.baseline_high)} | ${v(r.status)} |`,
      );
    }
  }
  if (readings) {
    lines.push("", `## Readings, night of ${readings.date}`, "");
    lines.push(
      readings.values.length
        ? readings.values.map((x) => `${x.time} ${x.hrv}`).join(" · ")
        : "No readings for that night.",
    );
  }
  return lines.join("\n");
}

interface IntradayMetric {
  available: boolean;
  summary: Record<string, unknown>;
  stats: { min: number | null; avg: number | null; max: number | null };
  times: string[];
  values: Array<number | null>;
}

/** Turns a raw per-day record into a downsampled series with local "HH:MM" labels. */
function intraday(
  metric: string,
  raw: Record<string, unknown> | null,
  intervalMin: number,
  timeZone: string,
): IntradayMetric {
  const points: Array<[number, number]> = []; // [epoch ms UTC, value]
  let summary: Record<string, unknown> = {};
  const pairs = (key: string, valueIndex = 1) => {
    const list = raw?.[key];
    if (!Array.isArray(list)) return;
    for (const p of list as unknown[][]) {
      if (typeof p[0] === "number" && typeof p[valueIndex] === "number") {
        points.push([p[0], p[valueIndex] as number]);
      }
    }
  };
  if (metric === "heart_rate") {
    pairs("heartRateValues");
    summary = compact({
      resting_hr: raw?.restingHeartRate,
      min_hr: raw?.minHeartRate,
      max_hr: raw?.maxHeartRate,
      resting_hr_7d_avg: raw?.lastSevenDaysAvgRestingHeartRate,
    });
  } else if (metric === "body_battery") {
    pairs("bodyBatteryValuesArray");
    summary = compact({ charged: raw?.charged, drained: raw?.drained });
  } else if (metric === "hrv") {
    for (const r of (raw?.hrvReadings as Array<{ hrvValue?: number; readingTimeGMT?: string }> | undefined) ??
      []) {
      const t = r.readingTimeGMT ? Date.parse(`${r.readingTimeGMT}Z`) : Number.NaN;
      if (typeof r.hrvValue === "number" && !Number.isNaN(t)) points.push([t, r.hrvValue]);
    }
    const s = (raw?.hrvSummary ?? {}) as Record<string, unknown>;
    summary = compact({ last_night_avg: s.lastNightAvg, status: s.status, weekly_avg: s.weeklyAvg });
  } else if (metric === "spo2") {
    pairs("spO2SingleValues");
    if (points.length === 0) pairs("spO2HourlyAverages");
    summary = compact({
      average: raw?.averageSpO2,
      lowest: raw?.lowestSpO2,
      sleep_average: raw?.avgSleepSpO2,
      last_7d_average: raw?.lastSevenDaysAvgSpO2,
    });
  }
  points.sort((a, b) => a[0] - b[0]);

  const bucketMs = intervalMin * 60_000;
  const buckets = new Map<number, number[]>();
  for (const [t, value] of points) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    const list = buckets.get(b) ?? [];
    list.push(value);
    buckets.set(b, list);
  }
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const times: string[] = [];
  const values: number[] = [];
  for (const [b, list] of buckets) {
    times.push(fmt.format(new Date(b)));
    values.push(Math.round(list.reduce((a, x) => a + x, 0) / list.length));
  }
  const all = points.map((p) => p[1]);
  return {
    available: all.length > 0,
    summary,
    stats: {
      min: all.length ? Math.min(...all) : null,
      avg: all.length ? Math.round((all.reduce((a, x) => a + x, 0) / all.length) * 10) / 10 : null,
      max: all.length ? Math.max(...all) : null,
    },
    times,
    values,
  };
}

function intradayMarkdown(d: string, metrics: Record<string, IntradayMetric>, intervalMin: number): string {
  const lines = [`# Intraday ${d} (${intervalMin}-minute averages)`];
  const labels: Record<string, string> = {
    heart_rate: "Heart rate (bpm)",
    body_battery: "Body Battery",
    hrv: "HRV (ms)",
    spo2: "SpO2 (%)",
  };
  for (const [name, m] of Object.entries(metrics)) {
    lines.push("", `## ${labels[name] ?? name}`, "");
    if (!m.available) {
      const daySummary = Object.entries(m.summary).map(([k, x]) => `${k.replace(/_/g, " ")} ${x}`);
      lines.push(
        name === "spo2"
          ? "No SpO2 readings (pulse ox may be off on the watch)."
          : daySummary.length
            ? `No readings through the day: Garmin keeps intraday ${name === "hrv" ? "HRV readings" : "heart rate"} for only about 4–5 months. Day summary: ${daySummary.join(" · ")}.`
            : "No data for this day.",
      );
      continue;
    }
    const summary = Object.entries(m.summary).map(([k, x]) => `${k.replace(/_/g, " ")} ${x}`);
    lines.push(
      `min ${m.stats.min} · avg ${m.stats.avg} · max ${m.stats.max}${summary.length ? ` · ${summary.join(" · ")}` : ""}`,
    );
    lines.push("", m.times.map((t, i) => `${t} ${m.values[i]}`).join(" · "));
  }
  return lines.join("\n");
}

function weightMarkdown(rows: Row[], range: Range, summary: Record<string, unknown> | null): string {
  const lines = [`# Weight ${range.start} – ${range.end}`, ""];
  if (!summary) return [...lines, "No weigh-ins in this period."].join("\n");
  lines.push(
    `${summary.weigh_ins} weigh-ins: ${summary.first_kg} → ${summary.last_kg} kg (${Number(summary.change_kg) >= 0 ? "+" : ""}${summary.change_kg} kg), range ${summary.min_kg}–${summary.max_kg} kg${summary.goal_kg ? `, goal ${summary.goal_kg} kg` : ""}.`,
    "",
  );
  const hasComposition = rows.some((r) => r.body_fat_pct !== null && r.body_fat_pct !== undefined);
  lines.push(
    `| Date | Weight (kg) |${hasComposition ? " Body fat % | Muscle kg | Water % |" : ""} Source |`,
    `|---|---|${hasComposition ? "---|---|---|" : ""}---|`,
  );
  for (const r of rows) {
    lines.push(
      `| ${r.date} | ${v(r.weight_kg)} |${hasComposition ? ` ${v(r.body_fat_pct)} | ${v(r.muscle_mass_kg)} | ${v(r.body_water_pct)} |` : ""} ${v(r.source)} |`,
    );
  }
  return lines.join("\n");
}

interface NutritionDay {
  date: string;
  calories: number | null;
  calorie_goal: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  meals: Array<{ meal: string; calories: number | null; foods: number }>;
  hydration_ml: number | null;
}

function nutritionDay(d: string, raw: Record<string, unknown> | null, hydration: unknown): NutritionDay {
  const content = (raw?.dailyNutritionContent ?? {}) as Record<string, unknown>;
  const goals = (raw?.dailyNutritionGoals ?? {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" ? x : null);
  const meals = ((raw?.mealDetails as Array<Record<string, unknown>> | undefined) ?? []).map((m) => {
    const meal = m.meal as Record<string, unknown> | string | undefined;
    const name =
      typeof meal === "string" ? meal : String(meal?.mealName ?? meal?.name ?? meal?.mealType ?? "meal");
    return {
      meal: name,
      calories: num((m.mealNutritionContent as Record<string, unknown> | undefined)?.calories),
      foods: Array.isArray(m.loggedFoods) ? m.loggedFoods.length : 0,
    };
  });
  return {
    date: d,
    calories: num(content.calories),
    calorie_goal: num(goals.adjustedCalories) ?? num(goals.calories),
    carbs_g: num(content.carbs),
    protein_g: num(content.protein),
    fat_g: num(content.fat),
    meals,
    hydration_ml: num(hydration),
  };
}

function nutritionMarkdown(days: NutritionDay[], range: Range, logged: number): string {
  const lines = [`# Nutrition ${range.start} – ${range.end}`, ""];
  if (logged === 0)
    lines.push("No food logged in this period (Garmin Connect or a linked app like MyFitnessPal).", "");
  lines.push(
    "| Date | kcal (goal) | Carbs g | Protein g | Fat g | Meals | Water ml |",
    "|---|---|---|---|---|---|---|",
  );
  for (const d of days) {
    lines.push(
      `| ${d.date} | ${v(d.calories)} (${v(d.calorie_goal)}) | ${v(d.carbs_g)} | ${v(d.protein_g)} | ${v(d.fat_g)} | ${d.meals.length || "–"} | ${v(d.hydration_ml)} |`,
    );
  }
  return lines.join("\n");
}
