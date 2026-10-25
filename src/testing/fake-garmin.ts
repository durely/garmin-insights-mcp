// An in-memory fake of the Garmin Personal API, for sync and tool tests. All data is invented.

import { addDays, type CalendarDate, spanDays } from "../garmin/dates.ts";
import { buildFixtureZip } from "./fit-fixture.ts";
import { json, type RecordedRequest, status } from "./helpers.ts";

export interface FakeActivity {
  activityId: number;
  activityName?: string;
  startTimeLocal: string;
  activityType: { typeId?: number; typeKey: string; parentTypeId?: number };
  distance?: number;
  duration?: number;
  averageSpeed?: number;
  averageHR?: number;
  parentId?: number;
  isParent?: boolean;
  [key: string]: unknown;
}

function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start as CalendarDate; spanDays(d, end as CalendarDate) >= 1; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Garmin "local" timestamps: local wall-clock time encoded as epoch milliseconds. */
const localMs = (iso: string) => Date.parse(`${iso}Z`);

/** Intraday heart rate is only kept for recent dates, like Garmin's ~4–5 months. */
export const INTRADAY_RETENTION_START = "2026-01-01";

/**
 * Routes requests like the real API. `fail` can return a Response to inject an error for
 * specific requests.
 */
export function fakeGarmin(activities: FakeActivity[], fail?: (url: URL) => Response | undefined) {
  return (req: RecordedRequest): Response => {
    const { url } = req;
    const injected = fail?.(url);
    if (injected) return injected;
    const p = url.pathname;
    const q = url.searchParams;
    const seg = p.split("/");
    const range = () => daysBetween(q.get("startDate") as string, q.get("endDate") as string);

    if (p === "/personalapitoken-service/personal-api/personal-api-key/token") return status(404);
    if (p === "/activitylist-service/activities/search/activities") {
      const start = Number(q.get("start") ?? 0);
      const limit = Number(q.get("limit") ?? 20);
      const from = q.get("startDate");
      const sorted = [...activities]
        .filter((a) => !from || a.startTimeLocal.slice(0, 10) >= from)
        .filter((a) => q.get("excludeChildren") === "false" || !a.parentId)
        .sort((a, b) => b.startTimeLocal.localeCompare(a.startTimeLocal));
      return json(sorted.slice(start, start + limit));
    }
    if (p === "/usersummary-service/v2/dailysummaries") {
      return json({
        data: range().map((d) => ({
          calendarDate: d,
          movement: { steps: { value: 10_000, goal: 8000 } },
          heartRate: { restingValue: 48, minValue: 44, maxValue: 150 },
          stress: { avgLevel: 25, maxLevel: 90, restProportion: 0.4, lowStressProportion: 0.3 },
          bodyBattery: { minValue: 10, maxValue: 90, chargedValue: 70, drainedValue: 65 },
          intensityMinutes: { moderate: 10, vigorous: 20 },
          calories: { burnedTotal: 2500, burnedActive: 600 },
          respiration: { avgValue: 14 },
          hydration: { consumedInMl: 1500 },
        })),
      });
    }
    if (p === "/sleep-service/sleep/dailySleepSummariesByDate") {
      return json(
        range().map((d) => ({
          calendarDate: d,
          sleepTimeSeconds: 27_000,
          deepSleepSeconds: 2880, // 48 minutes
          lightSleepSeconds: 18_000,
          remSleepSeconds: 6120,
          awakeSleepSeconds: 600,
          sleepStartTimestampLocal: localMs(`${d}T00:00:00`) - 30 * 60_000, // 23:30 the evening before
          sleepEndTimestampLocal: localMs(`${d}T07:30:00`),
          sleepScores: {
            overall: { value: 80, qualifierKey: "GOOD" },
            deepPercentage: { value: 18, qualifierKey: "FAIR" },
          },
          sleepScoreFeedback: "POSITIVE_LONG_AND_DEEP",
        })),
      );
    }
    if (p.startsWith("/hrv-service/hrv/daily/")) {
      return json({
        hrvSummaries: daysBetween(seg[4] as string, seg[5] as string).map((d) => ({
          calendarDate: d,
          lastNightAvg: 55,
          lastNight5MinHigh: 80,
          weeklyAvg: 52,
          baseline: { balancedLow: 45, balancedUpper: 65 },
          status: "BALANCED",
        })),
      });
    }
    if (p.startsWith("/weight-service/weight/range/")) {
      return json({
        dailyWeightSummaries: [
          { summaryDate: seg[4], latestWeight: { weight: 70_000, bodyFat: 20.0, sourceType: "INDEX_SCALE" } },
          { summaryDate: seg[5], latestWeight: { weight: 69_000, bodyFat: 19.5, sourceType: "INDEX_SCALE" } },
        ],
      });
    }
    if (p === "/wellness-service/wellness/bodyBattery/reports/daily") {
      return json(
        range().map((d) => ({
          date: d,
          charged: 70,
          drained: 65,
          bodyBatteryValuesArray: [
            [Date.parse(`${d}T00:00:00Z`), 20],
            [Date.parse(`${d}T06:00:00Z`), 80],
          ],
        })),
      );
    }
    if (p.startsWith("/hrv-service/hrv/")) {
      const d = seg[3] as string;
      return json({
        hrvSummary: { calendarDate: d, lastNightAvg: 55, status: "BALANCED" },
        hrvReadings: [
          { hrvValue: 50, readingTimeGMT: `${d}T01:00:00.0`, readingTimeLocal: `${d}T02:00:00.0` },
          { hrvValue: 60, readingTimeGMT: `${d}T01:05:00.0`, readingTimeLocal: `${d}T02:05:00.0` },
        ],
      });
    }
    if (p === "/wellness-service/wellness/dailyHeartRate") {
      const d = q.get("date") as string;
      const values =
        d < INTRADAY_RETENTION_START
          ? null
          : [
              [Date.parse(`${d}T10:00:00Z`), 60],
              [Date.parse(`${d}T10:02:00Z`), 70],
              [Date.parse(`${d}T11:00:00Z`), 90],
            ];
      return json({ calendarDate: d, restingHeartRate: 48, heartRateValues: values });
    }
    if (p.startsWith("/nutrition-service/food/logs/")) {
      return json({
        mealDate: seg[4],
        dailyNutritionContent: { calories: 2000, carbs: 250, protein: 120, fat: 60 },
        dailyNutritionGoals: { calories: 2200 },
        mealDetails: [
          { meal: { mealName: "Breakfast" }, mealNutritionContent: { calories: 500 }, loggedFoods: [{}, {}] },
        ],
      });
    }
    if (p.startsWith("/download-service/files/activity/")) {
      return new Response(buildFixtureZip(Number(seg.at(-1))), {
        status: 200,
        headers: { "content-type": "application/x-zip-compressed" },
      });
    }
    if (p.startsWith("/wellness-service/wellness/daily/spo2acclimation/")) return status(204);
    if (p.startsWith("/periodichealth-service/")) return status(204);
    if (p.startsWith("/goal-service/")) return json({ userGoals: [], userGoalRanges: null });
    return status(404);
  };
}
