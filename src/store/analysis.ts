// Queries for the analysis tools.

import type { Store } from "./store.ts";

export interface LoadRow {
  id: number;
  start_date: string;
  sport: string | null;
  type_key: string | null;
  name: string | null;
  duration_s: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  training_load: number | null;
  /** Seconds in Garmin's HR zones 1–5 (null when Garmin didn't compute them). */
  hr_z1: number | null;
  hr_z2: number | null;
  hr_z3: number | null;
  hr_z4: number | null;
  hr_z5: number | null;
}

/** Every activity except multisport parents (their legs carry the volume), oldest first. */
export function loadRows(store: Store): LoadRow[] {
  return store.db
    .prepare(
      `SELECT id, start_date, parent_type_key AS sport, type_key, name, duration_s, distance_m, elevation_gain_m,
              avg_hr, training_load,
              json_extract(raw_json, '$.hrTimeInZone_1') AS hr_z1, json_extract(raw_json, '$.hrTimeInZone_2') AS hr_z2,
              json_extract(raw_json, '$.hrTimeInZone_3') AS hr_z3, json_extract(raw_json, '$.hrTimeInZone_4') AS hr_z4,
              json_extract(raw_json, '$.hrTimeInZone_5') AS hr_z5
       FROM activity WHERE is_multisport_parent = 0 AND start_date IS NOT NULL ORDER BY start_date`,
    )
    .all() as unknown as LoadRow[];
}

/** Median daily resting heart rate over the period, for heart-rate-reserve calculations. */
export function medianRestingHr(store: Store, start: string, end: string): number | null {
  const rows = store.db
    .prepare("SELECT resting_hr FROM daily WHERE date BETWEEN ? AND ? AND resting_hr > 0 ORDER BY resting_hr")
    .all(start, end) as Array<{ resting_hr: number }>;
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)]?.resting_hr ?? null;
}

export interface RecoveryRow {
  date: string;
  resting_hr: number | null;
  hrv: number | null;
  hrv_status: string | null;
  sleep_score: number | null;
  sleep_s: number | null;
  body_battery_max: number | null;
  stress_avg: number | null;
}

export function recoveryRows(store: Store, start: string, end: string): RecoveryRow[] {
  return store.db
    .prepare(
      `SELECT d.date, d.resting_hr, h.last_night_avg AS hrv, h.status AS hrv_status, s.score AS sleep_score,
              s.sleep_s, d.body_battery_max, d.stress_avg
       FROM daily d LEFT JOIN hrv h ON h.date = d.date LEFT JOIN sleep s ON s.date = d.date
       WHERE d.date BETWEEN ? AND ? ORDER BY d.date`,
    )
    .all(start, end) as unknown as RecoveryRow[];
}

export function activityRows(store: Store, ids: number[]): Array<{ id: number; raw_json: string }> {
  const stmt = store.db.prepare("SELECT id, raw_json FROM activity WHERE id = ?");
  return ids.flatMap((id) => {
    const row = stmt.get(id) as { id: number; raw_json: string } | undefined;
    return row ? [row] : [];
  });
}
