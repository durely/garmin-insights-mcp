// Typed wrapper around every Garmin Connect Personal API endpoint (all GET, read-only).
// Response types come from Garmin's OpenAPI spec (src/garmin/generated, via `npm run openapi`).
// The spec marks every field optional and is not always right (see getFitnessAge), so callers
// should treat responses defensively.

import { type CalendarDate, spanDays } from "./dates.ts";
import { GarminApiError } from "./errors.ts";
import type { components, paths } from "./generated/openapi.ts";
import type { GarminHttp, Query } from "./http.ts";

type Schemas = components["schemas"];

export type SummarizedActivity = Schemas["SummarizedActivityDTO"];
export type ActivityDetail = Schemas["ActivitySummaryDTO"];
export type ActivityWorkout = Schemas["ActivityWorkoutDTO"];
export type UserSettings = Schemas["UserSettingsDTO"];
export type HeartRateZones = Schemas["HeartRateZonesDTO"];
export type FitnessAge = Schemas["FitnessAgeDTO"];
export type ActivitySearchQuery = NonNullable<
  paths["/activitylist-service/activities/search/activities"]["get"]["parameters"]["query"]
>;

/**
 * Maximum inclusive span in days per range endpoint. Measured in the Phase 0 spike and
 * matching Garmin's docs; undefined means no cap was found (≥ 10 years worked).
 */
export const RANGE_LIMIT_DAYS = {
  steps: 28,
  stress: 28,
  hydration: 31,
  bodyBattery: 31,
  sleepSummaries: 31, // 32 worked in testing; the docs say 31
  dailySummaries: 365,
  hrvDaily: 365,
} as const;

/** Activity search fails with HTTP 500 somewhere between limit=200 and limit=500. */
export const MAX_SEARCH_LIMIT = 200;

export class GarminClient {
  readonly #http: GarminHttp;

  constructor(http: GarminHttp) {
    this.#http = http;
  }

  // ---- Profile ----

  async getUserProfileSettings(signal?: AbortSignal) {
    return this.#json<UserSettings>("/userprofile-service/userprofile/settings", undefined, signal);
  }

  async getHeartRateZones(signal?: AbortSignal) {
    return this.#list<HeartRateZones>("/biometric-service/heartRateZones/v2", undefined, signal);
  }

  /**
   * The spec declares an array, but the API returns a single object (observed 2026-10).
   * Normalised to one object either way.
   */
  async getFitnessAge(date: CalendarDate, options: { fullHistoryScan?: boolean } = {}, signal?: AbortSignal) {
    const body = await this.#http.getJson<FitnessAge | FitnessAge[]>(
      `/fitnessage-service/fitnessage/v2/${date}`,
      { fullHistoryScan: options.fullHistoryScan },
      signal,
    );
    return Array.isArray(body) ? (body[0] ?? null) : body;
  }

  // ---- Activities ----

  async searchActivities(query: ActivitySearchQuery = {}, signal?: AbortSignal) {
    if (query.limit !== undefined && query.limit > MAX_SEARCH_LIMIT) {
      throw new GarminApiError(
        "bad_request",
        `Activity search limit must be at most ${MAX_SEARCH_LIMIT}; Garmin fails with HTTP 500 above that.`,
      );
    }
    return this.#list<SummarizedActivity>(
      "/activitylist-service/activities/search/activities",
      query as Query,
      signal,
    );
  }

  async getActivity(activityId: number, signal?: AbortSignal) {
    return this.#json<ActivityDetail>(`/activity-service/activity/${checkId(activityId)}`, undefined, signal);
  }

  async getActivityWorkouts(activityId: number, signal?: AbortSignal) {
    return this.#list<ActivityWorkout>(
      `/activity-service/activity/${checkId(activityId)}/workouts`,
      undefined,
      signal,
    );
  }

  /** The original activity file as uploaded by the device or app, wrapped in a ZIP. */
  async downloadActivityFile(activityId: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#http.getBytes(
      `/download-service/files/activity/${checkId(activityId)}`,
      "application/zip, application/x-zip-compressed, application/octet-stream",
      signal,
    );
  }

  // ---- Daily wellness ----

  async getDailySummaries(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.dailySummaries, "daily summaries");
    return this.#json<Schemas["ApiDocumentListUserDailySummaryV2DTO"]>(
      "/usersummary-service/v2/dailysummaries",
      { startDate: start, endDate: end },
      signal,
    );
  }

  async getDailyUserSummary(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["UserDailySummaryDto"]>(
      "/usersummary-service/usersummary/daily",
      { calendarDate: date },
      signal,
    );
  }

  async getDailySteps(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.steps, "daily steps");
    return this.#list<Schemas["StepsDailyStatDTO"]>(
      `/usersummary-service/stats/steps/daily/${start}/${end}`,
      undefined,
      signal,
    );
  }

  async getDailyStress(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.stress, "daily stress");
    return this.#list<Schemas["MultiValueWellnessChartItemDTO"]>(
      `/usersummary-service/stats/stress/daily/${start}/${end}`,
      undefined,
      signal,
    );
  }

  async getDailyHydration(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.hydration, "daily hydration");
    return this.#list<Schemas["UserDailyHydrationDTO"]>(
      `/usersummary-service/stats/hydration/daily/${start}/${end}`,
      undefined,
      signal,
    );
  }

  async getBodyBattery(
    start: CalendarDate,
    end: CalendarDate,
    options: { chunks?: number } = {},
    signal?: AbortSignal,
  ) {
    checkRange(start, end, RANGE_LIMIT_DAYS.bodyBattery, "Body Battery");
    return this.#list<Schemas["BodyBatteryDailyReportDTO"]>(
      "/wellness-service/wellness/bodyBattery/reports/daily",
      { startDate: start, endDate: end, chunks: options.chunks },
      signal,
    );
  }

  async getDailyHeartRate(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["DailyHeartRateDTO"]>(
      "/wellness-service/wellness/dailyHeartRate",
      { date },
      signal,
    );
  }

  async getSpo2(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["DailySpO2AndAcclimationDTO"]>(
      `/wellness-service/wellness/daily/spo2acclimation/${date}`,
      undefined,
      signal,
    );
  }

  async getWellnessActivitySummaries(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, undefined, "wellness activity summaries");
    return this.#list<Schemas["WellnessActivitySummaryDTO"]>(
      `/wellnessactivity-service/activity/summary/range/${start}/${end}`,
      undefined,
      signal,
    );
  }

  // ---- Sleep and HRV ----

  async getDailySleep(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["DailySleepDTO"]>("/sleep-service/sleep/dailySleep", { date }, signal);
  }

  async getSleepSummaries(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.sleepSummaries, "sleep summaries");
    return this.#list<Schemas["DailySleepDTO"]>(
      "/sleep-service/sleep/dailySleepSummariesByDate",
      { startDate: start, endDate: end },
      signal,
    );
  }

  async getHrv(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["HrvChartDTO"]>(`/hrv-service/hrv/${date}`, undefined, signal);
  }

  async getHrvDaily(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, RANGE_LIMIT_DAYS.hrvDaily, "HRV daily summaries");
    return this.#json<Schemas["HrvDailySummaryDTO"]>(
      `/hrv-service/hrv/daily/${start}/${end}`,
      undefined,
      signal,
    );
  }

  // ---- Body ----

  async getWeightRange(
    start: CalendarDate,
    end: CalendarDate,
    options: { includeAll?: boolean } = {},
    signal?: AbortSignal,
  ) {
    checkRange(start, end, undefined, "weight");
    return this.#json<Schemas["WeightRangeDTO"]>(
      `/weight-service/weight/range/${start}/${end}`,
      { includeAll: options.includeAll ?? true },
      signal,
    );
  }

  async getWeightEntries(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, undefined, "weight entries");
    return this.#list<Schemas["DateWeightDTO"]>(
      `/weight-service/weight/all/${start}/${end}`,
      undefined,
      signal,
    );
  }

  async getWeightGoals(start: CalendarDate, end: CalendarDate, signal?: AbortSignal) {
    checkRange(start, end, undefined, "weight goals");
    return this.#json<Schemas["UserGoalsRangeDTO"]>(
      `/goal-service/goal/user/effective/weightgoal/${start}/${end}`,
      undefined,
      signal,
    );
  }

  // ---- Nutrition ----

  async getFoodLogs(
    date: CalendarDate,
    options: { includeNutrition?: boolean; includeGoals?: boolean } = {},
    signal?: AbortSignal,
  ) {
    return this.#json<Schemas["DailyNutritionSummaryDTO"]>(
      `/nutrition-service/food/logs/${date}`,
      { includeNutrition: options.includeNutrition, includeGoals: options.includeGoals },
      signal,
    );
  }

  // ---- Women's health ----

  async getMenstrualCycleSummary(date: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["MenstrualCycleSummaryDTO"]>(
      `/periodichealth-service/menstrualcycle/summary/${date}`,
      undefined,
      signal,
    );
  }

  async getMenstrualCycleDayView(date: CalendarDate, todayDate: CalendarDate, signal?: AbortSignal) {
    return this.#json<Schemas["DetailedMenstrualCycleDayDTO"]>(
      `/periodichealth-service/menstrualcycle/dayview/${date}`,
      { todayDate },
      signal,
    );
  }

  // ---- helpers ----

  #json<T>(path: string, query: Query | undefined, signal: AbortSignal | undefined): Promise<T | null> {
    return this.#http.getJson<T>(path, query, signal);
  }

  /** List endpoints answer [] or 204 when there's no data; both become []. */
  async #list<T>(path: string, query: Query | undefined, signal: AbortSignal | undefined): Promise<T[]> {
    return (await this.#http.getJson<T[]>(path, query, signal)) ?? [];
  }
}

function checkId(activityId: number): number {
  if (!Number.isSafeInteger(activityId) || activityId <= 0) {
    throw new GarminApiError(
      "bad_request",
      `Invalid activity ID ${activityId}: expected a positive integer.`,
    );
  }
  return activityId;
}

function checkRange(start: CalendarDate, end: CalendarDate, maxDays: number | undefined, what: string): void {
  const days = spanDays(start, end);
  if (days < 1) {
    throw new GarminApiError("bad_request", `Invalid ${what} range: start ${start} is after end ${end}.`);
  }
  if (maxDays !== undefined && days > maxDays) {
    throw new GarminApiError(
      "bad_request",
      `Garmin allows at most ${maxDays} days per ${what} request; ${start}..${end} is ${days} days. Split the range.`,
    );
  }
}
