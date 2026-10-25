// Connects an MCP client to a server backed by the fake Garmin API, with a temporary data dir.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../config.ts";
import { type AppContext, createAppContext } from "../mcp/context.ts";
import { createServer } from "../mcp/server.ts";
import { type FakeActivity, fakeGarmin } from "./fake-garmin.ts";
import { fakeFetch, TOKEN_PATH, tokenResponder } from "./helpers.ts";

const open: Array<{ client: Client; ctx: AppContext }> = [];

export async function connect(options: { activities?: FakeActivity[]; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "garmin-mcp-test-"));
  const keyFile = join(dir, "key");
  await writeFile(keyFile, "test-key");
  const config = loadConfig({
    GARMIN_PERSONAL_API_KEY_FILE: keyFile,
    GARMIN_MCP_DATA_DIR: dir,
    GARMIN_MCP_TIMEZONE: "UTC",
    GARMIN_MCP_REQUESTS_PER_SECOND: "20",
    GARMIN_MCP_DETAIL_DAYS: "2",
    ...options.env,
  });
  const f = fakeFetch({ [TOKEN_PATH]: tokenResponder(Date.now()) }, fakeGarmin(options.activities ?? []));
  const ctx = createAppContext(config, { fetch: f.fetch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await createServer(ctx).connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, ctx });
  return { client, ctx, requests: f.requests };
}

export async function closeAll(): Promise<void> {
  for (const { client, ctx } of open.splice(0)) {
    await client.close();
    ctx.sync.stop();
    await ctx.sync.whenDomainSynced("spo2");
  }
}

export const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]?.text ?? "";

/** Today in UTC, and n days before, as yyyy-MM-dd (the harness runs in UTC). */
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
