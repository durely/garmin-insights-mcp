import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_URL, fakeFetch, makeJwt, status, TOKEN_PATH, tokenResponder } from "../testing/helpers.ts";
import { TokenManager } from "./auth.ts";
import { GarminApiError } from "./errors.ts";

const NOW = Date.parse("2026-10-24T10:00:00Z");

function manager(
  fetch: typeof globalThis.fetch,
  options: { key?: string; cacheFile?: string; now?: () => number } = {},
) {
  return new TokenManager({
    baseUrl: BASE_URL,
    loadKey: async () => options.key ?? "test-key",
    fetch,
    now: options.now ?? (() => NOW),
    ...(options.cacheFile ? { cacheFile: options.cacheFile } : {}),
  });
}

describe("TokenManager", () => {
  it("exchanges the key with an ApiKey header and accepts a bare JWT body", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    const token = await manager(f.fetch).getToken();
    expect(token.split(".")).toHaveLength(3);
    expect(f.requests[0]?.method).toBe("POST");
    expect(f.requests[0]?.headers.get("authorization")).toBe("ApiKey test-key");
  });

  it("also accepts a JSON token body", async () => {
    const jwt = makeJwt({ exp: Math.floor(NOW / 1000) + 86400 });
    const f = fakeFetch({ [TOKEN_PATH]: () => new Response(JSON.stringify({ access_token: jwt })) });
    expect(await manager(f.fetch).getToken()).toBe(jwt);
  });

  it("reuses a fresh token and shares one exchange between concurrent callers", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    const m = manager(f.fetch);
    const [a, b] = await Promise.all([m.getToken(), m.getToken()]);
    await m.getToken();
    expect(a).toBe(b);
    expect(f.requests).toHaveLength(1);
  });

  it("re-exchanges when less than an hour of validity remains", async () => {
    let now = NOW;
    const f = fakeFetch({ [TOKEN_PATH]: () => tokenResponder(now)() });
    const m = manager(f.fetch, { now: () => now });
    await m.getToken();
    now += 23.5 * 3600_000;
    await m.getToken();
    expect(f.requests).toHaveLength(2);
  });

  it("re-exchanges after invalidate()", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    const m = manager(f.fetch);
    await m.getToken();
    await m.invalidate();
    await m.getToken();
    expect(f.requests).toHaveLength(2);
  });

  it("persists the token with 0600 permissions and reuses it across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "garmin-mcp-test-"));
    const cacheFile = join(dir, "nested", "token.json");
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    await manager(f.fetch, { cacheFile }).getToken();
    await manager(f.fetch, { cacheFile }).getToken();
    expect(f.requests).toHaveLength(1);
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(cacheFile, "utf8")).not.toContain("test-key");
  });

  it("ignores a cached token issued for a different key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "garmin-mcp-test-"));
    const cacheFile = join(dir, "token.json");
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    await manager(f.fetch, { cacheFile, key: "old-key" }).getToken();
    await manager(f.fetch, { cacheFile, key: "new-key" }).getToken();
    expect(f.requests).toHaveLength(2);
  });

  it("reports a rejected key with recovery instructions", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: () => status(401) });
    const error = await manager(f.fetch)
      .getToken()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GarminApiError);
    expect((error as GarminApiError).kind).toBe("key_rejected");
    expect((error as GarminApiError).message).toContain("personalApiToken");
  });
});

describe("TokenManager cache failures", () => {
  it("keeps working when the cache file can't be written", async () => {
    const warnings: string[] = [];
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(NOW) });
    const m = new TokenManager({
      baseUrl: BASE_URL,
      loadKey: async () => "k",
      fetch: f.fetch,
      now: () => NOW,
      cacheFile: "/dev/null/not-a-dir/token.json",
      onWarning: (w) => warnings.push(w),
    });
    expect(await m.getToken()).toContain(".");
    expect(warnings[0]).toMatch(/Could not cache/);
  });
});
