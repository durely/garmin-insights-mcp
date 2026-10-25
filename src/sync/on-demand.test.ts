import { describe, expect, it } from "vitest";
import { GarminClient } from "../garmin/client.ts";
import type { CalendarDate } from "../garmin/dates.ts";
import { today } from "../garmin/dates.ts";
import { GarminHttp } from "../garmin/http.ts";
import { openDatabase } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { fakeGarmin } from "../testing/fake-garmin.ts";
import { BASE_URL, fakeFetch, noSleep } from "../testing/helpers.ts";
import { ensureDays } from "./on-demand.ts";

function setup() {
  const store = new Store(openDatabase(":memory:"));
  const f = fakeFetch({}, fakeGarmin([]));
  const http = new GarminHttp({
    baseUrl: BASE_URL,
    tokens: { getToken: async () => "t", invalidate: async () => {} },
    fetch: f.fetch,
    sleep: noSleep,
    requestsPerSecond: 1_000_000,
  });
  return { ctx: { store, client: new GarminClient(http), timeZone: "UTC" }, store, requests: f.requests };
}

const d = (s: string) => s as CalendarDate;

describe("ensureDays", () => {
  it("fetches missing days once, but always re-fetches today", async () => {
    const { ctx, requests } = setup();
    const t = today("UTC");
    expect(await ensureDays(ctx, "heart_rate", d("2026-02-01"), d("2026-02-03"))).toBe(3);
    expect(await ensureDays(ctx, "heart_rate", d("2026-02-01"), d("2026-02-03"))).toBe(0);
    expect(await ensureDays(ctx, "heart_rate", t, t)).toBe(1);
    expect(await ensureDays(ctx, "heart_rate", t, t)).toBe(1); // still filling in
    expect(requests).toHaveLength(5);
  });

  it("uses one request per chunk for range domains", async () => {
    const { ctx, store } = setup();
    expect(await ensureDays(ctx, "body_battery", d("2026-02-01"), d("2026-02-10"))).toBe(1);
    expect(store.getDaily("body_battery", "2026-02-01", "2026-02-10")).toHaveLength(10);
  });

  it("caps the number of days per call and rejects unknown domains", async () => {
    const { ctx } = setup();
    await expect(ensureDays(ctx, "heart_rate", d("2026-01-01"), d("2026-03-01"))).rejects.toThrow(
      /At most 31 days/,
    );
    await expect(ensureDays(ctx, "nope", d("2026-01-01"), d("2026-01-01"))).rejects.toThrow(
      /Unknown data domain/,
    );
  });
});
