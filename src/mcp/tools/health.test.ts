import { afterEach, describe, expect, it } from "vitest";
import { INTRADAY_RETENTION_START } from "../../testing/fake-garmin.ts";
import { closeAll, connect, daysAgo, textOf } from "../../testing/mcp-harness.ts";

afterEach(closeAll);

// One activity a year ago, so the sync's history covers the last year.
const activities = [
  {
    activityId: 1,
    startTimeLocal: `${daysAgo(365)} 08:00:00`,
    activityType: { typeKey: "running", parentTypeId: 17 },
  },
];

type Rows = { rows: Array<Record<string, unknown>> };

describe("health tools", () => {
  it("garmin_get_daily_health joins wellness, sleep and HRV per day (last 14 days by default)", async () => {
    const { client } = await connect({ activities });
    const result = await client.callTool({
      name: "garmin_get_daily_health",
      arguments: { response_format: "json" },
    });
    const data = result.structuredContent as Rows & { notes?: string[] };
    expect(data.rows).toHaveLength(14);
    expect(data.rows.at(-1)).toMatchObject({
      date: daysAgo(0),
      steps: 10_000,
      resting_hr: 48,
      stress_rest_pct: 40,
      body_battery_max: 90,
      sleep_s: 27_000,
      sleep_score: 80,
      hrv_last_night: 55,
      hrv_status: "BALANCED",
    });
    expect(data.notes).toContain("Today's values are partial.");
    expect(textOf(await client.callTool({ name: "garmin_get_daily_health", arguments: {} }))).toContain(
      "| 7:30 | 80 |",
    );
  });

  it("aggregates per week with totals for steps and intensity minutes, and refuses too many daily rows", async () => {
    const { client } = await connect({ activities });
    const weekly = (
      await client.callTool({
        name: "garmin_get_daily_health",
        arguments: {
          start_date: "2026-03-02",
          end_date: "2026-03-15",
          group_by: "week",
          response_format: "json",
        },
      })
    ).structuredContent as Rows;
    expect(weekly.rows).toHaveLength(2); // two Monday-based weeks
    expect(weekly.rows[0]).toMatchObject({
      period: "2026-03-02",
      days: 7,
      steps_total: 70_000,
      steps_per_day: 10_000,
      intensity_vigorous_min_total: 140,
      resting_hr: 48,
    });
    const tooMany = await client.callTool({
      name: "garmin_get_daily_health",
      arguments: { start_date: daysAgo(200) },
    });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toMatch(/group_by="week"/);
  });

  it("garmin_get_sleep shows stages as h:mm and score components in JSON", async () => {
    const { client } = await connect({ activities });
    const md = textOf(
      await client.callTool({ name: "garmin_get_sleep", arguments: { start_date: daysAgo(2) } }),
    );
    expect(md).toContain("23:30 → 07:30");
    expect(md).toContain("| 0:48 |"); // deep sleep under an hour
    const json = (
      await client.callTool({
        name: "garmin_get_sleep",
        arguments: { start_date: daysAgo(0), response_format: "json" },
      })
    ).structuredContent as { nights: Array<{ score_components: Record<string, string> }> };
    expect(json.nights[0]?.score_components).toEqual({ deepPercentage: "FAIR (18)" });
  });

  it("garmin_get_hrv adds a night's 5-minute readings on request", async () => {
    const { client } = await connect({ activities });
    const data = (
      await client.callTool({
        name: "garmin_get_hrv",
        arguments: { start_date: daysAgo(6), readings_date: daysAgo(30), response_format: "json" },
      })
    ).structuredContent as { nights: unknown[]; readings: { values: Array<{ time: string; hrv: number }> } };
    expect(data.nights).toHaveLength(7);
    expect(data.readings.values).toEqual([
      { time: "02:00", hrv: 50 },
      { time: "02:05", hrv: 60 },
    ]);
  });

  it("garmin_get_intraday buckets readings by local time and explains Garmin's retention", async () => {
    const { client, requests } = await connect({ activities });
    const day = (
      await client.callTool({
        name: "garmin_get_intraday",
        arguments: {
          date: "2026-02-10",
          metrics: ["heart_rate", "body_battery"],
          interval_min: 60,
          response_format: "json",
        },
      })
    ).structuredContent as {
      metrics: Record<string, { times: string[]; values: number[]; stats: { max: number } }>;
    };
    expect(day.metrics.heart_rate).toMatchObject({
      times: ["10:00", "11:00"],
      values: [65, 90],
      stats: { max: 90 },
    });
    expect(day.metrics.body_battery?.values).toEqual([20, 80]);
    // Fetched on demand: 2026-02-10 is outside the synced 2-day window.
    expect(requests.some((r) => r.url.searchParams.get("date") === "2026-02-10")).toBe(true);

    const old = textOf(
      await client.callTool({
        name: "garmin_get_intraday",
        arguments: { date: "2025-06-01", metrics: ["heart_rate"] },
      }),
    );
    expect("2025-06-01" < INTRADAY_RETENTION_START).toBe(true);
    expect(old).toMatch(/keeps intraday heart rate for only about 4–5 months.*resting hr 48/);
  });

  it("garmin_get_body_composition summarizes weigh-ins", async () => {
    const { client } = await connect({ activities });
    const data = (
      await client.callTool({
        name: "garmin_get_body_composition",
        arguments: { start_date: daysAgo(400), response_format: "json" },
      })
    ).structuredContent as { summary: Record<string, number> };
    expect(data.summary).toMatchObject({ first_kg: 70, last_kg: 69, change_kg: -1, weigh_ins: 2 });
  });

  it("garmin_get_nutrition reports logged food per day and caches the logs", async () => {
    const { client, requests } = await connect({ activities });
    const args = { start_date: daysAgo(10), end_date: daysAgo(9), response_format: "json" };
    const data = (await client.callTool({ name: "garmin_get_nutrition", arguments: args }))
      .structuredContent as {
      days_with_food_logged: number;
      days: Array<Record<string, unknown>>;
    };
    expect(data.days_with_food_logged).toBe(2);
    expect(data.days[0]).toMatchObject({
      calories: 2000,
      calorie_goal: 2200,
      protein_g: 120,
      hydration_ml: 1500,
    });
    await client.callTool({ name: "garmin_get_nutrition", arguments: args });
    expect(requests.filter((r) => r.url.pathname.startsWith("/nutrition-service/"))).toHaveLength(2); // not re-fetched
  });

  it("garmin_get_womens_health says so when cycle tracking isn't set up", async () => {
    const { client } = await connect({ activities });
    const text = textOf(await client.callTool({ name: "garmin_get_womens_health", arguments: {} }));
    expect(text).toMatch(/cycle tracking isn't set up/);
  });
});
