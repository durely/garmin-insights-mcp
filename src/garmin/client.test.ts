import { describe, expect, it } from "vitest";
import { BASE_URL, fakeFetch, json, noSleep, status } from "../testing/helpers.ts";
import { GarminClient } from "./client.ts";
import type { CalendarDate } from "./dates.ts";
import { GarminApiError } from "./errors.ts";
import { GarminHttp } from "./http.ts";

const d = (s: string) => s as CalendarDate;

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const http = new GarminHttp({
    baseUrl: BASE_URL,
    tokens: { getToken: async () => "t", invalidate: async () => {} },
    fetch: f.fetch,
    sleep: noSleep,
    requestsPerSecond: 1000,
  });
  return { client: new GarminClient(http), requests: f.requests };
}

describe("GarminClient", () => {
  it("rejects ranges longer than the endpoint cap before calling Garmin", async () => {
    const { client: c, requests } = client({});
    await expect(c.getDailySteps(d("2026-01-01"), d("2026-01-29"))).rejects.toThrow(/at most 28 days/);
    await expect(c.getSleepSummaries(d("2026-01-01"), d("2026-02-01"))).rejects.toThrow(/at most 31 days/);
    await expect(c.getDailySummaries(d("2025-01-01"), d("2026-01-01"))).rejects.toThrow(/at most 365 days/);
    expect(requests).toHaveLength(0);
  });

  it("rejects reversed ranges", async () => {
    const { client: c } = client({});
    await expect(c.getHrvDaily(d("2026-02-01"), d("2026-01-01"))).rejects.toBeInstanceOf(GarminApiError);
  });

  it("builds path- and query-style range requests", async () => {
    const { client: c, requests } = client({
      "/usersummary-service/stats/steps/daily/2026-01-01/2026-01-28": () => json([]),
      "/sleep-service/sleep/dailySleepSummariesByDate": () => json([]),
    });
    await c.getDailySteps(d("2026-01-01"), d("2026-01-28"));
    await c.getSleepSummaries(d("2026-01-01"), d("2026-01-31"));
    expect(requests[1]?.url.search).toBe("?startDate=2026-01-01&endDate=2026-01-31");
  });

  it("turns 204 on list endpoints into an empty array", async () => {
    const { client: c } = client({ "/activitylist-service/activities/search/activities": () => status(204) });
    expect(await c.searchActivities()).toEqual([]);
  });

  it("caps the activity search limit at 200", async () => {
    const { client: c, requests } = client({});
    await expect(c.searchActivities({ limit: 500 })).rejects.toThrow(/at most 200/);
    expect(requests).toHaveLength(0);
  });

  it("normalises fitness age from an object or an array", async () => {
    const one = { fitnessAge: 30.5 };
    const { client: c } = client({
      "/fitnessage-service/fitnessage/v2/2026-10-24": [() => json(one), () => json([one])],
    });
    expect(await c.getFitnessAge(d("2026-10-24"))).toEqual(one);
    expect(await c.getFitnessAge(d("2026-10-24"))).toEqual(one);
  });

  it("validates activity IDs", async () => {
    const { client: c } = client({});
    await expect(c.getActivity(-1)).rejects.toThrow(/positive integer/);
    await expect(c.downloadActivityFile(1.5)).rejects.toThrow(/positive integer/);
  });
});
