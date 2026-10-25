// Selects and downsamples second-by-second FIT data for tool output.

import type { ParsedFit } from "./model.ts";

export interface StreamQuery {
  fields: string[];
  /** Target seconds per point; raised automatically to stay within maxPoints. */
  resolutionS: number;
  maxPoints: number;
  /** Window in seconds from the start of the activity (or of the leg). */
  startS?: number;
  endS?: number;
  /** For a multisport leg: only this session, with t measured from the leg's start. */
  sessionIndex: number | null;
}

export interface FieldStats {
  min: number | null;
  avg: number | null;
  max: number | null;
}

export interface StreamResult {
  resolution_s: number;
  start_s: number;
  end_s: number;
  source_points: number;
  point_count: number;
  stats: Record<string, FieldStats>;
  /** Seconds from the start of the activity (or leg); one entry per point. */
  t: number[];
  series: Record<string, Array<number | null>>;
}

/** Cadence averages leave out zeros (coasting, standing), as Garmin Connect does. Others include them. */
const AVG_EXCLUDES_ZERO = new Set(["cadence"]);

const DECIMALS: Record<string, number> = {
  speed: 3,
  altitude: 1,
  distance: 0,
  temperature: 0,
  respiration_rate: 1,
  vertical_oscillation: 1,
  position_lat: 6,
  position_long: 6,
};

export function selectStreams(parsed: ParsedFit, q: StreamQuery): StreamResult {
  const { streams, summary } = parsed;
  const origin = q.sessionIndex !== null ? (summary.sessions[q.sessionIndex]?.start_offset_s ?? 0) : 0;

  // Indices of raw samples inside the requested session and window.
  const idx: number[] = [];
  for (let i = 0; i < streams.t.length; i++) {
    if (q.sessionIndex !== null && streams.session[i] !== q.sessionIndex) continue;
    const rel = (streams.t[i] as number) - origin;
    if (q.startS !== undefined && rel < q.startS) continue;
    if (q.endS !== undefined && rel > q.endS) continue;
    idx.push(i);
  }
  const first = idx.length ? (streams.t[idx[0] as number] as number) - origin : (q.startS ?? 0);
  const last = idx.length ? (streams.t[idx.at(-1) as number] as number) - origin : first;
  const span = Math.max(0, last - first);
  const resolution = Math.max(q.resolutionS, Math.ceil(span / Math.max(1, q.maxPoints - 1)) || 1);

  const stats: Record<string, FieldStats> = {};
  const series: Record<string, Array<number | null>> = {};
  const t: number[] = [];
  const bucketOf = (i: number) => Math.floor(((streams.t[i] as number) - origin - first) / resolution);

  // Bucket boundaries in idx, so every field shares the same t axis.
  const buckets: Array<[number, number]> = [];
  for (let k = 0; k < idx.length; ) {
    const b = bucketOf(idx[k] as number);
    let end = k;
    while (end < idx.length && bucketOf(idx[end] as number) === b) end++;
    buckets.push([k, end]);
    t.push(Math.round(first + b * resolution));
    k = end;
  }

  for (const field of q.fields) {
    const values = streams.fields[field];
    if (!values) continue;
    const decimals = DECIMALS[field] ?? 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const i of idx) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (AVG_EXCLUDES_ZERO.has(field) && v === 0) continue;
      sum += v;
      count++;
    }
    stats[field] = {
      min: Number.isFinite(min) ? roundTo(min, decimals) : null,
      avg: count ? roundTo(sum / count, Math.max(decimals, 1)) : null,
      max: Number.isFinite(max) ? roundTo(max, decimals) : null,
    };
    series[field] = buckets.map(([from, to]) => {
      let s = 0;
      let c = 0;
      for (let k = from; k < to; k++) {
        const v = values[idx[k] as number];
        if (v === null || v === undefined) continue;
        s += v;
        c++;
      }
      return c ? roundTo(s / c, decimals) : null;
    });
  }

  return {
    resolution_s: resolution,
    start_s: Math.round(first),
    end_s: Math.round(last),
    source_points: idx.length,
    point_count: t.length,
    stats,
    t,
    series,
  };
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
