import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { GarminClient } from "../garmin/client.ts";
import { GarminHttp } from "../garmin/http.ts";
import { openDatabase } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { buildFixtureFit, buildFixtureZip, RIDE_SECONDS, RUN_SECONDS } from "../testing/fit-fixture.ts";
import { BASE_URL, fakeFetch, noSleep } from "../testing/helpers.ts";
import { FitFileParserAdapter } from "./fit-file-parser.ts";
import type { ParsedFit } from "./model.ts";
import { extractFit, FitService } from "./service.ts";
import { selectStreams } from "./streams.ts";

let parsed: ParsedFit;
beforeAll(async () => {
  parsed = await new FitFileParserAdapter().parse(buildFixtureFit());
});

describe("FitFileParserAdapter", () => {
  it("normalizes sessions, laps and device", () => {
    const { summary } = parsed;
    expect(summary.device).toMatchObject({ manufacturer: "garmin", product: "Forerunner 965" });
    expect(summary.sessions.map((s) => [s.sport, s.start_offset_s, s.lap_count])).toEqual([
      ["running", 0, 2],
      ["cycling", RUN_SECONDS, 1],
    ]);
    expect(summary.laps.map((l) => [l.session_index, l.intensity, l.avg_hr])).toEqual([
      [0, "active", 138],
      [0, "rest", 142],
      [1, "active", 150],
    ]);
    expect(summary.record_count).toBe(RUN_SECONDS + RIDE_SECONDS + 1);
    expect(summary.metrics.vo2max).toBeNull(); // no physiological messages in this file
  });

  it("reports running cadence in steps/min and cycling cadence in rpm", () => {
    const cadence = parsed.streams.fields.cadence ?? [];
    expect(cadence[10]).toBe(160); // 80 strides/min × 2
    expect(cadence[RUN_SECONDS + 20]).toBe(90);
  });

  it("only lists fields that have data", () => {
    expect(parsed.summary.record_fields.sort()).toEqual([
      "cadence",
      "distance",
      "heart_rate",
      "power",
      "speed",
    ]);
  });
});

describe("selectStreams", () => {
  it("downsamples by averaging into buckets, coarsening to respect max points", () => {
    const r = selectStreams(parsed, {
      fields: ["heart_rate", "power"],
      resolutionS: 10,
      maxPoints: 50,
      sessionIndex: null,
    });
    expect(r.point_count).toBeLessThanOrEqual(50);
    expect(r.resolution_s).toBe(25); // 1200 s / 49 intervals, rounded up
    expect(r.series.power?.[0]).toBeNull(); // no power while running
    // Alternating 180/220 W averages to ~200 (a 25-sample bucket has one extra sample of one value).
    expect(Math.abs((r.series.power?.at(-2) ?? 0) - 200)).toBeLessThanOrEqual(2);
  });

  it("computes stats over raw samples, leaving zeros out of cadence averages", () => {
    const r = selectStreams(parsed, {
      fields: ["cadence"],
      resolutionS: 1,
      maxPoints: 2000,
      sessionIndex: 1,
    });
    expect(r.stats.cadence).toEqual({ min: 0, avg: 90, max: 90 });
  });

  it("measures t from the leg start for a multisport leg, and honours the window", () => {
    const r = selectStreams(parsed, {
      fields: ["speed"],
      resolutionS: 60,
      maxPoints: 500,
      sessionIndex: 1,
      startS: 120,
      endS: 300,
    });
    expect(r.t[0]).toBe(120);
    expect(r.end_s).toBe(300);
    expect(r.stats.speed).toEqual({ min: 8, avg: 8, max: 8 });
  });
});

describe("extractFit", () => {
  it("takes the .fit entry out of Garmin's ZIP", () => {
    const fit = extractFit(buildFixtureZip(42));
    expect(fit.length).toBe(buildFixtureFit().length);
  });

  it("rejects downloads that aren't ZIPs or contain no FIT file", () => {
    expect(() => extractFit(new TextEncoder().encode('{"error":"406"}'))).toThrow(/valid ZIP/);
    expect(() => extractFit(zipSync({ "readme.txt": new Uint8Array([1]) }))).toThrow(/no FIT file/);
  });
});

describe("FitService", () => {
  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), "garmin-fit-test-"));
    const store = new Store(openDatabase(":memory:"));
    const f = fakeFetch({}, (req) => {
      if (req.url.pathname === "/activity-service/activity/102") {
        // A leg that isn't in the local cache yet: Garmin's detail says who its parent is.
        return new Response(
          JSON.stringify({
            activityId: 102,
            parentId: 100,
            summaryDTO: { startTimeGMT: "2026-01-01T10:10:00.0" },
          }),
          { status: 200 },
        );
      }
      const id = Number(req.url.pathname.split("/").at(-1));
      return new Response(buildFixtureZip(id), {
        status: 200,
        headers: { "content-type": "application/x-zip-compressed" },
      });
    });
    const http = new GarminHttp({
      baseUrl: BASE_URL,
      tokens: { getToken: async () => "t", invalidate: async () => {} },
      fetch: f.fetch,
      sleep: noSleep,
      requestsPerSecond: 1_000_000,
    });
    const client = new GarminClient(http);
    const newService = () => new FitService({ store, client, parser: new FitFileParserAdapter(), dataDir });
    const service = newService();
    // A multisport parent (100) and its ride leg (101), as the sync stores them.
    store.upsertActivities(
      [
        {
          activityId: 100,
          startTimeLocal: "2026-01-01 11:00:00",
          startTimeGMT: "2026-01-01 10:00:00",
          activityType: { typeKey: "multi_sport" },
          isParent: true,
        },
        {
          activityId: 101,
          parentId: 100,
          startTimeLocal: "2026-01-01 11:10:00",
          startTimeGMT: "2026-01-01 10:10:00",
          activityType: { typeKey: "road_biking" },
        },
      ],
      "2026-01-02T00:00:00Z",
    );
    return { store, service, newService, dataDir, requests: f.requests };
  }

  it("downloads once, stores the file privately and caches the summary", async () => {
    const { service, store, dataDir, requests } = await setup();
    const a = await service.getSummary(100);
    const b = await service.getSummary(100);
    expect(a.summary.sessions).toHaveLength(2);
    expect(b.sessionIndex).toBeNull();
    expect(requests).toHaveLength(1);
    const row = store.getFit(100);
    expect(row?.summary_json).toBeTruthy();
    expect((await readFile(join(dataDir, row?.path ?? ""))).length).toBe(row?.size);
  });

  it("resolves a multisport leg to its parent's file and session", async () => {
    const { service, requests } = await setup();
    const leg = await service.getParsed(101);
    expect(leg.fileId).toBe(100);
    expect(leg.sessionIndex).toBe(1);
    expect(requests[0]?.url.pathname).toMatch(/\/100$/);
  });

  it("re-downloads a FIT file that was deleted from disk", async () => {
    const { service, newService, store, dataDir, requests } = await setup();
    await service.getParsed(100);
    await rm(join(dataDir, store.getFit(100)?.path ?? ""));
    // A new process has no in-memory parse, so it must read the file and notice it's gone.
    const parsedAgain = await newService().getParsed(100);
    expect(parsedAgain.summary.sessions).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it("asks Garmin about an activity that isn't cached, so an unknown leg still maps to its parent", async () => {
    const { service, requests } = await setup();
    const leg = await service.getParsed(102);
    expect(leg).toMatchObject({ fileId: 100, sessionIndex: 1 });
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/activity-service/activity/102",
      "/download-service/files/activity/100",
    ]);
  });
});
