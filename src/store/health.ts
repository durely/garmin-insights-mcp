// Health queries over the SQL views (daily, sleep, hrv, weight). The views are the single
// definition of each field; see migration 3 in db.ts.

import type { Store } from "./store.ts";

export type GroupBy = "day" | "week" | "month";
export type Row = Record<string, string | number | null>;

type Agg = "avg" | "sum" | "min" | "max";

/** Daily health columns and how they aggregate per week/month. "sum" columns also get a per-day average. */
const DAILY_COLUMNS: Array<{ name: string; expr: string; agg: Agg; digits?: number }> = [
  { name: "steps", expr: "d.steps", agg: "sum" },
  { name: "step_goal", expr: "d.step_goal", agg: "avg" },
  { name: "walk_distance_m", expr: "d.walk_distance_m", agg: "avg" },
  { name: "floors_up", expr: "d.floors_up", agg: "avg" },
  { name: "resting_hr", expr: "d.resting_hr", agg: "avg", digits: 1 },
  { name: "min_hr", expr: "d.min_hr", agg: "min" },
  { name: "max_hr", expr: "d.max_hr", agg: "max" },
  { name: "stress_avg", expr: "d.stress_avg", agg: "avg", digits: 1 },
  { name: "stress_max", expr: "d.stress_max", agg: "max" },
  { name: "stress_rest_pct", expr: "d.stress_rest_pct", agg: "avg", digits: 1 },
  { name: "stress_low_pct", expr: "d.stress_low_pct", agg: "avg", digits: 1 },
  { name: "stress_medium_pct", expr: "d.stress_medium_pct", agg: "avg", digits: 1 },
  { name: "stress_high_pct", expr: "d.stress_high_pct", agg: "avg", digits: 1 },
  { name: "body_battery_min", expr: "d.body_battery_min", agg: "avg", digits: 1 },
  { name: "body_battery_max", expr: "d.body_battery_max", agg: "avg", digits: 1 },
  { name: "body_battery_charged", expr: "d.body_battery_charged", agg: "avg", digits: 1 },
  { name: "body_battery_drained", expr: "d.body_battery_drained", agg: "avg", digits: 1 },
  { name: "intensity_moderate_min", expr: "d.intensity_moderate_min", agg: "sum" },
  { name: "intensity_vigorous_min", expr: "d.intensity_vigorous_min", agg: "sum" },
  { name: "calories_total", expr: "d.calories_total", agg: "avg" },
  { name: "calories_active", expr: "d.calories_active", agg: "avg" },
  { name: "respiration_avg", expr: "d.respiration_avg", agg: "avg", digits: 1 },
  { name: "hydration_ml", expr: "d.hydration_ml", agg: "avg" },
  { name: "sleep_s", expr: "s.sleep_s", agg: "avg" },
  { name: "sleep_score", expr: "s.score", agg: "avg", digits: 1 },
  { name: "hrv_last_night", expr: "h.last_night_avg", agg: "avg", digits: 1 },
];

/** Week buckets start on Monday (ISO). */
const BUCKET: Record<Exclude<GroupBy, "day">, string> = {
  week: "date(date, 'weekday 0', '-6 days')",
  month: "strftime('%Y-%m', date)",
};

/** One row per day (or per week/month): wellness summary joined with that night's sleep and HRV. */
export function dailyHealth(store: Store, start: string, end: string, groupBy: GroupBy): Row[] {
  const joined = `
    SELECT d.date, ${DAILY_COLUMNS.map((c) => `${c.expr} AS ${c.name}`).join(", ")}, h.status AS hrv_status
    FROM daily d
    LEFT JOIN sleep s ON s.date = d.date
    LEFT JOIN hrv h ON h.date = d.date
    WHERE d.date BETWEEN ? AND ?`;
  if (groupBy === "day") {
    return store.db.prepare(`${joined} ORDER BY d.date`).all(start, end) as Row[];
  }
  const aggregates = DAILY_COLUMNS.flatMap((c) => {
    const avg = `ROUND(AVG(${c.name}), ${c.digits ?? 0})`;
    if (c.agg === "sum") return [`SUM(${c.name}) AS ${c.name}_total`, `${avg} AS ${c.name}_per_day`];
    if (c.agg === "avg") return [`${avg} AS ${c.name}`];
    return [`${c.agg.toUpperCase()}(${c.name}) AS ${c.name}`];
  });
  return store.db
    .prepare(
      `WITH j AS (${joined})
       SELECT ${BUCKET[groupBy]} AS period, MIN(date) AS from_date, MAX(date) AS to_date, COUNT(*) AS days,
              ${aggregates.join(", ")}
       FROM j GROUP BY period ORDER BY period`,
    )
    .all(start, end) as Row[];
}

export function sleepNights(store: Store, start: string, end: string): Row[] {
  return store.db
    .prepare("SELECT * FROM sleep WHERE date BETWEEN ? AND ? ORDER BY date")
    .all(start, end) as Row[];
}

/** Sleep score sub-scores (qualifiers per component) for the given nights, from the raw JSON. */
export function sleepScoreDetails(
  store: Store,
  start: string,
  end: string,
): Map<string, Record<string, string>> {
  const rows = store.db
    .prepare(
      "SELECT date, json_extract(json, '$.sleepScores') AS scores FROM daily_raw WHERE domain = 'sleep' AND date BETWEEN ? AND ?",
    )
    .all(start, end) as Array<{ date: string; scores: string | null }>;
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!r.scores) continue;
    const scores = JSON.parse(r.scores) as Record<string, { qualifierKey?: string; value?: number }>;
    out.set(
      r.date,
      Object.fromEntries(
        Object.entries(scores)
          .filter(([k, v]) => k !== "overall" && v?.qualifierKey)
          .map(([k, v]) => [
            k,
            v.value !== undefined ? `${v.qualifierKey} (${v.value})` : (v.qualifierKey as string),
          ]),
      ),
    );
  }
  return out;
}

export function hrvNights(store: Store, start: string, end: string): Row[] {
  return store.db
    .prepare("SELECT * FROM hrv WHERE date BETWEEN ? AND ? ORDER BY date")
    .all(start, end) as Row[];
}

export function weighIns(store: Store, start: string, end: string): Row[] {
  return store.db
    .prepare("SELECT * FROM weight WHERE date BETWEEN ? AND ? ORDER BY date")
    .all(start, end) as Row[];
}

/** Coverage of the daily summaries, for "no data" messages. */
export function dailyCoverage(store: Store): { earliest: string | null; latest: string | null } {
  return store.db.prepare("SELECT MIN(date) AS earliest, MAX(date) AS latest FROM daily").get() as {
    earliest: string | null;
    latest: string | null;
  };
}
