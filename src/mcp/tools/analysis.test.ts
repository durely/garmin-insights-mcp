import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, daysAgo, textOf } from "../../testing/mcp-harness.ts";

afterEach(closeAll);

const run = (id: number, daysBack: number, extra: Record<string, unknown> = {}) => ({
  activityId: id,
  activityName: `Run ${id}`,
  startTimeLocal: `${daysAgo(daysBack)} 08:00:00`,
  startTimeGMT: `${daysAgo(daysBack)} 08:00:00`,
  activityType: { typeKey: "running", parentTypeId: 17 },
  duration: 3600,
  distance: 10_000,
  averageSpeed: 10_000 / 3600,
  averageHR: 150,
  activityTrainingLoad: 100,
  hrTimeInZone_1: 600,
  hrTimeInZone_2: 2400,
  hrTimeInZone_3: 600,
  ...extra,
});

// Six weeks of training: Garmin load on most runs, one without (to be estimated), plus a ride.
const activities = [
  ...Array.from({ length: 40 }, (_, i) => run(i + 1, i + 1)),
  run(100, 3, { activityTrainingLoad: undefined }),
  {
    ...run(200, 2),
    activityType: { typeKey: "road_biking", parentTypeId: 2 },
    distance: 40_000,
    avgPower: 180,
    normPower: 195,
  },
];

describe("analysis tools", () => {
  it("garmin_training_summary reports volume, intensity, load and fitness per week", async () => {
    const { client } = await connect({ activities });
    const data = (
      await client.callTool({ name: "garmin_training_summary", arguments: { response_format: "json" } })
    ).structuredContent as {
      load_model: { garmin_pct: number; estimated_pct: number; trimp_to_garmin_scale: number };
      periods: Array<{
        sessions: number;
        load: number;
        intensity: { pattern: string } | null;
        ctl: number | null;
      }>;
    };
    expect(data.periods).toHaveLength(12);
    expect(data.load_model.estimated_pct).toBeGreaterThan(0);
    expect(data.load_model.trimp_to_garmin_scale).toBeGreaterThan(0);
    const recent = data.periods.at(-2);
    expect(recent?.sessions).toBeGreaterThan(0);
    expect(recent?.intensity?.pattern).toBe("pyramidal");
    expect(recent?.ctl).toBeGreaterThan(0);

    const cycling = (
      await client.callTool({
        name: "garmin_training_summary",
        arguments: { sport: "cycling", response_format: "json" },
      })
    ).structuredContent as { periods: Array<{ sessions: number }> };
    expect(cycling.periods.reduce((n, p) => n + p.sessions, 0)).toBe(1);
  });

  it("garmin_training_summary keeps long ranges within the response size limit", async () => {
    const { client } = await connect({ activities });
    const result = await client.callTool({
      name: "garmin_training_summary",
      arguments: { start_date: "2020-01-06", group_by: "week", response_format: "json" },
    });
    const data = result.structuredContent as { notes?: string[]; periods: Array<{ period: string }> };
    expect(textOf(result).length).toBeLessThanOrEqual(25_000);
    expect(data.notes?.join(" ")).toMatch(/Only the most recent \d+ of \d+ periods fit/);
    expect((data.periods.at(-1)?.period ?? "") >= daysAgo(7)).toBe(true); // the newest periods are kept
  });

  it("garmin_recovery_trends returns status, flags, weeks and correlations", async () => {
    const { client } = await connect({ activities });
    const text = textOf(await client.callTool({ name: "garmin_recovery_trends", arguments: {} }));
    expect(text).toContain("## Status: last 7 days vs previous 28");
    expect(text).toContain("HRV: 55 ms vs 55 ms (+0)");
    expect(text).toContain("## Correlations");
    expect(text).toContain("_Insights derived in part from Garmin device-sourced data._");
    const tooLong = await client.callTool({
      name: "garmin_recovery_trends",
      arguments: { start_date: daysAgo(400) },
    });
    expect(tooLong.isError).toBe(true);
  });

  it("garmin_compare_activities lines activities up side by side", async () => {
    const { client } = await connect({ activities });
    await client.callTool({ name: "garmin_list_activities", arguments: {} });
    const data = (
      await client.callTool({
        name: "garmin_compare_activities",
        arguments: { activity_ids: [1, 200], response_format: "json" },
      })
    ).structuredContent as {
      activities: Array<{ id: number; efficiency_factor: number | null }>;
      data_source: string;
    };
    expect(data.activities.map((a) => a.id)).toEqual([1, 200]);
    expect(data.data_source).toBe("Insights derived in part from Garmin device-sourced data.");
    expect(data.activities[1]?.efficiency_factor).toBe(1.3); // NP 195 / HR 150
    const missing = await client.callTool({
      name: "garmin_compare_activities",
      arguments: { activity_ids: [1, 999] },
    });
    expect(textOf(missing)).toMatch(/Not in the local cache: 999/);
  });

  it("garmin_analyze_activity analyzes the FIT data of an activity", async () => {
    const { client } = await connect({ activities });
    await client.callTool({ name: "garmin_list_activities", arguments: {} });
    const result = await client.callTool({
      name: "garmin_analyze_activity",
      arguments: { activity_id: 1, ftp_w: 250, response_format: "json" },
    });
    const data = result.structuredContent as {
      power: { ftp_w: number; tss: number };
      ftp_source: string;
      best_hr: unknown[];
    };
    expect(data.ftp_source).toBe("ftp_w argument");
    expect(data.power.ftp_w).toBe(250);
    expect(data.best_hr.length).toBeGreaterThan(0);
  });

  it("garmin_query answers SQL over the views and refuses writes", async () => {
    const { client } = await connect({ activities });
    await client.callTool({ name: "garmin_list_activities", arguments: {} });
    const data = (
      await client.callTool({
        name: "garmin_query",
        arguments: {
          sql: "SELECT sport, COUNT(*) AS n FROM activities GROUP BY sport ORDER BY sport",
          response_format: "json",
        },
      })
    ).structuredContent as { columns: string[]; rows: unknown[][] };
    expect(data.columns).toEqual(["sport", "n"]);
    expect(data.rows).toEqual([
      ["cycling", 1],
      ["running", 41],
    ]);
    const write = await client.callTool({ name: "garmin_query", arguments: { sql: "DELETE FROM activity" } });
    expect(write.isError).toBe(true);
  });

  it("tells the client to credit Garmin as the data source", async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("not made or endorsed by Garmin");
    expect(instructions).toContain("Garmin <device model>");
  });

  it("offers the schema resource and the three prompts", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "activity_deep_dive",
      "recovery_check",
      "weekly_review",
    ]);
    const dive = await client.getPrompt({ name: "activity_deep_dive", arguments: { activity_id: "42" } });
    expect(JSON.stringify(dive.messages)).toContain("activity 42");
    const schema = await client.readResource({ uri: "garmin://schema" });
    expect((schema.contents[0] as { text: string }).text).toContain("activities(id");
  });
});
