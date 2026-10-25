// Read-only SQL over the local cache, for free-form analysis by the model.
// Safety: a separate read-only connection (writes, PRAGMA writes and extensions fail), only one
// statement starting with SELECT or WITH (no ATTACH of other files), a row cap, and a timeout
// enforced by running the query in a worker thread that is terminated when it takes too long.

import { Worker } from "node:worker_threads";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  ms: number;
}

export class QueryError extends Error {}

/** Strips comments and string literals, so keyword and semicolon checks only see SQL structure. */
function structureOf(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateQuery(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const structure = structureOf(trimmed).trim();
  if (!/^(select|with)\b/i.test(structure)) {
    throw new QueryError("Only read queries are allowed: the statement must start with SELECT or WITH.");
  }
  if (structure.includes(";"))
    throw new QueryError("Send one statement at a time (no ';' between statements).");
  return trimmed;
}

export async function runQuery(
  file: string,
  sql: string,
  options: { maxRows: number; timeoutMs: number },
): Promise<QueryResult> {
  const statement = validateQuery(sql);
  const started = Date.now();
  // Development runs TypeScript directly; the built package runs the compiled worker.
  const workerFile = new URL(
    import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
    import.meta.url,
  );
  const worker = new Worker(workerFile, { workerData: { file, sql: statement, maxRows: options.maxRows } });
  return new Promise<QueryResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new QueryError(
          `The query took longer than ${options.timeoutMs / 1000} s and was stopped. Add filters or a LIMIT.`,
        ),
      );
    }, options.timeoutMs);
    worker.once(
      "message",
      (msg: { ok: boolean; columns?: string[]; rows?: unknown[][]; truncated?: boolean; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.ok) {
          resolve({
            columns: msg.columns ?? [],
            rows: msg.rows ?? [],
            truncated: msg.truncated ?? false,
            ms: Date.now() - started,
          });
        } else {
          reject(new QueryError(`SQL error: ${msg.error}`));
        }
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(new QueryError(`Query failed: ${error.message}`));
    });
  });
}

/** Describes the queryable views and tables, for the tool description and the schema resource. */
export const SCHEMA_GUIDE = `Views (one row per item; use these first):
- activities(id, parent_id, is_multisport_parent, type_key, sport, name, start_local, start_date, duration_s, moving_s, distance_m, elevation_gain_m, avg_speed_mps, avg_hr, max_hr, avg_power_w, norm_power_w, calories, aerobic_te, anaerobic_te, training_load, tss, vo2max)
  sport = Garmin parent type (running, cycling, swimming, walking, ...); type_key = exact type (road_biking, virtual_ride, lap_swimming, ...). Multisport: parent rows have is_multisport_parent=1, legs have parent_id; to count volume use is_multisport_parent = 0.
- daily(date, steps, step_goal, walk_distance_m, floors_up, resting_hr, min_hr, max_hr, stress_avg, stress_max, stress_rest_pct, stress_low_pct, stress_medium_pct, stress_high_pct, body_battery_min, body_battery_max, body_battery_charged, body_battery_drained, intensity_moderate_min, intensity_vigorous_min, calories_total, calories_active, respiration_avg, hydration_ml)
- sleep(date, start_local, end_local, sleep_s, deep_s, light_s, rem_s, awake_s, nap_s, score, quality, feedback, awake_count, respiration_avg, sleep_stress_avg)  -- date = the morning you woke up
- hrv(date, last_night_avg, last_night_5min_high, weekly_avg, baseline_low, baseline_high, status)
- weight(date, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg, visceral_fat, source, entries)
Raw JSON (for fields not in the views, via json_extract):
- activity(id, ..., raw_json)  -- Garmin's full activity summary, e.g. json_extract(raw_json, '$.maxAvgPower_1200'), '$.hrTimeInZone_2', '$.fastestSplit_5000', '$.avgStrideLength'
- daily_raw(domain, date, json)  -- domains: daily_summaries, sleep, hrv, weight, body_battery, hrv_readings, heart_rate, spo2, food_logs
Dates are 'yyyy-MM-dd' text in the user's local calendar; durations in seconds, distances in meters, speeds in m/s.
SQLite dialect: strftime('%Y-%W', date) for weeks, date(date, '-7 days'), window functions (AVG(x) OVER (ORDER BY date ROWS 6 PRECEDING)) are supported.`;
