import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { BASE_URL, fakeFetch, makeJwt, status, TOKEN_PATH, tokenResponder } from "../testing/helpers.ts";
import { authCommand } from "./auth.ts";

let dir: string;
let keyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "garmin-auth-"));
  keyFile = join(dir, "config", "garmin", "key");
});

function run(
  options: { check?: boolean; input?: string; fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
) {
  const env = {
    GARMIN_PERSONAL_API_KEY_FILE: keyFile,
    GARMIN_MCP_DATA_DIR: join(dir, "data"),
    GARMIN_PERSONAL_API_BASE_URL: BASE_URL,
    ...options.env,
  };
  let output = "";
  const accepted = fakeFetch({ [TOKEN_PATH]: tokenResponder(Date.now()) });
  const done = authCommand(
    loadConfig(env),
    { check: options.check ?? false },
    {
      readKey: async () => options.input ?? "",
      write: (text) => {
        output += text;
      },
      env,
      fetch: options.fetch ?? accepted.fetch,
    },
  );
  return done.then((code) => ({ code, output }));
}

const rejected = () => fakeFetch({ [TOKEN_PATH]: () => status(401) }).fetch;
const unreachable = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;

describe("auth", () => {
  it("checks the key with Garmin and saves it readable only by the owner", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(Date.now()) });
    const { code, output } = await run({ input: "  GCDC_invented-key\n", fetch: f.fetch });
    expect(code).toBe(0);
    expect(f.requests[0]?.headers.get("authorization")).toBe("ApiKey GCDC_invented-key");
    expect(await readFile(keyFile, "utf8")).toBe("GCDC_invented-key");
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(output).toContain(`Saved to ${keyFile}`);
    expect(output).not.toContain("GCDC_invented-key");
  });

  it("overwrites an existing key file and tightens its permissions", async () => {
    await mkdir(join(dir, "config", "garmin"), { recursive: true });
    await writeFile(keyFile, "old-key", { mode: 0o644 });
    expect((await run({ input: "new-key" })).code).toBe(0);
    expect(await readFile(keyFile, "utf8")).toBe("new-key");
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  });

  it("saves nothing when Garmin rejects the key", async () => {
    const { code, output } = await run({ input: "bad-key", fetch: rejected() });
    expect(code).toBe(1);
    expect(output).toContain("Garmin rejected the Personal API key");
    expect(output).toContain("Nothing saved");
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it("saves nothing when Garmin can't be reached, and doesn't blame the key", async () => {
    const { code, output } = await run({ input: "some-key", fetch: unreachable });
    expect(code).toBe(1);
    expect(output).toContain("Couldn't check the key");
    expect(output).not.toContain("rejected");
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it("stops on empty input", async () => {
    const { code, output } = await run({ input: "   " });
    expect(code).toBe(1);
    expect(output).toContain("No key entered");
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it("fails before prompting when the key file can't be written", async () => {
    await mkdir(join(dir, "config", "garmin"), { recursive: true });
    await writeFile(keyFile, "mounted-key");
    await chmod(keyFile, 0o400);
    let prompted = false;
    const env = { GARMIN_PERSONAL_API_KEY_FILE: keyFile, GARMIN_MCP_DATA_DIR: join(dir, "data") };
    const code = await authCommand(
      loadConfig(env),
      { check: false },
      {
        readKey: async () => {
          prompted = true;
          return "new-key";
        },
        write: () => {},
        env,
      },
    );
    expect(code).toBe(1);
    expect(prompted).toBe(false);
    expect(await readFile(keyFile, "utf8")).toBe("mounted-key");
  });

  it("warns when GARMIN_PERSONAL_API_KEY overrides the saved file", async () => {
    const { code, output } = await run({ input: "file-key", env: { GARMIN_PERSONAL_API_KEY: "env-key" } });
    expect(code).toBe(0);
    expect(output).toContain("GARMIN_PERSONAL_API_KEY is set and takes precedence");
  });

  it("reminds about the expiry date only when it isn't set", async () => {
    expect((await run({ input: "k" })).output).toContain("GARMIN_API_KEY_EXPIRES");
    expect((await run({ input: "k", env: { GARMIN_API_KEY_EXPIRES: "2027-10-24" } })).output).not.toContain(
      "GARMIN_API_KEY_EXPIRES",
    );
  });
});

describe("auth --check", () => {
  it("verifies the key file with Garmin without writing anything", async () => {
    await mkdir(join(dir, "config", "garmin"), { recursive: true });
    await writeFile(keyFile, "file-key\n", { mode: 0o600 });
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(Date.now()) });
    const { code, output } = await run({ check: true, fetch: f.fetch });
    expect(code).toBe(0);
    expect(f.requests[0]?.headers.get("authorization")).toBe("ApiKey file-key");
    expect(output).toContain(keyFile);
    expect(output).toContain("Garmin accepted the key");
    await expect(stat(join(dir, "data"))).rejects.toThrow(); // no token cache, no data dir
  });

  it("checks the environment variable when it is set", async () => {
    const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(Date.now()) });
    const { code, output } = await run({
      check: true,
      fetch: f.fetch,
      env: { GARMIN_PERSONAL_API_KEY: "env-key" },
    });
    expect(code).toBe(0);
    expect(output).toContain("GARMIN_PERSONAL_API_KEY");
    expect(f.requests[0]?.headers.get("authorization")).toBe("ApiKey env-key");
  });

  it("asks Garmin every time, so a revoked key fails even with a fresh cached token", async () => {
    await mkdir(join(dir, "config", "garmin"), { recursive: true });
    await writeFile(keyFile, "revoked-key");
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(
      join(dir, "data", "token.json"),
      JSON.stringify({
        accessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        expiresAt: Date.now() + 86400_000,
        keyFingerprint: createHash("sha256").update("revoked-key").digest("hex").slice(0, 16),
      }),
    );
    const { code, output } = await run({ check: true, fetch: rejected() });
    expect(code).toBe(1);
    expect(output).toContain("Garmin rejected the Personal API key");
  });

  it("exits 1 when no key is configured", async () => {
    const { code, output } = await run({ check: true });
    expect(code).toBe(1);
    expect(output).toContain("No API key configured");
  });
});
