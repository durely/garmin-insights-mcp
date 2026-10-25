import { describe, expect, it } from "vitest";
import type { SummarizedActivity } from "../garmin/client.ts";
import { openDatabase } from "./db.ts";
import { type ActivityFilter, Store } from "./store.ts";

const base: ActivityFilter = {
  multisport: "parents",
  sortBy: "date",
  sortOrder: "desc",
  limit: 50,
  offset: 0,
};

function seeded() {
  const store = new Store(openDatabase(":memory:"));
  const a = (
    id: number,
    date: string,
    typeKey: string,
    parentTypeId: number,
    extra: Partial<SummarizedActivity> = {},
  ) =>
    ({
      activityId: id,
      activityName: `Activity ${id}`,
      startTimeLocal: `${date} 08:00:00`,
      activityType: { typeKey, parentTypeId },
      ...extra,
    }) as SummarizedActivity;
  store.upsertActivities(
    [
      a(1, "2026-10-01", "running", 17, {
        distance: 10_000,
        duration: 3000,
        activityName: "Morning 100% effort_run",
      }),
      a(2, "2026-10-05", "virtual_ride", 2, { distance: 30_000, duration: 3600 }),
      a(3, "2026-10-10", "road_biking", 2, { distance: 80_000, duration: 9000 }),
      a(4, "2026-10-12", "multi_sport", 17, { isParent: true, distance: 51_500 }),
      a(5, "2026-10-12", "road_biking", 2, { parentId: 4, distance: 40_000 }),
      a(6, "2026-10-12", "running", 17, { parentId: 4, distance: 10_000 }),
    ],
    "2026-10-24T00:00:00Z",
  );
  return store;
}

const ids = (r: { items: SummarizedActivity[] }) => r.items.map((i) => i.activityId);

describe("Store.queryActivities", () => {
  it("matches a parent type across its subtypes", () => {
    expect(ids(seeded().queryActivities({ ...base, type: "cycling" }))).toEqual([3, 2]);
    expect(ids(seeded().queryActivities({ ...base, type: "virtual_ride" }))).toEqual([2]);
  });

  it("shows multisport parents by default, legs instead of parents on request", () => {
    expect(ids(seeded().queryActivities(base))).toEqual([4, 3, 2, 1]);
    expect(ids(seeded().queryActivities({ ...base, multisport: "legs" }))).toEqual([6, 5, 3, 2, 1]);
    expect(ids(seeded().queryActivities({ ...base, multisport: "legs", type: "cycling" }))).toEqual([
      5, 3, 2,
    ]);
  });

  it("filters by date, distance and duration, and reports the total", () => {
    const r = seeded().queryActivities({ ...base, startDate: "2026-10-02", minDistanceM: 20_000, limit: 1 });
    expect(r.total).toBe(3);
    expect(ids(r)).toEqual([4]);
    expect(ids(seeded().queryActivities({ ...base, maxDurationS: 3600 }))).toEqual([2, 1]);
  });

  it("sorts and treats LIKE wildcards in search literally", () => {
    expect(ids(seeded().queryActivities({ ...base, sortBy: "distance" }))).toEqual([3, 4, 2, 1]);
    expect(ids(seeded().queryActivities({ ...base, search: "100% effort_" }))).toEqual([1]);
    expect(ids(seeded().queryActivities({ ...base, search: "0%" }))).toEqual([1]);
    expect(ids(seeded().queryActivities({ ...base, search: "morning" }))).toEqual([1]);
  });

  it("upserts instead of duplicating", () => {
    const store = seeded();
    store.upsertActivities(
      [
        {
          activityId: 1,
          activityName: "Renamed",
          startTimeLocal: "2026-10-01 08:00:00",
          activityType: { typeKey: "running" },
        },
      ],
      "2026-10-25T00:00:00Z",
    );
    expect(store.activityStats().count).toBe(6);
    expect(store.queryActivities({ ...base, search: "Renamed" }).total).toBe(1);
  });
});

describe("Store activity detail cache", () => {
  it("drops a cached detail when the activity summary changes", () => {
    const store = seeded();
    store.saveActivityDetail(1, { activityId: 1 }, [], "2026-10-24T00:00:00Z");
    const unchanged = store.queryActivities({ ...base, search: "100%" }).items;
    store.upsertActivities(unchanged, "2026-10-25T00:00:00Z");
    expect(store.getActivityDetail(1)).toBeDefined();

    store.upsertActivities(
      [{ ...unchanged[0], activityName: "Renamed" } as SummarizedActivity],
      "2026-10-25T00:00:00Z",
    );
    expect(store.getActivityDetail(1)).toBeUndefined();
  });
});

describe("Store privacy", () => {
  it("never stores the owner's name, profile pictures or account ID", () => {
    const store = new Store(openDatabase(":memory:"));
    store.upsertActivities(
      [
        {
          activityId: 9,
          startTimeLocal: "2026-10-01 08:00:00",
          activityType: { typeKey: "running" },
          ownerId: 123,
          ownerFullName: "Jane Doe",
          ownerDisplayName: "jane",
          ownerProfileImageUrlSmall: "https://example.com/me.jpg",
        } as SummarizedActivity,
      ],
      "2026-10-02T00:00:00Z",
    );
    const raw = (store.db.prepare("SELECT raw_json FROM activity WHERE id = 9").get() as { raw_json: string })
      .raw_json;
    expect(raw).not.toMatch(/owner|Jane|example\.com/);
  });
});
