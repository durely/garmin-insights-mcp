// Analysis of one activity from its FIT streams (pure functions, no I/O).

import type { FitLap, ParsedFit } from "../fit/model.ts";
import { bestAverage, fastestDistance, mean, median, round, stdev } from "./stats.ts";

export type Family = "run" | "bike" | "swim" | "other";

export interface HrZones {
  /** Floors of zones 1..5 in bpm. */
  floors: [number, number, number, number, number];
  maxHr: number | null;
  source: string;
}

export interface ActivityAnalysis {
  duration_s: number;
  samples: number;
  hr_zones: ZoneTime[] | null;
  power_zones: ZoneTime[] | null;
  power: {
    avg_w: number | null;
    normalized_w: number | null;
    variability_index: number | null;
    ftp_w: number | null;
    intensity_factor: number | null;
    tss: number | null;
  } | null;
  decoupling: {
    metric: "power" | "pace";
    first_half_ef: number;
    second_half_ef: number;
    decoupling_pct: number;
    note: string;
  } | null;
  halves: { first_half_s: number; second_half_s: number; split: "negative" | "positive" | "even" } | null;
  best_power: Array<{ window_s: number; watts: number; start_s: number }>;
  best_hr: Array<{ window_s: number; bpm: number; start_s: number }>;
  fastest: Array<{ meters: number; seconds: number; pace: string; start_s: number }>;
  trimp_edwards: number | null;
  intervals: IntervalSummary | null;
}

export interface ZoneTime {
  zone: string;
  range: string;
  seconds: number;
  pct: number;
}

export interface IntervalSummary {
  detected_by: "lap intensity" | "lap pace/power";
  work_laps: number;
  avg_duration_s: number;
  avg_metric: number;
  metric: "power_w" | "speed_mps";
  consistency_cv_pct: number;
  hr_first_work_lap: number | null;
  hr_last_work_lap: number | null;
}

const POWER_WINDOWS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const HR_WINDOWS = [60, 300, 1200, 3600];
const DISTANCES: Record<Family, number[]> = {
  run: [400, 1000, 1609, 3000, 5000, 10000, 21097, 42195],
  bike: [5000, 10000, 20000, 40000, 90000],
  swim: [100, 200, 400, 750, 1000, 1500, 1900, 3800],
  other: [1000, 5000, 10000],
};
/** Coggan's power zones as fractions of FTP. */
const POWER_ZONES: Array<[string, number, number]> = [
  ["Z1 recovery", 0, 0.55],
  ["Z2 endurance", 0.55, 0.75],
  ["Z3 tempo", 0.75, 0.9],
  ["Z4 threshold", 0.9, 1.05],
  ["Z5 VO2max", 1.05, 1.2],
  ["Z6 anaerobic", 1.2, 1.5],
  ["Z7 neuromuscular", 1.5, Number.POSITIVE_INFINITY],
];
/** Gaps between samples longer than this (pauses) count as this many seconds at most. */
const MAX_SAMPLE_GAP_S = 5;

export function analyzeActivity(
  parsed: ParsedFit,
  options: { sessionIndex: number | null; family: Family; hrZones: HrZones | null; ftp: number | null },
): ActivityAnalysis {
  const { streams, summary } = parsed;
  const keep: number[] = [];
  for (let i = 0; i < streams.t.length; i++) {
    if (options.sessionIndex === null || streams.session[i] === options.sessionIndex) keep.push(i);
  }
  const origin = keep.length ? (streams.t[keep[0] as number] as number) : 0;
  const t = keep.map((i) => (streams.t[i] as number) - origin);
  const pick = (field: string) => {
    const values = streams.fields[field];
    return values ? keep.map((i) => values[i] ?? null) : keep.map(() => null);
  };
  const hr = pick("heart_rate");
  const power = pick("power");
  const speed = pick("speed");
  const distance = pick("distance");
  const dt = t.map((x, i) => (i + 1 < t.length ? Math.min((t[i + 1] as number) - x, MAX_SAMPLE_GAP_S) : 1));
  const duration = t.at(-1) ?? 0;
  const hasPower = power.some((p) => typeof p === "number" && p > 0);

  // Heart rate zones
  let hrZones: ZoneTime[] | null = null;
  if (options.hrZones && hr.some((x) => x !== null)) {
    const f = options.hrZones.floors;
    const bounds: Array<[string, number, number]> = [
      ["Z0 below zone 1", 0, f[0]],
      ["Z1 warm-up", f[0], f[1]],
      ["Z2 easy", f[1], f[2]],
      ["Z3 aerobic", f[2], f[3]],
      ["Z4 threshold", f[3], f[4]],
      ["Z5 maximum", f[4], Number.POSITIVE_INFINITY],
    ];
    hrZones = zoneTimes(hr, dt, bounds, (lo, hi) =>
      Number.isFinite(hi) ? `${lo}–${hi - 1} bpm` : `≥${lo} bpm`,
    );
  }

  // Power: NP, VI, IF, TSS, zones
  let powerBlock: ActivityAnalysis["power"] = null;
  let powerZones: ZoneTime[] | null = null;
  if (hasPower) {
    const avg = mean(power);
    const np = normalizedPower(t, power);
    const ftp = options.ftp;
    const intensity = np && ftp ? np / ftp : null;
    powerBlock = {
      avg_w: round(avg, 0),
      normalized_w: round(np, 0),
      variability_index: np && avg ? round(np / avg, 2) : null,
      ftp_w: ftp,
      intensity_factor: round(intensity, 2),
      tss: np && ftp && intensity ? round(((duration * np * intensity) / (ftp * 3600)) * 100, 0) : null,
    };
    if (ftp) {
      powerZones = zoneTimes(
        power,
        dt,
        POWER_ZONES.map(([name, lo, hi]) => [name, lo * ftp, hi * ftp]),
        (lo, hi) =>
          Number.isFinite(hi) ? `${Math.round(lo)}–${Math.round(hi) - 1} W` : `≥${Math.round(lo)} W`,
      );
    }
  }

  return {
    duration_s: round(duration, 0) ?? 0,
    samples: t.length,
    hr_zones: hrZones,
    power_zones: powerZones,
    power: powerBlock,
    decoupling: decouplingOf(t, hr, hasPower ? power : speed, hasPower ? "power" : "pace"),
    halves: halvesOf(t, distance),
    best_power: hasPower
      ? POWER_WINDOWS.filter((w) => w <= duration).flatMap((w) => {
          const b = bestAverage(t, power, w);
          return b ? [{ window_s: w, watts: Math.round(b.value), start_s: Math.round(b.start_s) }] : [];
        })
      : [],
    best_hr: HR_WINDOWS.filter((w) => w <= duration).flatMap((w) => {
      const b = bestAverage(t, hr, w);
      return b ? [{ window_s: w, bpm: Math.round(b.value), start_s: Math.round(b.start_s) }] : [];
    }),
    fastest: DISTANCES[options.family].flatMap((m) => {
      const f = fastestDistance(t, distance, m);
      return f
        ? [
            {
              meters: m,
              seconds: Math.round(f.seconds),
              pace: paceText(options.family, m / f.seconds),
              start_s: Math.round(f.start_s),
            },
          ]
        : [];
    }),
    trimp_edwards: hrZones ? edwardsTrimp(hrZones) : null,
    intervals: intervalsOf(
      options.sessionIndex === null
        ? summary.laps
        : summary.laps.filter((l) => l.session_index === options.sessionIndex),
      hasPower,
    ),
  };
}

/** Coggan's normalized power: 30-second rolling average, raised to the 4th power, averaged, 4th root. */
export function normalizedPower(t: readonly number[], power: ReadonlyArray<number | null>): number | null {
  const rolling: number[] = [];
  let start = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    const p = power[i];
    sum += typeof p === "number" ? p : 0;
    count++;
    while ((t[i] as number) - (t[start] as number) >= 30) {
      const q = power[start];
      sum -= typeof q === "number" ? q : 0;
      count--;
      start++;
    }
    if ((t[i] as number) >= 29) rolling.push(sum / count);
  }
  if (rolling.length === 0) return null;
  return (rolling.reduce((a, x) => a + x ** 4, 0) / rolling.length) ** 0.25;
}

function zoneTimes(
  values: ReadonlyArray<number | null>,
  dt: readonly number[],
  bounds: Array<[string, number, number]>,
  label: (lo: number, hi: number) => string,
): ZoneTime[] {
  const seconds = bounds.map(() => 0);
  let total = 0;
  values.forEach((v, i) => {
    if (typeof v !== "number") return;
    const zone = bounds.findIndex(([, lo, hi]) => v >= lo && v < hi);
    if (zone < 0) return;
    seconds[zone] = (seconds[zone] as number) + (dt[i] as number);
    total += dt[i] as number;
  });
  return bounds.map(([zone, lo, hi], i) => ({
    zone,
    range: label(lo, hi),
    seconds: Math.round(seconds[i] as number),
    pct: total ? (round(((seconds[i] as number) / total) * 100, 1) ?? 0) : 0,
  }));
}

/** Edwards TRIMP: minutes in each heart rate zone × zone number (1–5). */
function edwardsTrimp(zones: ZoneTime[]): number {
  return Math.round(zones.reduce((sum, z, i) => sum + (z.seconds / 60) * i, 0));
}

/**
 * Aerobic decoupling: efficiency (power or speed per heartbeat) in the first vs second half of
 * the moving time. Under ~5% suggests good aerobic endurance for steady efforts.
 */
function decouplingOf(
  t: readonly number[],
  hr: ReadonlyArray<number | null>,
  output: ReadonlyArray<number | null>,
  metric: "power" | "pace",
): ActivityAnalysis["decoupling"] {
  const moving: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const o = output[i];
    const h = hr[i];
    if (typeof o === "number" && typeof h === "number" && h > 0 && o > (metric === "power" ? 0 : 0.5))
      moving.push(i);
  }
  if (
    moving.length < 2 ||
    (t[moving.at(-1) as number] as number) - (t[moving[0] as number] as number) < 20 * 60
  )
    return null;
  const mid = Math.floor(moving.length / 2);
  const ef = (idx: number[]) => (mean(idx.map((i) => output[i])) ?? 0) / (mean(idx.map((i) => hr[i])) ?? 1);
  const first = ef(moving.slice(0, mid));
  const second = ef(moving.slice(mid));
  const pct = first ? ((first - second) / first) * 100 : 0;
  return {
    metric,
    first_half_ef: round(first, metric === "power" ? 2 : 4) ?? 0,
    second_half_ef: round(second, metric === "power" ? 2 : 4) ?? 0,
    decoupling_pct: round(pct, 1) ?? 0,
    note: "Meaningful for steady efforts of 45+ minutes; intervals, hills and stops distort it.",
  };
}

function halvesOf(t: readonly number[], distance: ReadonlyArray<number | null>): ActivityAnalysis["halves"] {
  const idx = distance.map((d, i) => (typeof d === "number" ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return null;
  const total = distance[idx.at(-1) as number] as number;
  if (total < 1000) return null;
  const halfway = idx.find((i) => (distance[i] as number) >= total / 2) as number;
  const start = t[idx[0] as number] as number;
  const first = (t[halfway] as number) - start;
  const second = (t[idx.at(-1) as number] as number) - (t[halfway] as number);
  const diff = (second - first) / first;
  return {
    first_half_s: Math.round(first),
    second_half_s: Math.round(second),
    split: Math.abs(diff) < 0.01 ? "even" : diff < 0 ? "negative" : "positive",
  };
}

/** Work intervals from laps: by the laps' intensity field if set, otherwise laps clearly faster/harder than the rest. */
function intervalsOf(laps: FitLap[], hasPower: boolean): IntervalSummary | null {
  if (laps.length < 3) return null;
  const metricOf = (l: FitLap) => (hasPower ? l.avg_power_w : l.avg_speed_mps);
  const metric = hasPower ? "power_w" : "speed_mps";
  let work: FitLap[];
  let detectedBy: IntervalSummary["detected_by"];
  const intensities = new Set(laps.map((l) => l.intensity).filter(Boolean));
  if (intensities.has("active") && (intensities.has("rest") || intensities.has("recovery"))) {
    work = laps.filter((l) => l.intensity === "active" || l.intensity === "interval");
    detectedBy = "lap intensity";
  } else {
    const values = laps.map(metricOf);
    const mid = median(values);
    const spread = stdev(values);
    if (mid === null || spread === null || spread / mid < 0.1) return null; // steady session, no intervals
    work = laps.filter((l) => (metricOf(l) ?? 0) >= mid * 1.08);
    detectedBy = "lap pace/power";
  }
  if (work.length < 2) return null;
  const values = work.map(metricOf);
  const avg = mean(values) ?? 0;
  return {
    detected_by: detectedBy,
    work_laps: work.length,
    avg_duration_s: Math.round(mean(work.map((l) => l.timer_s)) ?? 0),
    avg_metric: round(avg, hasPower ? 0 : 3) ?? 0,
    metric,
    consistency_cv_pct: avg ? (round(((stdev(values) ?? 0) / avg) * 100, 1) ?? 0) : 0,
    hr_first_work_lap: work[0]?.avg_hr ?? null,
    hr_last_work_lap: work.at(-1)?.avg_hr ?? null,
  };
}

export function paceText(family: Family, mps: number): string {
  if (!mps) return "–";
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  if (family === "swim") return `${fmt(100 / mps)} /100m`;
  if (family === "run") return `${fmt(1000 / mps)} /km`;
  return `${(mps * 3.6).toFixed(1)} km/h`;
}
