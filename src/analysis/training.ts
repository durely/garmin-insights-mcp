// Training volume, intensity distribution and load trend per week/month (pure functions).

import { addDays, type CalendarDate } from "../garmin/index.ts";
import type { LoadRow, RecoveryRow } from "../store/analysis.ts";
import { activityLoad, acwr, type FitnessDay, type LoadSettings } from "./load.ts";
import { correlationStrength, mean, pearson, round, stdev } from "./stats.ts";

export type Period = "week" | "month";

/** Monday of the ISO week, or the first of the month. */
export function periodStart(date: string, period: Period): string {
  if (period === "month") return `${date.slice(0, 7)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date as CalendarDate, -weekday);
}

export interface Intensity {
  low_pct: number;
  moderate_pct: number;
  high_pct: number;
  /** Share of training time that had zone data (Garmin only computes zones for recent activities). */
  zone_coverage_pct: number;
  pattern: string;
}

export interface TrainingPeriod {
  period: string;
  sessions: number;
  duration_h: number;
  distance_km: number;
  elevation_m: number;
  load: number;
  load_estimated_pct: number;
  intensity: Intensity | null;
  by_sport: Array<{ sport: string; sessions: number; duration_h: number; distance_km: number; load: number }>;
  /** Fitness/fatigue/form at the end of the period. */
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  acwr: number | null;
}

/** Daily load totals (all sports) for the fitness trend. */
export function dailyLoads(rows: LoadRow[], settings: LoadSettings): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const { load } = activityLoad(r, settings);
    if (load !== null) out.set(r.start_date, (out.get(r.start_date) ?? 0) + load);
  }
  return out;
}

export function loadCoverage(rows: LoadRow[], settings: LoadSettings) {
  const counts = { garmin: 0, estimated: 0, none: 0 };
  for (const r of rows) counts[activityLoad(r, settings).source]++;
  const total = rows.length || 1;
  return {
    garmin_pct: round((counts.garmin / total) * 100, 0),
    estimated_pct: round((counts.estimated / total) * 100, 0),
    missing_pct: round((counts.none / total) * 100, 0),
  };
}

export function trainingPeriods(
  rows: LoadRow[],
  settings: LoadSettings,
  options: { start: string; end: string; period: Period; sport?: string; fitness: FitnessDay[] },
): TrainingPeriod[] {
  const selected = rows.filter(
    (r) =>
      r.start_date >= options.start &&
      r.start_date <= options.end &&
      (!options.sport || r.sport === options.sport || r.type_key === options.sport),
  );
  const byPeriod = new Map<string, LoadRow[]>();
  // Every period in the range appears, also those without training.
  for (let d = options.start; d <= options.end; d = addDays(d as CalendarDate, 1)) {
    byPeriod.set(periodStart(d, options.period), byPeriod.get(periodStart(d, options.period)) ?? []);
  }
  for (const r of selected) byPeriod.get(periodStart(r.start_date, options.period))?.push(r);
  const fitnessByDate = new Map(options.fitness.map((f) => [f.date, f]));

  return [...byPeriod.entries()].map(([period, list]) => {
    let load = 0;
    let estimated = 0;
    const sports = new Map<string, { sessions: number; duration: number; distance: number; load: number }>();
    for (const r of list) {
      const l = activityLoad(r, settings);
      load += l.load ?? 0;
      if (l.source === "estimated") estimated += l.load ?? 0;
      const key = r.sport ?? "other";
      const s = sports.get(key) ?? { sessions: 0, duration: 0, distance: 0, load: 0 };
      s.sessions++;
      s.duration += r.duration_s ?? 0;
      s.distance += r.distance_m ?? 0;
      s.load += l.load ?? 0;
      sports.set(key, s);
    }
    const periodEnd = minDate(
      options.period === "week" ? addDays(period as CalendarDate, 6) : lastDayOfMonth(period),
      options.end,
    );
    const f = fitnessByDate.get(periodEnd);
    return {
      period,
      sessions: list.length,
      duration_h: round(list.reduce((a, r) => a + (r.duration_s ?? 0), 0) / 3600, 1) ?? 0,
      distance_km: round(list.reduce((a, r) => a + (r.distance_m ?? 0), 0) / 1000, 1) ?? 0,
      elevation_m: Math.round(list.reduce((a, r) => a + (r.elevation_gain_m ?? 0), 0)),
      load: Math.round(load),
      load_estimated_pct: load ? (round((estimated / load) * 100, 0) ?? 0) : 0,
      intensity: intensityOf(list),
      by_sport: [...sports.entries()]
        .map(([sport, s]) => ({
          sport,
          sessions: s.sessions,
          duration_h: round(s.duration / 3600, 1) ?? 0,
          distance_km: round(s.distance / 1000, 1) ?? 0,
          load: Math.round(s.load),
        }))
        .sort((a, b) => b.duration_h - a.duration_h),
      ctl: f?.ctl ?? null,
      atl: f?.atl ?? null,
      tsb: f?.tsb ?? null,
      acwr: acwr(f),
    };
  });
}

/** Share of time in low (zones 1–2), moderate (3) and high (4–5) intensity, from Garmin's HR zone times. */
export function intensityOf(rows: LoadRow[]): Intensity | null {
  let low = 0;
  let moderate = 0;
  let high = 0;
  let total = 0;
  for (const r of rows) {
    total += r.duration_s ?? 0;
    if (r.hr_z1 === null && r.hr_z2 === null && r.hr_z3 === null) continue;
    low += (r.hr_z1 ?? 0) + (r.hr_z2 ?? 0);
    moderate += r.hr_z3 ?? 0;
    high += (r.hr_z4 ?? 0) + (r.hr_z5 ?? 0);
  }
  const zoned = low + moderate + high;
  if (zoned === 0) return null;
  const pct = (x: number) => round((x / zoned) * 100, 0) ?? 0;
  const [l, m, h] = [pct(low), pct(moderate), pct(high)];
  const pattern =
    l >= 75 && h > m
      ? "polarized"
      : l >= 70 && m >= h
        ? "pyramidal"
        : m + h >= 40
          ? "threshold-heavy"
          : "mixed";
  return {
    low_pct: l,
    moderate_pct: m,
    high_pct: h,
    zone_coverage_pct: total ? Math.min(100, round((zoned / total) * 100, 0) ?? 0) : 0,
    pattern,
  };
}

function lastDayOfMonth(firstOfMonth: string): string {
  const d = new Date(`${firstOfMonth}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

// ---- recovery ----

export interface RecoveryDay extends RecoveryRow {
  load: number;
  hrv_baseline: number | null;
  rhr_baseline: number | null;
  flags: string[];
}

export interface Correlation {
  question: string;
  r: number | null;
  n: number;
  reading: string;
}

const BASELINE_DAYS = 28;

/**
 * Daily recovery markers with personal 28-day baselines and flags, plus simple correlations
 * between the previous day's training load and the next morning's markers.
 * `rows` must start BASELINE_DAYS before `start` so the first days have a baseline.
 */
export function recoveryAnalysis(
  rows: RecoveryRow[],
  dailyLoad: Map<string, number>,
  fitness: FitnessDay[],
  start: string,
) {
  const days: RecoveryDay[] = rows.map((r, i) => {
    const window = rows.slice(Math.max(0, i - BASELINE_DAYS), i);
    const hrvValues = window.map((w) => w.hrv);
    const rhrValues = window.map((w) => w.resting_hr);
    const enough = (xs: Array<number | null>) => xs.filter((x) => x !== null).length >= 7;
    const hrvBase = enough(hrvValues) ? mean(hrvValues) : null;
    const rhrBase = enough(rhrValues) ? mean(rhrValues) : null;
    const hrvSd = enough(hrvValues) ? stdev(hrvValues) : null;
    const rhrSd = enough(rhrValues) ? stdev(rhrValues) : null;
    const flags: string[] = [];
    if (r.hrv !== null && hrvBase !== null && hrvSd !== null && r.hrv < hrvBase - hrvSd)
      flags.push("HRV below baseline");
    if (
      r.resting_hr !== null &&
      rhrBase !== null &&
      rhrSd !== null &&
      r.resting_hr > rhrBase + Math.max(rhrSd, 2)
    ) {
      flags.push("resting HR above baseline");
    }
    if (r.sleep_score !== null && r.sleep_score < 60) flags.push("poor sleep");
    return {
      ...r,
      load: Math.round(dailyLoad.get(r.date) ?? 0),
      hrv_baseline: round(hrvBase, 1),
      rhr_baseline: round(rhrBase, 1),
      flags,
    };
  });
  const inRange = days.filter((d) => d.date >= start);
  const loadPrev = inRange.map((d) => dailyLoad.get(addDays(d.date as CalendarDate, -1)) ?? 0);
  const corr = (question: string, xs: Array<number | null>, ys: Array<number | null>): Correlation => {
    const { r, n } = pearson(xs, ys);
    return { question, r: round(r, 2), n, reading: n < 14 ? "too few days" : correlationStrength(r) };
  };
  const correlations = [
    corr(
      "Previous day's training load vs HRV",
      loadPrev,
      inRange.map((d) => d.hrv),
    ),
    corr(
      "Previous day's training load vs resting HR",
      loadPrev,
      inRange.map((d) => d.resting_hr),
    ),
    corr(
      "Previous day's training load vs sleep score",
      loadPrev,
      inRange.map((d) => d.sleep_score),
    ),
    corr(
      "Previous day's training load vs Body Battery max",
      loadPrev,
      inRange.map((d) => d.body_battery_max),
    ),
    corr(
      "Sleep score vs HRV (same night)",
      inRange.map((d) => d.sleep_score),
      inRange.map((d) => d.hrv),
    ),
    corr(
      "Daytime stress vs that night's sleep score",
      inRange.map((_d, i) => (i > 0 ? (inRange[i - 1]?.stress_avg ?? null) : null)),
      inRange.map((d) => d.sleep_score),
    ),
  ];

  const last7 = inRange.slice(-7);
  const before = days.filter((d) => d.date < (last7[0]?.date ?? "")).slice(-BASELINE_DAYS);
  const fitnessNow = fitness.at(-1);
  const status = {
    last_7_days: {
      hrv: round(mean(last7.map((d) => d.hrv)), 1),
      resting_hr: round(mean(last7.map((d) => d.resting_hr)), 1),
      sleep_score: round(mean(last7.map((d) => d.sleep_score)), 1),
      sleep_h: round((mean(last7.map((d) => d.sleep_s)) ?? 0) / 3600, 1),
      load_per_day: round(mean(last7.map((d) => d.load)), 0),
    },
    previous_28_days: {
      hrv: round(mean(before.map((d) => d.hrv)), 1),
      resting_hr: round(mean(before.map((d) => d.resting_hr)), 1),
      sleep_score: round(mean(before.map((d) => d.sleep_score)), 1),
      sleep_h: round((mean(before.map((d) => d.sleep_s)) ?? 0) / 3600, 1),
      load_per_day: round(mean(before.map((d) => d.load)), 0),
    },
    fitness: fitnessNow
      ? { ctl: fitnessNow.ctl, atl: fitnessNow.atl, tsb: fitnessNow.tsb, acwr: acwr(fitnessNow) }
      : null,
    latest_hrv_status: [...inRange].reverse().find((d) => d.hrv_status)?.hrv_status ?? null,
  };
  return { status, days: inRange, correlations };
}
