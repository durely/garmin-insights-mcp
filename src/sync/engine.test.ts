import { describe, expect, it } from "vitest";
import { GarminClient } from "../garmin/client.ts";
import { spanDays } from "../garmin/dates.ts";
import { GarminHttp } from "../garmin/http.ts";
import { openDatabase } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { type FakeActivity, fakeGarmin } from "../testing/fake-garmin.ts";
import { BASE_URL, fakeFetch, noSleep, status } from "../testing/helpers.ts";
import { SyncBusyError, SyncEngine } from "./engine.ts";

const NOW = new Date("2026-10-24T10:00:00Z"); // today = 2026-10-24 in UTC
const HISTORY_START = "2025-01-15";

const ACTIVITIES: FakeActivity[] = [
  {
    activityId: 1,
    startTimeLocal: `${HISTORY_START} 08:00:00`,
    activityType: { typeId: 1, typeKey: "running", parentTypeId: 17 },
  },
  {
    activityId: 2,
    startTimeLocal: "2026-07-01 09:00:00",
    activityType: { typeId: 89, typeKey: "multi_sport", parentTypeId: 17 },
    isParent: true,
  },
  {
    activityId: 3,
    startTimeLocal: "2026-07-01 09:30:00",
    activityType: { typeId: 10, typeKey: "road_biking", parentTypeId: 2 },
    parentId: 2,
  },
  {
    activityId: 4,
    startTimeLocal: "2026-10-23 12:00:00",
    activityType: { typeId: 152, typeKey: "virtual_ride", parentTypeId: 2 },
  },
];

function setup(options: { fail?: (url: URL) => Response | undefined; store?: Store; owner?: string } = {}) {
  const store = options.store ?? new Store(openDatabase(":memory:"));
  const f = fakeFetch({}, fakeGarmin(ACTIVITIES, options.fail));
  const http = new GarminHttp({
    baseUrl: BASE_URL,
    tokens: { getToken: async () => "t", invalidate: async () => {} },
    fetch: f.fetch,
    sleep: noSleep,
    requestsPerSecond: 1_000_000,
  });
  const client = new GarminClient(http);
  const engine = new SyncEngine({
    store,
    client,
    timeZone: "UTC",
    detailDays: 3,
    now: () => NOW,
    ...(options.owner ? { owner: options.owner } : {}),
  });
  return { store, engine, client, requests: f.requests };
}

const totalDays = spanDays(HISTORY_START as never, "2026-10-24" as never); // 648

describe("SyncEngine", () => {
  it("first sync: all activities incl. multisport legs, then full history in capped chunks", async () => {
    const { store, engine, requests } = setup();
    const summary = await engine.start().done;
    expect(summary.status).toBe("completed");
    expect(summary.errors).toEqual([]);

    expect(store.activityStats().count).toBe(4);
    expect(store.getMeta("history_start")).toBe(HISTORY_START);

    const daily = store.getSyncState("daily_summaries");
    expect(daily).toMatchObject({
      oldest_date: HISTORY_START,
      newest_date: "2026-10-24",
      backfill_complete: 1,
    });
    expect(store.getDaily("daily_summaries", "0000-01-01", "9999-12-31")).toHaveLength(totalDays);
    expect(store.getDaily("sleep", "0000-01-01", "9999-12-31")).toHaveLength(totalDays);

    // Sleep requests never exceed Garmin's 31-day cap.
    const sleepCalls = requests.filter((r) => r.url.pathname.includes("dailySleepSummariesByDate"));
    for (const r of sleepCalls) {
      const span = spanDays(
        r.url.searchParams.get("startDate") as never,
        r.url.searchParams.get("endDate") as never,
      );
      expect(span).toBeLessThanOrEqual(31);
    }
    expect(sleepCalls).toHaveLength(Math.ceil(totalDays / 31));

    // Recent per-day detail covers only the last 3 days; days without data are stored as null.
    expect(store.getDaily("heart_rate", "0000-01-01", "9999-12-31").map((d) => d.date)).toEqual([
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
    ]);
    expect(store.getDaily("spo2", "2026-10-24", "2026-10-24")[0]?.data).toBeNull();
    expect(store.latestRun()).toMatchObject({ status: "completed", done_tasks: summary.tasksTotal });
  });

  it("second sync is incremental: recent activities and a small forward window only", async () => {
    const { store, engine } = setup();
    await engine.start().done;
    const second = setup({ store });
    await second.engine.start().done;

    const search = second.requests.filter((r) => r.url.pathname.endsWith("/search/activities"));
    expect(search[0]?.url.searchParams.get("startDate")).toBe("2026-10-17");
    const daily = second.requests.filter((r) => r.url.pathname.endsWith("/dailysummaries"));
    expect(daily.map((r) => r.url.searchParams.get("startDate"))).toEqual(["2026-10-22"]);
    // Only today and yesterday are re-fetched for per-day detail.
    expect(second.requests.filter((r) => r.url.pathname.endsWith("/dailyHeartRate"))).toHaveLength(2);
  });

  it("an interrupted backfill resumes where it stopped, keeping coverage contiguous", async () => {
    const failing = (url: URL) =>
      url.pathname.includes("dailySleepSummariesByDate") &&
      (url.searchParams.get("endDate") ?? "") < "2026-01-01"
        ? status(400)
        : undefined;
    const first = setup({ fail: failing });
    const summary = await first.engine.start().done;
    expect(summary.status).toBe("completed");
    expect(summary.errors.some((e) => e.startsWith("sleep:"))).toBe(true);

    const partial = first.store.getSyncState("sleep");
    expect(partial?.backfill_complete).toBe(0);
    expect((partial?.oldest_date ?? "") > HISTORY_START).toBe(true);
    // What's stored is exactly the contiguous covered window, no gaps.
    const stored = first.store.getDaily("sleep", "0000-01-01", "9999-12-31");
    expect(stored[0]?.date).toBe(partial?.oldest_date);
    expect(stored).toHaveLength(spanDays(partial?.oldest_date as never, "2026-10-24" as never));
    expect(first.store.getSyncState("daily_summaries")?.backfill_complete).toBe(1); // other domains unaffected

    const second = setup({ store: first.store });
    await second.engine.start().done;
    expect(first.store.getSyncState("sleep")).toMatchObject({
      oldest_date: HISTORY_START,
      backfill_complete: 1,
    });
    expect(first.store.getDaily("sleep", "0000-01-01", "9999-12-31")).toHaveLength(totalDays);
  });

  it("allows only one sync at a time across processes, and takes over a stale lease", async () => {
    const store = new Store(openDatabase(":memory:"));
    const a = setup({ store, owner: "process-a" });
    const b = setup({ store, owner: "process-b" });
    const running = a.engine.start();
    expect(() => b.engine.start()).toThrow(SyncBusyError);
    await running.done;
    await b.engine.start().done; // lease released after a finished

    store.tryAcquireLease("dead-process", new Date(NOW.getTime() - 120_000), 60_000);
    await expect(a.engine.start().done).resolves.toMatchObject({ status: "completed" });
  });

  it("aborts the run on fatal errors such as rate limiting", async () => {
    const { engine, store } = setup({
      fail: (url) => (url.pathname.endsWith("/search/activities") ? status(429) : undefined),
    });
    const summary = await engine.start().done;
    expect(summary.status).toBe("failed");
    expect(summary.errors[0]).toMatch(/rate limiting/);
    expect(store.getSyncState("activities")?.last_error).toMatch(/429/);
  });

  it("full mode forgets coverage and re-downloads", async () => {
    const { store, engine } = setup();
    await engine.start().done;
    const again = setup({ store });
    await again.engine.start({ mode: "full", domains: ["hrv"] }).done;
    const hrvCalls = again.requests.filter((r) => r.url.pathname.startsWith("/hrv-service/hrv/daily/"));
    expect(hrvCalls).toHaveLength(Math.ceil(totalDays / 365));
    expect(again.requests.some((r) => r.url.pathname.endsWith("/search/activities"))).toBe(false);
  });

  it("fit_files (opt-in) downloads one file per top-level activity, skipping multisport legs", async () => {
    const store = new Store(openDatabase(":memory:"));
    const fetched: number[] = [];
    const { engine, client } = setup({ store });
    const withFit = new SyncEngine({
      store,
      client,
      timeZone: "UTC",
      detailDays: 3,
      now: () => NOW,
      fitFiles: {
        missing: () => store.activitiesWithoutFit(),
        fetch: async (id) => {
          fetched.push(id);
          store.saveFit({
            id,
            path: `fit/${id}.fit`,
            size: 1,
            sha256: "x",
            downloaded_at: NOW.toISOString(),
          });
        },
      },
    });
    await engine.start({ mode: "auto", domains: ["activities"] }).done;
    const summary = await withFit.start({ mode: "auto", domains: ["fit_files"] }).done;
    expect(summary.status).toBe("completed");
    expect(fetched.sort()).toEqual([1, 2, 4]); // 3 is a leg of 2
    expect(store.getSyncState("fit_files")?.backfill_complete).toBe(1);

    fetched.length = 0;
    await withFit.start({ mode: "auto", domains: ["fit_files"] }).done;
    expect(fetched).toEqual([]); // nothing left to fetch
  });
});
