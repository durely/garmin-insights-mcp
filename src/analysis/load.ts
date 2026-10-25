// Training load per activity and the fitness/fatigue trend built from it.
//
// Garmin's own activity training load (EPOC-based) is used where it exists. Older activities and
// third-party uploads often lack it, so those get an estimate: Banister TRIMP from average heart
// rate, scaled to Garmin's load with a factor calibrated on this user's activities that have both.
// That keeps the long-term trend on one scale instead of mixing two.

import { addDays, type CalendarDate, spanDays } from "../garmin/index.ts";
import { ewmaStep, median, round } from "./stats.ts";

export interface LoadInput {
  training_load: number | null;
  avg_hr: number | null;
  duration_s: number | null;
}

export interface LoadSettings {
  restingHr: number;
  maxHr: number;
  /** Garmin load per TRIMP point, or null when it can't be calibrated (too few activities with both). */
  scale: number | null;
}

export type LoadSource = "garmin" | "estimated" | "none";

/** Banister TRIMP from average heart rate (the original male coefficients, as most tools use). */
export function banisterTrimp(
  avgHr: number | null,
  durationS: number | null,
  restingHr: number,
  maxHr: number,
): number | null {
  if (!avgHr || !durationS || maxHr <= restingHr) return null;
  const hrr = Math.min(1, Math.max(0, (avgHr - restingHr) / (maxHr - restingHr)));
  return (durationS / 60) * hrr * 0.64 * Math.exp(1.92 * hrr);
}

/** Median ratio of Garmin load to TRIMP over activities that have both; needs at least 20. */
export function calibrateScale(rows: LoadInput[], restingHr: number, maxHr: number): number | null {
  const ratios = rows.flatMap((r) => {
    const trimp = banisterTrimp(r.avg_hr, r.duration_s, restingHr, maxHr);
    return r.training_load && r.training_load > 0 && trimp && trimp > 5 ? [r.training_load / trimp] : [];
  });
  return ratios.length >= 20 ? median(ratios) : null;
}

export function activityLoad(
  row: LoadInput,
  settings: LoadSettings,
): { load: number | null; source: LoadSource } {
  if (row.training_load !== null && row.training_load !== undefined)
    return { load: row.training_load, source: "garmin" };
  if (settings.scale === null) return { load: null, source: "none" };
  const trimp = banisterTrimp(row.avg_hr, row.duration_s, settings.restingHr, settings.maxHr);
  return trimp === null
    ? { load: null, source: "none" }
    : { load: trimp * settings.scale, source: "estimated" };
}

export interface FitnessDay {
  date: string;
  load: number;
  /** Chronic load: 42-day exponentially weighted average ("fitness"). */
  ctl: number;
  /** Acute load: 7-day exponentially weighted average ("fatigue"). */
  atl: number;
  /** Form: yesterday's CTL minus yesterday's ATL. Negative means fatigued, positive means fresh. */
  tsb: number;
}

/** Daily fitness/fatigue/form, computed from `from` (start of history) to `to`. */
export function fitnessSeries(
  dailyLoad: Map<string, number>,
  from: CalendarDate,
  to: CalendarDate,
): FitnessDay[] {
  const out: FitnessDay[] = [];
  let ctl = 0;
  let atl = 0;
  for (let d = from; spanDays(d, to) >= 1; d = addDays(d, 1)) {
    const load = dailyLoad.get(d) ?? 0;
    const tsb = ctl - atl;
    ctl = ewmaStep(ctl, load, 42);
    atl = ewmaStep(atl, load, 7);
    out.push({
      date: d,
      load: round(load, 0) ?? 0,
      ctl: round(ctl, 1) ?? 0,
      atl: round(atl, 1) ?? 0,
      tsb: round(tsb, 1) ?? 0,
    });
  }
  return out;
}

/** Acute:chronic workload ratio; above ~1.5 is a commonly cited injury-risk zone. */
export function acwr(day: FitnessDay | undefined): number | null {
  return day && day.ctl > 0 ? round(day.atl / day.ctl, 2) : null;
}
