// Maps Garmin activity records (~230 fields, many null) to compact views for tool output.
// Deliberately leaves out owner name/profile URLs and GPS coordinates.

import type { ActivityDetail, ActivityWorkout, SummarizedActivity } from "../garmin/index.ts";
import { compact, formatDuration, formatKm, formatKmh, formatPace, formatSwimPace, round } from "./format.ts";

export type SportFamily = "run" | "bike" | "swim" | "other";

export function sportFamily(typeKey: string | undefined): SportFamily {
  if (!typeKey) return "other";
  if (/swim/.test(typeKey)) return "swim";
  if (/run|walk|hik/.test(typeKey)) return "run";
  if (/bik|cycl|ride/.test(typeKey)) return "bike";
  return "other";
}

export interface ActivityView {
  id: number;
  name: string | null;
  type: string | null;
  sport: SportFamily;
  start_local: string | null;
  start_utc: string | null;
  parent_id: number | null;
  is_multisport_parent: boolean;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_speed_mps: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  normalized_power_w: number | null;
  avg_cadence: number | null;
  calories: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  te_label: string | null;
  training_load: number | null;
  tss: number | null;
  intensity_factor: number | null;
  vo2max: number | null;
  hr_time_in_zone_s: Array<number | null> | null;
  power_time_in_zone_s: Array<number | null> | null;
  lap_count: number | null;
  location: string | null;
}

export function fromSummarized(a: SummarizedActivity): ActivityView {
  const type = a.activityType?.typeKey ?? null;
  const sport = sportFamily(type ?? undefined);
  const hrZones = [a.hrTimeInZone_1, a.hrTimeInZone_2, a.hrTimeInZone_3, a.hrTimeInZone_4, a.hrTimeInZone_5];
  const powerZones = [
    a.powerTimeInZone_1,
    a.powerTimeInZone_2,
    a.powerTimeInZone_3,
    a.powerTimeInZone_4,
    a.powerTimeInZone_5,
    a.powerTimeInZone_6,
    a.powerTimeInZone_7,
  ];
  return {
    id: a.activityId ?? 0,
    name: a.activityName ?? null,
    type,
    sport,
    start_local: a.startTimeLocal ?? null,
    start_utc: a.startTimeGMT ?? null,
    parent_id: a.parentId ?? null,
    is_multisport_parent: a.isParent ?? false,
    duration_s: round(a.duration, 0),
    moving_s: round(a.movingDuration, 0),
    distance_m: round(a.distance, 0),
    elevation_gain_m: round(a.elevationGain, 0),
    avg_speed_mps: round(a.averageSpeed, 3),
    avg_hr: round(a.averageHR, 0),
    max_hr: round(a.maxHR, 0),
    avg_power_w: round(a.avgPower, 0),
    normalized_power_w: round(a.normPower, 0),
    avg_cadence: round(
      sport === "run"
        ? a.averageRunningCadenceInStepsPerMinute
        : sport === "bike"
          ? a.averageBikingCadenceInRevPerMinute
          : sport === "swim"
            ? a.averageSwimCadenceInStrokesPerMinute
            : undefined,
      0,
    ),
    calories: round(a.calories, 0),
    aerobic_te: round(a.aerobicTrainingEffect, 1),
    anaerobic_te: round(a.anaerobicTrainingEffect, 1),
    te_label: a.trainingEffectLabel ?? null,
    training_load: round(a.activityTrainingLoad, 0),
    tss: round(a.trainingStressScore, 0),
    intensity_factor: round(a.intensityFactor, 2),
    vo2max: round(a.vO2MaxValue, 1),
    hr_time_in_zone_s: hrZones.some((v) => v != null) ? hrZones.map((v) => round(v, 0)) : null,
    power_time_in_zone_s: powerZones.some((v) => v != null) ? powerZones.map((v) => round(v, 0)) : null,
    lap_count: a.lapCount ?? null,
    location: a.locationName ?? null,
  };
}

export interface ActivityDetailView {
  id: number;
  name: string | null;
  description: string | null;
  type: string | null;
  sport: SportFamily;
  start_local: string | null;
  start_utc: string | null;
  time_zone: string | null;
  parent_id: number | null;
  child_ids: number[];
  device_manufacturer: string | null;
  lap_count: number | null;
  location: string | null;
  summary: Record<string, unknown>;
  splits: Array<Record<string, unknown>>;
  workouts: Array<Record<string, unknown>>;
}

export function fromDetail(d: ActivityDetail, workouts: ActivityWorkout[]): ActivityDetailView {
  const s = d.summaryDTO ?? {};
  const type = d.activityTypeDTO?.typeKey ?? null;
  const sport = sportFamily(type ?? undefined);
  return {
    id: d.activityId ?? 0,
    name: d.activityName ?? null,
    description: d.description ?? null,
    type,
    sport,
    start_local: s.startTimeLocal ?? null,
    start_utc: s.startTimeGMT ?? null,
    time_zone: d.timeZoneUnitDTO?.timeZone ?? null,
    parent_id: d.parentId ?? null,
    child_ids: d.metadataDTO?.childIds ?? [],
    device_manufacturer: d.metadataDTO?.manufacturer ?? null,
    lap_count: d.metadataDTO?.lapCount ?? null,
    location: d.locationName ?? null,
    summary: compact({
      duration_s: round(s.duration, 0),
      moving_s: round(s.movingDuration, 0),
      elapsed_s: round(s.elapsedDuration, 0),
      distance_m: round(s.distance, 0),
      elevation_gain_m: round(s.elevationGain, 0),
      elevation_loss_m: round(s.elevationLoss, 0),
      avg_speed_mps: round(s.averageSpeed, 3),
      avg_moving_speed_mps: round(s.averageMovingSpeed, 3),
      max_speed_mps: round(s.maxSpeed, 3),
      avg_hr: round(s.averageHR, 0),
      max_hr: round(s.maxHR, 0),
      min_hr: round(s.minHR, 0),
      avg_power_w: round(s.averagePower, 0),
      max_power_w: round(s.maxPower, 0),
      normalized_power_w: round(s.normalizedPower, 0),
      max_20min_power_w: round(s.maxPowerTwentyMinutes, 0),
      ftp_w: round(s.functionalThresholdPower, 0),
      avg_run_cadence: round(s.averageRunCadence, 0),
      avg_bike_cadence: round(s.averageBikeCadence, 0),
      avg_swim_cadence: round(s.averageSwimCadence, 0),
      stride_length_cm: round(s.strideLength, 0),
      calories: round(s.calories, 0),
      aerobic_te: round(s.trainingEffect, 1),
      anaerobic_te: round(s.anaerobicTrainingEffect, 1),
      te_label: s.trainingEffectLabel,
      aerobic_te_message: s.aerobicTrainingEffectMessage,
      training_load: round(s.activityTrainingLoad, 0),
      tss: round(s.trainingStressScore, 0),
      intensity_factor: round(s.intensityFactor, 2),
      avg_temperature_c: round(s.averageTemperature, 0),
      moderate_intensity_min: s.moderateIntensityMinutes,
      vigorous_intensity_min: s.vigorousIntensityMinutes,
      water_estimated_ml: round(s.waterEstimated, 0),
    }),
    splits: (d.splitSummaries ?? []).map((sp) =>
      compact({
        type: sp.splitType,
        count: sp.noOfSplits,
        duration_s: round(sp.duration, 0),
        distance_m: round(sp.distance, 0),
        avg_speed_mps: round(sp.averageSpeed, 3),
        avg_hr: round(sp.averageHR, 0),
        elevation_gain_m: round(sp.elevationGain, 0),
      }),
    ),
    workouts: workouts.map((w) =>
      compact({ name: w.workoutName, sport: w.sport, created: w.timeCreated, steps: w.steps }),
    ),
  };
}

// ---- markdown ----

export function speedText(sport: SportFamily, mps: number | null): string {
  if (sport === "swim") return formatSwimPace(mps);
  if (sport === "run") return formatPace(mps);
  return formatKmh(mps);
}

export function activityLine(a: ActivityView): string {
  const parts = [
    formatDuration(a.duration_s),
    formatKm(a.distance_m),
    a.distance_m ? speedText(a.sport, a.avg_speed_mps) : null,
    a.avg_hr ? `HR ${a.avg_hr}/${a.max_hr ?? "–"}` : null,
    a.avg_power_w ? `${a.avg_power_w} W${a.normalized_power_w ? ` (NP ${a.normalized_power_w})` : ""}` : null,
    a.elevation_gain_m ? `↑${a.elevation_gain_m} m` : null,
    a.aerobic_te != null
      ? `TE ${a.aerobic_te}/${a.anaerobic_te ?? 0}${a.te_label ? ` ${a.te_label}` : ""}`
      : null,
    a.training_load != null ? `load ${a.training_load}` : null,
  ].filter((p) => p && p !== "–");
  const leg = a.parent_id ? ` (leg of ${a.parent_id})` : a.is_multisport_parent ? " (multisport)" : "";
  return `- **${a.start_local?.slice(0, 16) ?? "?"}** ${a.type ?? "?"}${leg}: ${a.name ?? "(no name)"} [${a.id}]\n  ${parts.join(" · ")}`;
}
