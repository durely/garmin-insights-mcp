// What the sync engine fetches. Each domain stores one row per local calendar date in daily_raw.
//
// "history" domains are synced for all history in large chunks: they're cheap (daily summaries
// allow 365 days per call). "recent" domains are per-day detail, synced for the last N days only;
// older days can be fetched on demand.
//
// Endpoints left out on purpose: steps, stress and hydration ranges are covered by daily
// summaries (which allow 365 days per call instead of 28-31), and single-day sleep returns the
// same fields as the sleep summaries.

import type { CalendarDate, GarminClient } from "../garmin/index.ts";

export interface DayEntry {
  date: string;
  data: unknown;
}

interface DomainBase {
  name: string;
  description: string;
  scope: "history" | "recent";
}

export interface RangeDomain extends DomainBase {
  kind: "range";
  maxDays: number;
  fetch(
    client: GarminClient,
    start: CalendarDate,
    end: CalendarDate,
    signal: AbortSignal,
  ): Promise<DayEntry[]>;
}

export interface DayDomain extends DomainBase {
  kind: "day";
  fetch(client: GarminClient, date: CalendarDate, signal: AbortSignal): Promise<unknown>;
}

export type Domain = RangeDomain | DayDomain;

/** Pulls entries out of a list, keyed by a date field; skips entries without a date. */
function byDate<T>(items: T[] | undefined | null, key: (item: T) => string | undefined | null): DayEntry[] {
  return (items ?? []).flatMap((item) => {
    const date = key(item);
    return date ? [{ date: date.slice(0, 10), data: item }] : [];
  });
}

/** 96 intervals per day: 15-minute low/high readings (Garmin's default is only ~6 points per day). */
export const BODY_BATTERY_CHUNKS = 96;

export const DOMAINS: Domain[] = [
  {
    name: "daily_summaries",
    description:
      "Daily wellness: steps, floors, calories, resting/min/max HR, stress, Body Battery, intensity minutes, respiration",
    scope: "history",
    kind: "range",
    maxDays: 365,
    fetch: async (client, start, end, signal) =>
      byDate((await client.getDailySummaries(start, end, signal))?.data, (d) => d.calendarDate),
  },
  {
    name: "sleep",
    description: "Nightly sleep: duration, stages, sleep score, respiration, sleep stress",
    scope: "history",
    kind: "range",
    maxDays: 31,
    fetch: async (client, start, end, signal) =>
      byDate(await client.getSleepSummaries(start, end, signal), (d) => d.calendarDate),
  },
  {
    name: "hrv",
    description: "Nightly HRV summary: last-night average, weekly average, baseline, status",
    scope: "history",
    kind: "range",
    maxDays: 365,
    fetch: async (client, start, end, signal) =>
      byDate((await client.getHrvDaily(start, end, signal))?.hrvSummaries, (d) => d.calendarDate),
  },
  {
    name: "weight",
    description: "Weight and body composition per day",
    scope: "history",
    kind: "range",
    maxDays: 3650,
    fetch: async (client, start, end, signal) =>
      byDate(
        (await client.getWeightRange(start, end, { includeAll: true }, signal))?.dailyWeightSummaries,
        (d) => d.summaryDate,
      ),
  },
  {
    name: "body_battery",
    description: "Body Battery curve through the day (15-minute low/high readings, charged/drained)",
    scope: "recent",
    kind: "range",
    maxDays: 31,
    fetch: async (client, start, end, signal) =>
      byDate(await client.getBodyBattery(start, end, { chunks: BODY_BATTERY_CHUNKS }, signal), (d) => d.date),
  },
  {
    name: "hrv_readings",
    description: "HRV readings through the night (5-minute values)",
    scope: "recent",
    kind: "day",
    fetch: (client, date, signal) => client.getHrv(date, signal),
  },
  {
    name: "heart_rate",
    description: "Intraday heart rate (~2-minute values)",
    scope: "recent",
    kind: "day",
    fetch: (client, date, signal) => client.getDailyHeartRate(date, signal),
  },
  {
    name: "spo2",
    description: "Pulse ox (SpO2) readings and averages",
    scope: "recent",
    kind: "day",
    fetch: (client, date, signal) => client.getSpo2(date, signal),
  },
];

export const ACTIVITIES_DOMAIN = "activities";
/** Fetched only when a tool asks for a date (not synced), then cached. */
export const ON_DEMAND_DOMAINS: DayDomain[] = [
  {
    name: "food_logs",
    description: "Food logged in Garmin Connect (or a linked app): meals, calories and macros per day",
    scope: "recent",
    kind: "day",
    fetch: (client, date, signal) =>
      client.getFoodLogs(date, { includeNutrition: true, includeGoals: true }, signal),
  },
];

/** Synced by default. */
export const ALL_DOMAIN_NAMES = [ACTIVITIES_DOMAIN, ...DOMAINS.map((d) => d.name)];
/** Original FIT files for all activities: opt-in (one request per activity), otherwise downloaded on demand. */
export const FIT_FILES_DOMAIN = "fit_files";
export const SELECTABLE_DOMAIN_NAMES = [...ALL_DOMAIN_NAMES, FIT_FILES_DOMAIN];
