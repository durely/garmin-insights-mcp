import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { type FakeActivity, fakeGarmin } from "../testing/fake-garmin.ts";
import { fakeFetch, json, status, TOKEN_PATH, tokenResponder } from "../testing/helpers.ts";
import { type AppContext, createAppContext } from "./context.ts";
import { createServer } from "./server.ts";

const SEARCH = "/activitylist-service/activities/search/activities";

// Invented sample data, shaped like real responses (including fields that must NOT leak).
function activity(id: number, overrides: Partial<FakeActivity> = {}): FakeActivity {
  return {
    activityId: id,
    activityName: `Run ${id}`,
    startTimeLocal: `2026-10-${String(10 + id).padStart(2, "0")} 07:00:00`,
    startTimeGMT: "2026-10-20 05:00:00",
    activityType: { typeId: 1, typeKey: "running", parentTypeId: 17 },
    distance: 10_000,
    duration: 3000,
    averageSpeed: 10_000 / 3000,
    averageHR: 145,
    maxHR: 170,
    aerobicTrainingEffect: 3.2,
    trainingEffectLabel: "TEMPO",
    activityTrainingLoad: 101.7,
    ownerFullName: "Jane Doe",
    ownerProfileImageUrlSmall: "https://example.com/me.jpg",
    startLatitude: 12.3456,
    startLongitude: 45.6789,
    ...overrides,
  };
}

const contexts: AppContext[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const ctx of contexts.splice(0)) {
    ctx.sync.stop();
    await ctx.sync.whenDomainSynced("spo2");
  }
});

async function connect(
  options: {
    activities?: FakeActivity[];
    routes?: Parameters<typeof fakeFetch>[0];
    fail?: (url: URL) => Response | undefined;
    env?: Record<string, string>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "garmin-mcp-tools-"));
  const keyFile = join(dir, "key");
  await writeFile(keyFile, "test-key");
  const config = loadConfig({
    GARMIN_PERSONAL_API_KEY_FILE: keyFile,
    GARMIN_MCP_DATA_DIR: dir,
    GARMIN_MCP_TIMEZONE: "Europe/Brussels",
    GARMIN_MCP_REQUESTS_PER_SECOND: "20",
    GARMIN_MCP_DETAIL_DAYS: "2",
    ...options.env,
  });
  const f = fakeFetch(
    { [TOKEN_PATH]: tokenResponder(Date.now()), ...options.routes },
    fakeGarmin(options.activities ?? [], options.fail),
  );
  const ctx = createAppContext(config, { fetch: f.fetch });
  contexts.push(ctx);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return { client, ctx, requests: f.requests };
}

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]?.text ?? "";
type Page = { total: number; activities: Array<{ id: number }>; has_more: boolean; next_offset?: number };

describe("MCP tools", () => {
  it("registers the tools; only garmin_sync writes (to the local cache)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "garmin_analyze_activity",
      "garmin_compare_activities",
      "garmin_download_activity_fit",
      "garmin_get_activity",
      "garmin_get_activity_laps",
      "garmin_get_activity_streams",
      "garmin_get_body_composition",
      "garmin_get_daily_health",
      "garmin_get_hrv",
      "garmin_get_intraday",
      "garmin_get_nutrition",
      "garmin_get_profile",
      "garmin_get_sleep",
      "garmin_get_womens_health",
      "garmin_list_activities",
      "garmin_query",
      "garmin_recovery_trends",
      "garmin_status",
      "garmin_sync",
      "garmin_sync_status",
      "garmin_training_summary",
    ]);
    const writers = ["garmin_sync", "garmin_download_activity_fit"];
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(!writers.includes(t.name));
  });

  it("garmin_list_activities syncs on first use, then filters locally with totals", async () => {
    const { client, requests } = await connect({
      activities: [
        activity(1),
        activity(2, { activityType: { typeKey: "virtual_ride", parentTypeId: 2 }, distance: 30_000 }),
        activity(3, {
          activityType: { typeKey: "multi_sport", parentTypeId: 17 },
          isParent: true,
          distance: 51_000,
        }),
        activity(4, {
          activityType: { typeKey: "road_biking", parentTypeId: 2 },
          parentId: 3,
          distance: 40_000,
        }),
      ],
    });
    const cycling = await client.callTool({
      name: "garmin_list_activities",
      arguments: { activity_type: "cycling", response_format: "json" },
    });
    expect((cycling.structuredContent as Page).activities.map((a) => a.id)).toEqual([2]);

    const legs = await client.callTool({
      name: "garmin_list_activities",
      arguments: { activity_type: "cycling", include_multisport_legs: true, response_format: "json" },
    });
    expect((legs.structuredContent as Page).activities.map((a) => a.id)).toEqual([4, 2]);

    const page = (
      await client.callTool({
        name: "garmin_list_activities",
        arguments: { min_distance_km: 20, limit: 1, response_format: "json" },
      })
    ).structuredContent as Page;
    expect(page).toMatchObject({ total: 2, has_more: true, next_offset: 1 });

    // One sync up front; the later calls were answered from the cache.
    expect(requests.filter((r) => r.url.pathname === SEARCH).length).toBe(1);
  });

  it("never leaks owner identity or GPS", async () => {
    const { client } = await connect({ activities: [activity(1), activity(2)] });
    const result = await client.callTool({
      name: "garmin_list_activities",
      arguments: { response_format: "json" },
    });
    const text = textOf(result);
    expect(text).not.toContain("Jane Doe");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("12.3456");
  });

  it("renders sport-specific markdown", async () => {
    const { client } = await connect({
      activities: [
        activity(1),
        activity(2, {
          activityType: { typeKey: "road_biking", parentTypeId: 2 },
          distance: 60_000,
          duration: 7200,
          averageSpeed: 60_000 / 7200,
          avgPower: 180,
          normPower: 195,
        }),
      ],
    });
    const text = textOf(await client.callTool({ name: "garmin_list_activities", arguments: {} }));
    expect(text).toContain("of 2");
    expect(text).toContain("5:00 /km");
    expect(text).toContain("30.0 km/h");
    expect(text).toContain("180 W (NP 195)");
  });

  it("explains empty results", async () => {
    const { client } = await connect({ activities: [activity(1)] });
    const text = textOf(
      await client.callTool({ name: "garmin_list_activities", arguments: { activity_type: "swimming" } }),
    );
    expect(text).toMatch(/No activities match/);
  });

  it("reports a failed first sync as a tool error", async () => {
    const { client } = await connect({ fail: (url) => (url.pathname === SEARCH ? status(400) : undefined) });
    const result = await client.callTool({ name: "garmin_list_activities", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/first Garmin sync of activities failed.*HTTP 400/);
  });

  it("rejects invalid input before doing anything", async () => {
    const { client, requests } = await connect();
    const result = await client.callTool({ name: "garmin_list_activities", arguments: { limit: 500 } });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("garmin_status reports a missing key without failing", async () => {
    const { client } = await connect({ env: { GARMIN_PERSONAL_API_KEY_FILE: "/nonexistent/key" } });
    const result = await client.callTool({ name: "garmin_status", arguments: { response_format: "json" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { connected: boolean; error: string };
    expect(data.connected).toBe(false);
    expect(data.error).toMatch(/personalApiToken/);
  });

  it("garmin_status warns when the key is about to expire", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { client } = await connect({
      routes: { "/userprofile-service/userprofile/settings": () => json({ timeZone: "Europe/Brussels" }) },
      env: { GARMIN_API_KEY_EXPIRES: soon },
    });
    const result = await client.callTool({ name: "garmin_status", arguments: { response_format: "json" } });
    const data = result.structuredContent as { connected: boolean; warnings: string[] };
    expect(data.connected).toBe(true);
    expect(data.warnings.join(" ")).toMatch(/expires in/);
  });

  it("garmin_get_activity combines detail and workouts, and caches them", async () => {
    const { client, requests } = await connect({
      routes: {
        "/activity-service/activity/42": () =>
          json({
            activityId: 42,
            activityName: "Intervals",
            activityTypeDTO: { typeKey: "running" },
            summaryDTO: {
              duration: 3600,
              distance: 12_000,
              averageSpeed: 3.33,
              averageHR: 150,
              trainingEffect: 3.8,
            },
            splitSummaries: [{ splitType: "INTERVAL_ACTIVE", noOfSplits: 6, duration: 1800, distance: 6000 }],
            metadataDTO: { childIds: [] },
          }),
        "/activity-service/activity/42/workouts": () => json([{ workoutName: "6x1k", sport: "RUNNING" }]),
      },
    });
    const text = textOf(
      await client.callTool({ name: "garmin_get_activity", arguments: { activity_id: 42 } }),
    );
    expect(text).toContain("# Intervals [42]");
    expect(text).toContain("INTERVAL_ACTIVE");
    expect(text).toContain("6x1k");

    await client.callTool({ name: "garmin_get_activity", arguments: { activity_id: 42 } });
    expect(requests.filter((r) => r.url.pathname === "/activity-service/activity/42")).toHaveLength(1);
  });

  it("garmin_sync runs in the background and garmin_sync_status reports coverage", async () => {
    const { client, ctx } = await connect({ activities: [activity(1)] });
    const started = await client.callTool({ name: "garmin_sync", arguments: {} });
    expect(textOf(started)).toMatch(/started/);
    await ctx.sync.whenDomainSynced("spo2");

    const result = await client.callTool({
      name: "garmin_sync_status",
      arguments: { response_format: "json" },
    });
    const data = result.structuredContent as {
      sync: { status: string };
      domains: Array<{ domain: string; all_history: boolean; activities?: number }>;
    };
    expect(data.sync.status).toBe("completed");
    expect(data.domains.find((d) => d.domain === "activities")).toMatchObject({
      activities: 1,
      all_history: true,
    });
    expect(data.domains.find((d) => d.domain === "daily_summaries")?.all_history).toBe(true);
    expect(textOf(await client.callTool({ name: "garmin_sync_status", arguments: {} }))).toContain(
      "| daily_summaries |",
    );
  });

  describe("FIT tools", () => {
    // A multisport parent and its ride leg; the fake API serves the synthetic run+ride FIT file.
    const multisport = [
      activity(3, {
        activityType: { typeKey: "multi_sport", parentTypeId: 17 },
        isParent: true,
        startTimeGMT: "2026-01-01 10:00:00",
      }),
      activity(4, {
        activityType: { typeKey: "road_biking", parentTypeId: 2 },
        parentId: 3,
        startTimeGMT: "2026-01-01 10:10:00",
      }),
    ];

    it("garmin_get_activity_laps returns a leg's own laps, numbered from the leg start", async () => {
      const { client, requests } = await connect({ activities: multisport });
      await client.callTool({ name: "garmin_list_activities", arguments: {} }); // first sync stores the activities
      const result = await client.callTool({
        name: "garmin_get_activity_laps",
        arguments: { activity_id: 4, response_format: "json" },
      });
      const data = result.structuredContent as {
        multisport_parent_id: number;
        lap_count: number;
        laps: Array<{ number: number; start_offset_s: number }>;
        device: { product: string };
      };
      expect(data).toMatchObject({
        multisport_parent_id: 3,
        lap_count: 1,
        device: { product: "Forerunner 965" },
      });
      expect(data.laps[0]).toMatchObject({ number: 1, start_offset_s: 0 });
      expect(
        requests.filter((r) => r.url.pathname.startsWith("/download-service/")).map((r) => r.url.pathname),
      ).toEqual(["/download-service/files/activity/3"]);
      const md = textOf(
        await client.callTool({ name: "garmin_get_activity_laps", arguments: { activity_id: 3 } }),
      );
      expect(md).toContain("## Sessions");
      expect(md).toContain("| 2 | +5:00 | rest |");
    });

    it("garmin_get_activity_streams returns the available fields and rejects missing ones", async () => {
      const { client } = await connect({ activities: multisport });
      await client.callTool({ name: "garmin_list_activities", arguments: {} });
      const result = await client.callTool({
        name: "garmin_get_activity_streams",
        arguments: { activity_id: 3 },
      });
      const data = result.structuredContent as {
        series: Record<string, unknown[]>;
        available_fields: string[];
      };
      expect(Object.keys(data.series).sort()).toEqual(["cadence", "heart_rate", "power", "speed"]);
      expect(data.available_fields).not.toContain("position");

      const bad = await client.callTool({
        name: "garmin_get_activity_streams",
        arguments: { activity_id: 3, fields: ["altitude"] },
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatch(/no altitude data.*Available fields/);
    });

    it("garmin_get_activity_streams coarsens the resolution to stay within the size limit", async () => {
      const { client } = await connect({ activities: multisport });
      await client.callTool({ name: "garmin_list_activities", arguments: {} });
      const result = await client.callTool({
        name: "garmin_get_activity_streams",
        arguments: {
          activity_id: 3,
          fields: ["heart_rate", "power", "speed", "cadence", "distance"],
          resolution_s: 1,
          max_points: 2000,
        },
      });
      const data = result.structuredContent as { resolution_s: number; note?: string };
      expect(textOf(result).length).toBeLessThanOrEqual(25_000);
      expect(data.resolution_s).toBeGreaterThan(1);
      expect(data.note).toMatch(/coarsened/);
    });

    it("garmin_download_activity_fit exports once and never overwrites", async () => {
      const { client, ctx } = await connect({ activities: multisport });
      await client.callTool({ name: "garmin_list_activities", arguments: {} });
      const first = textOf(
        await client.callTool({ name: "garmin_download_activity_fit", arguments: { activity_id: 4 } }),
      );
      expect(first).toContain(join(ctx.config.dataDir, "exports", "3.fit"));
      expect(first).toMatch(/whole multisport activity 3/);
      const second = textOf(
        await client.callTool({ name: "garmin_download_activity_fit", arguments: { activity_id: 3 } }),
      );
      expect(second).toMatch(/^Already exported/);
    });
  });
});
