import { describe, expect, it } from "vitest";
import { GarminClient } from "../garmin/client.ts";
import { GarminHttp } from "../garmin/http.ts";
import { openDatabase } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { fakeGarmin } from "../testing/fake-garmin.ts";
import { BASE_URL, fakeFetch, noSleep } from "../testing/helpers.ts";
import { SyncEngine } from "./engine.ts";
import { Freshness } from "./freshness.ts";

function setup(autoSync: boolean) {
  const store = new Store(openDatabase(":memory:"));
  const f = fakeFetch(
    {},
    fakeGarmin([
      {
        activityId: 1,
        startTimeLocal: "2026-10-20 08:00:00",
        activityType: { typeKey: "running", parentTypeId: 17 },
      },
    ]),
  );
  const http = new GarminHttp({
    baseUrl: BASE_URL,
    tokens: { getToken: async () => "t", invalidate: async () => {} },
    fetch: f.fetch,
    sleep: noSleep,
    requestsPerSecond: 1_000_000,
  });
  const engine = new SyncEngine({ store, client: new GarminClient(http), timeZone: "UTC", detailDays: 2 });
  const freshness = new Freshness(engine, store, { autoSync, staleAfterMs: 3_600_000, refreshWaitMs: 5000 });
  return { store, engine, freshness, requests: f.requests };
}

describe("Freshness", () => {
  it("runs the first sync and waits for the requested domain", async () => {
    const { store, engine, freshness } = setup(true);
    await freshness.ensure("activities");
    expect(store.activityStats().count).toBe(1);
    await engine.whenDomainSynced("spo2"); // let the background part finish
  });

  it("refuses to start from an empty cache when auto-sync is off", async () => {
    const { freshness } = setup(false);
    await expect(freshness.ensure("activities")).rejects.toThrow(/garmin_sync/);
  });

  it("serves fresh data without syncing, and refreshes stale data", async () => {
    const { store, engine, freshness, requests } = setup(true);
    await engine.start().done;
    const before = requests.length;

    await freshness.ensure("activities");
    expect(requests.length).toBe(before); // fresh: no calls

    store.updateSyncState("activities", {
      last_success_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    await freshness.ensure("activities");
    expect(requests.length).toBeGreaterThan(before);
    await engine.whenDomainSynced("spo2");
  });
});

describe("Freshness after a crashed session", () => {
  it("takes over once the dead session's lease goes stale", async () => {
    const store = new Store(openDatabase(":memory:"));
    const f = fakeFetch(
      {},
      fakeGarmin([
        { activityId: 1, startTimeLocal: "2026-10-20 08:00:00", activityType: { typeKey: "running" } },
      ]),
    );
    const http = new GarminHttp({
      baseUrl: BASE_URL,
      tokens: { getToken: async () => "t", invalidate: async () => {} },
      fetch: f.fetch,
      sleep: noSleep,
      requestsPerSecond: 1_000_000,
    });
    const engine = new SyncEngine({
      store,
      client: new GarminClient(http),
      timeZone: "UTC",
      detailDays: 2,
      leaseStaleMs: 300,
    });
    store.tryAcquireLease("crashed-session", new Date(), 300); // looks live for another 300 ms
    const freshness = new Freshness(engine, store, {
      autoSync: true,
      staleAfterMs: 3_600_000,
      firstSyncWaitMs: 5000,
      pollMs: 50,
    });
    await freshness.ensure("activities");
    expect(store.activityStats().count).toBe(1);
    await engine.whenDomainSynced("spo2");
  });
});
