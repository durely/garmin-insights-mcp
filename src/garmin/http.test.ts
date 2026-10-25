import { describe, expect, it, vi } from "vitest";
import { BASE_URL, fakeFetch, json, noSleep, status } from "../testing/helpers.ts";
import { GarminApiError } from "./errors.ts";
import { GarminHttp } from "./http.ts";

function tokens(initial = "t1") {
  let current = initial;
  let n = 1;
  return {
    getToken: vi.fn(async () => current),
    invalidate: vi.fn(async () => {
      n += 1;
      current = `t${n}`;
    }),
  };
}

function http(
  fetch: typeof globalThis.fetch,
  extra: Partial<ConstructorParameters<typeof GarminHttp>[0]> = {},
) {
  return new GarminHttp({ baseUrl: BASE_URL, tokens: tokens(), fetch, sleep: noSleep, ...extra });
}

describe("GarminHttp", () => {
  it("sends the bearer token and query parameters, skipping undefined ones", async () => {
    const f = fakeFetch({ "/x": () => json({ ok: true }) });
    const result = await http(f.fetch).getJson("/x", { a: 1, b: undefined, c: true });
    expect(result).toEqual({ ok: true });
    expect(f.requests[0]?.headers.get("authorization")).toBe("Bearer t1");
    expect(f.requests[0]?.url.search).toBe("?a=1&c=true");
  });

  it("returns null for 204 and empty 200 bodies", async () => {
    const f = fakeFetch({ "/none": () => status(204), "/empty": () => new Response("", { status: 200 }) });
    const h = http(f.fetch);
    expect(await h.getJson("/none")).toBeNull();
    expect(await h.getJson("/empty")).toBeNull();
  });

  it("gets a new token once after a 401, then retries", async () => {
    const t = tokens();
    const f = fakeFetch({ "/x": [() => status(401), () => json([1])] });
    const h = new GarminHttp({ baseUrl: BASE_URL, tokens: t, fetch: f.fetch, sleep: noSleep });
    expect(await h.getJson("/x")).toEqual([1]);
    expect(t.invalidate).toHaveBeenCalledOnce();
    expect(f.requests[1]?.headers.get("authorization")).toBe("Bearer t2");
  });

  it("does not loop on repeated 401s", async () => {
    const f = fakeFetch({ "/x": () => status(401) });
    const error = await http(f.fetch)
      .getJson("/x")
      .catch((e: unknown) => e);
    expect((error as GarminApiError).kind).toBe("unauthorized");
    expect(f.requests).toHaveLength(2);
  });

  it("retries 429 and 503 with backoff, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch({
      "/x": [
        () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
        () => status(503),
        () => json({ ok: 1 }),
      ],
    });
    const h = http(f.fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestsPerSecond: 1000,
    });
    expect(await h.getJson("/x")).toEqual({ ok: 1 });
    expect(sleeps.filter((ms) => ms >= 1000)).toHaveLength(2);
    expect(sleeps).toContain(2000);
  });

  it("gives up after maxRetries and maps the status to a typed error", async () => {
    const f = fakeFetch({ "/x": () => status(503) });
    const error = await http(f.fetch, { maxRetries: 2 })
      .getJson("/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GarminApiError);
    expect((error as GarminApiError).kind).toBe("server_error");
    expect(f.requests).toHaveLength(3);
  });

  it("does not retry 400s and explains the likely cause", async () => {
    const f = fakeFetch({ "/x": () => status(400) });
    const error = (await http(f.fetch)
      .getJson("/x")
      .catch((e: unknown) => e)) as GarminApiError;
    expect(error.kind).toBe("bad_request");
    expect(error.message).toMatch(/date range/);
    expect(f.requests).toHaveLength(1);
  });

  it("spaces requests according to requestsPerSecond", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const f = fakeFetch({ "/x": () => json({}) });
    const h = http(f.fetch, {
      requestsPerSecond: 4,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await h.getJson("/x");
    await h.getJson("/x");
    await h.getJson("/x");
    expect(sleeps).toEqual([250, 250]);
  });

  it("does not retry when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    await expect(http(failing).getJson("/x", undefined, controller.signal)).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });
});
