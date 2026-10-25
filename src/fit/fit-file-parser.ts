// FitParser backed by fit-file-parser (MIT). It decodes Garmin's undocumented physiological
// messages (VO2max, recovery time, lactate threshold) by name, which the official SDK leaves
// as numeric message IDs.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import FitFileParser, { getFitGarminProductDisplayName } from "fit-file-parser";
import {
  FIT_SUMMARY_VERSION,
  type FitLap,
  type FitLength,
  type FitParser,
  type FitSession,
  type FitStreams,
  type FitSummary,
  type ParsedFit,
} from "./model.ts";

type Msg = Record<string, unknown>;

/** Record fields copied into streams, keyed by output name; the first present source wins. */
const RECORD_FIELDS: Record<string, string[]> = {
  heart_rate: ["heart_rate"],
  power: ["power"],
  speed: ["enhanced_speed", "speed"],
  cadence: ["cadence"],
  altitude: ["enhanced_altitude", "altitude"],
  distance: ["distance"],
  temperature: ["temperature"],
  respiration_rate: ["enhanced_respiration_rate", "respiration_rate"],
  performance_condition: ["garmin_performance_condition"],
  vertical_oscillation: ["vertical_oscillation"],
  stance_time: ["stance_time"],
  position_lat: ["position_lat"],
  position_long: ["position_long"],
};

export class FitFileParserAdapter implements FitParser {
  readonly id = `fit-file-parser@${parserVersion()}/summary-v${FIT_SUMMARY_VERSION}`;

  async parse(bytes: Uint8Array): Promise<ParsedFit> {
    const parser = new FitFileParser({
      force: true,
      mode: "list",
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
    });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const fit = (await parser.parseAsync(buffer)) as unknown as Record<string, unknown>;

    const records = list(fit.records);
    const sessionsRaw = list(fit.sessions).sort((a, b) => time(a.start_time) - time(b.start_time));
    const start = time(sessionsRaw[0]?.start_time) || time(records[0]?.timestamp);
    const offset = (value: unknown) => (time(value) ? (time(value) - start) / 1000 : 0);
    const sportOf = (i: number) => str(sessionsRaw[i]?.sport);

    const sessions: FitSession[] = sessionsRaw.map((s, i) => ({
      index: i,
      sport: str(s.sport),
      sub_sport: str(s.sub_sport),
      start_time: iso(s.start_time),
      start_offset_s: offset(s.start_time),
      elapsed_s: n(s.total_elapsed_time),
      timer_s: n(s.total_timer_time),
      distance_m: n(s.total_distance),
      avg_speed_mps: n(s.enhanced_avg_speed ?? s.avg_speed),
      max_speed_mps: n(s.enhanced_max_speed ?? s.max_speed),
      avg_hr: n(s.avg_heart_rate),
      max_hr: n(s.max_heart_rate),
      avg_power_w: n(s.avg_power),
      max_power_w: n(s.max_power),
      normalized_power_w: n(s.normalized_power),
      avg_cadence: cadence(sportOf(i), s.avg_cadence, s.avg_fractional_cadence),
      ascent_m: n(s.total_ascent),
      descent_m: n(s.total_descent),
      calories: n(s.total_calories),
      aerobic_te: n(s.total_training_effect),
      anaerobic_te: n(s.total_anaerobic_training_effect),
      training_load_peak: n(s.training_load_peak),
      sweat_loss_ml: n(s.est_sweat_loss),
      avg_respiration_rate: n(s.enhanced_avg_respiration_rate ?? s.avg_respiration_rate),
      first_lap_index: n(s.first_lap_index) ?? 0,
      lap_count: n(s.num_laps) ?? 0,
    }));

    const sessionForLap = (lapIndex: number, lapStart: number) => {
      const byIndex = sessions.findIndex(
        (s) => lapIndex >= s.first_lap_index && lapIndex < s.first_lap_index + s.lap_count,
      );
      return byIndex >= 0 ? byIndex : sessionAt(sessions, lapStart);
    };
    const laps: FitLap[] = list(fit.laps).map((l, i) => {
      const startOffset = offset(l.start_time);
      const sessionIndex = sessionForLap(i, startOffset);
      return {
        index: i,
        session_index: sessionIndex,
        start_time: iso(l.start_time),
        start_offset_s: startOffset,
        elapsed_s: n(l.total_elapsed_time),
        timer_s: n(l.total_timer_time),
        distance_m: n(l.total_distance),
        avg_speed_mps: n(l.enhanced_avg_speed ?? l.avg_speed),
        max_speed_mps: n(l.enhanced_max_speed ?? l.max_speed),
        avg_hr: n(l.avg_heart_rate),
        max_hr: n(l.max_heart_rate),
        avg_power_w: n(l.avg_power),
        max_power_w: n(l.max_power),
        normalized_power_w: n(l.normalized_power),
        avg_cadence: cadence(sportOf(sessionIndex), l.avg_cadence, l.avg_fractional_cadence),
        ascent_m: n(l.total_ascent),
        descent_m: n(l.total_descent),
        calories: n(l.total_calories),
        intensity: str(l.intensity),
        trigger: str(l.lap_trigger),
        swim_stroke: str(l.swim_stroke),
        lengths: n(l.num_lengths),
        active_lengths: n(l.num_active_lengths),
      };
    });

    const lengths: FitLength[] = list(fit.lengths).map((l, i) => ({
      index: i,
      start_offset_s: offset(l.start_time),
      elapsed_s: n(l.total_elapsed_time),
      strokes: n(l.total_strokes),
      stroke: str(l.swim_stroke),
      type: str(l.length_type),
      avg_speed_mps: n(l.avg_speed),
    }));

    // Developer fields (e.g. running power from a Connect IQ app) appear on records by name.
    const devNames = [
      ...new Set(
        list(fit.field_descriptions)
          .map((f) => str(f.field_name))
          .filter(isString),
      ),
    ];
    const streams = buildStreams(records, sessions, devNames, offset, sportOf);

    const metricsMsg = list(fit.activity_metrics)[0] ?? {};
    const userMetrics = list(fit.user_metrics)[0] ?? {};
    const fileId = list(fit.file_ids)[0] ?? {};
    const creator = (fit.file_creator ?? {}) as Msg;
    const productId = n(fileId.product);
    const manufacturer = str(fileId.manufacturer);

    const summary: FitSummary = {
      version: FIT_SUMMARY_VERSION,
      parser: this.id,
      device: {
        manufacturer,
        product:
          (manufacturer === "garmin" && productId !== null
            ? getFitGarminProductDisplayName(productId)
            : undefined) ??
          str(fileId.product_name) ??
          (productId !== null ? String(productId) : null),
        software_version: n(creator.software_version),
      },
      start_time: start ? new Date(start).toISOString() : null,
      duration_s: streams.t.at(-1) ?? sessions.reduce((sum, s) => sum + (s.elapsed_s ?? 0), 0),
      record_count: streams.t.length,
      record_fields: Object.keys(streams.fields),
      sessions,
      laps,
      lengths,
      metrics: {
        vo2max: positive(n(metricsMsg.vo2_max) ?? n(userMetrics.vo2_max)),
        recovery_time_min: positive(n(metricsMsg.recovery_time)),
        primary_benefit: n(metricsMsg.primary_benefit),
        lactate_threshold_hr: positive(n(userMetrics.lthr)),
        lactate_threshold_power_w: positive(n(userMetrics.ltpower)),
        max_hr: positive(n(userMetrics.max_heart_rate)),
      },
      hrv_rr_intervals: list(fit.hrv).reduce(
        (sum, h) => sum + (Array.isArray(h.time) ? h.time.length : 0),
        0,
      ),
    };
    return { summary, streams };
  }
}

function buildStreams(
  records: Msg[],
  sessions: FitSession[],
  devNames: string[],
  offset: (v: unknown) => number,
  sportOf: (i: number) => string | null,
): FitStreams {
  const t: number[] = [];
  const session: number[] = [];
  const fields: Record<string, Array<number | null>> = {};
  const sources: Array<[string, string[]]> = [
    ...Object.entries(RECORD_FIELDS),
    ...devNames.map((d): [string, string[]] => [`dev_${d}`, [d]]),
  ];
  for (const [name] of sources) fields[name] = [];

  for (const r of records) {
    if (!r.timestamp) continue;
    const ts = offset(r.timestamp);
    const s = sessionAt(sessions, ts);
    t.push(ts);
    session.push(s);
    for (const [name, keys] of sources) {
      let value: number | null = null;
      for (const k of keys) {
        value = n(r[k]);
        if (value !== null) break;
      }
      if (name === "cadence") value = cadence(sportOf(s), r.cadence, r.fractional_cadence);
      (fields[name] as Array<number | null>).push(value);
    }
  }
  // Drop fields that never have a value.
  for (const [name, values] of Object.entries(fields)) {
    if (values.every((v) => v === null)) delete fields[name];
  }
  return { t, session, fields };
}

/** Index of the session containing a time offset (sessions are sorted by start). */
function sessionAt(sessions: FitSession[], offsetS: number): number {
  let index = 0;
  for (const s of sessions) if (s.start_offset_s <= offsetS + 0.5) index = s.index;
  return index;
}

/** FIT stores running cadence per leg (strides/min); report steps/min like Garmin Connect does. */
function cadence(sport: string | null, value: unknown, fractional: unknown): number | null {
  const c = n(value);
  if (c === null) return null;
  if (sport === "running" || sport === "walking" || sport === "hiking") return (c + (n(fractional) ?? 0)) * 2;
  return c;
}

function list(value: unknown): Msg[] {
  return Array.isArray(value) ? (value as Msg[]) : [];
}

function n(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function time(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

function iso(value: unknown): string | null {
  const t = time(value);
  return t ? new Date(t).toISOString() : null;
}

/** The installed fit-file-parser version (its package.json isn't exported, so find it on disk). */
function parserVersion(): string {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve("fit-file-parser"));
    for (let i = 0; i < 5; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "fit-file-parser" && pkg.version) return pkg.version;
      } catch {
        // not here; keep walking up
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}
