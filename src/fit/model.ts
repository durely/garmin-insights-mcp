// Normalized view of a FIT activity file, independent of the parser library.
// Units: seconds, meters, m/s, bpm, watts, °C. Cadence is steps/min for running and walking,
// rpm for cycling, strokes/min for swimming.

/** Bump when the summary shape or derivation changes, so cached summaries get re-parsed. */
export const FIT_SUMMARY_VERSION = 1;

export interface FitDevice {
  manufacturer: string | null;
  product: string | null;
  software_version: number | null;
}

export interface FitSession {
  index: number;
  sport: string | null;
  sub_sport: string | null;
  start_time: string | null;
  /** Seconds from the start of the file. */
  start_offset_s: number;
  elapsed_s: number | null;
  timer_s: number | null;
  distance_m: number | null;
  avg_speed_mps: number | null;
  max_speed_mps: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  avg_cadence: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  calories: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  training_load_peak: number | null;
  sweat_loss_ml: number | null;
  avg_respiration_rate: number | null;
  first_lap_index: number;
  lap_count: number;
}

export interface FitLap {
  index: number;
  session_index: number;
  start_time: string | null;
  start_offset_s: number;
  elapsed_s: number | null;
  timer_s: number | null;
  distance_m: number | null;
  avg_speed_mps: number | null;
  max_speed_mps: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  avg_cadence: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  calories: number | null;
  /** active, rest, warmup, cooldown, recovery, interval, other */
  intensity: string | null;
  trigger: string | null;
  swim_stroke: string | null;
  lengths: number | null;
  active_lengths: number | null;
}

export interface FitLength {
  index: number;
  start_offset_s: number;
  elapsed_s: number | null;
  strokes: number | null;
  stroke: string | null;
  /** active or idle (rest at the wall) */
  type: string | null;
  avg_speed_mps: number | null;
}

/** Garmin's physiological metrics, stored in undocumented FIT messages; absent on older devices and third-party files. */
export interface FitMetrics {
  vo2max: number | null;
  recovery_time_min: number | null;
  primary_benefit: number | null;
  lactate_threshold_hr: number | null;
  lactate_threshold_power_w: number | null;
  max_hr: number | null;
}

export interface FitSummary {
  version: number;
  parser: string;
  device: FitDevice;
  start_time: string | null;
  duration_s: number;
  record_count: number;
  /** Stream fields with at least one value, e.g. heart_rate, power, dev_RP_Power. */
  record_fields: string[];
  sessions: FitSession[];
  laps: FitLap[];
  lengths: FitLength[];
  metrics: FitMetrics;
  hrv_rr_intervals: number;
}

/** Second-by-second data, columnar: fields[name][i] belongs to t[i]. */
export interface FitStreams {
  /** Seconds since the start of the file. */
  t: number[];
  /** Index into FitSummary.sessions for each sample. */
  session: number[];
  fields: Record<string, Array<number | null>>;
}

export interface ParsedFit {
  summary: FitSummary;
  streams: FitStreams;
}

export interface FitParser {
  /** Identifies parser and summary version, stored with cached summaries. */
  readonly id: string;
  parse(bytes: Uint8Array): Promise<ParsedFit>;
}
