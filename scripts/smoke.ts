// Live self-check: starts the built server over stdio and calls every tool against the real
// Garmin API, as an MCP client would. Needs a configured Personal API key.
// Usage: npm run build && npm run smoke
//        npm run smoke -- docker run -i --rm ... <image>   (test any server command, e.g. the Docker image)

import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const passthrough = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => k.startsWith("GARMIN_") && v !== undefined),
) as Record<string, string>;

const custom = process.argv.slice(2);
const serverCommand = custom.length > 0 ? custom : ["node", "dist/index.js"];
console.error(`Server command: ${serverCommand.join(" ")}`);

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: serverCommand[0] ?? "node",
    args: serverCommand.slice(1),
    env: { ...getDefaultEnvironment(), ...passthrough },
  }),
);

type CallResult = Awaited<ReturnType<typeof client.callTool>>;
const text = (r: CallResult) => (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

async function call(name: string, args: Record<string, unknown>, expectError = false) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ok = Boolean(result.isError) === expectError;
  console.error(
    `${ok ? "✓" : "✗"} ${name} ${JSON.stringify(args)}${expectError ? " (expects an error)" : ""} (${Date.now() - started} ms)`,
  );
  return result;
}

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  [
    "garmin_download_activity_fit",
    "garmin_get_activity",
    "garmin_get_activity_laps",
    "garmin_get_activity_streams",
    "garmin_get_body_composition",
    "garmin_get_daily_health",
    "garmin_get_hrv",
    "garmin_get_intraday",
    "garmin_get_nutrition",
    "garmin_get_profile",
    "garmin_get_sleep",
    "garmin_list_activities",
    "garmin_status",
    "garmin_sync",
    "garmin_sync_status",
    "garmin_get_womens_health",
    "garmin_analyze_activity",
    "garmin_compare_activities",
    "garmin_query",
    "garmin_recovery_trends",
    "garmin_training_summary",
  ].sort(),
);

const status = await call("garmin_status", { response_format: "json" });
assert.ok(!status.isError, text(status));
assert.equal((status.structuredContent as { connected: boolean }).connected, true, text(status));

const syncStatus = await call("garmin_sync_status", {});
assert.ok(!syncStatus.isError, text(syncStatus));

const profile = await call("garmin_get_profile", {});
assert.ok(!profile.isError, text(profile));

const list = await call("garmin_list_activities", { limit: 5, response_format: "json" });
assert.ok(!list.isError, text(list));
const page = list.structuredContent as {
  total: number;
  activities: Array<{ id: number }>;
  has_more: boolean;
};
console.error(`  total activities in cache: ${page.total}`);
assert.ok(page.activities.length > 0, "expected at least one activity");

const legs = await call("garmin_list_activities", {
  activity_type: "cycling",
  include_multisport_legs: true,
  sort_by: "distance",
  limit: 3,
});
assert.ok(!legs.isError, text(legs));

const firstId = page.activities[0]?.id;
const detail = await call("garmin_get_activity", { activity_id: firstId });
assert.ok(!detail.isError, text(detail));

const laps = await call("garmin_get_activity_laps", { activity_id: firstId });
assert.ok(!laps.isError, text(laps));
const streams = await call("garmin_get_activity_streams", { activity_id: firstId });
assert.ok(!streams.isError, text(streams));
const s = streams.structuredContent as { point_count: number; available_fields: string[] };
console.error(`  streams: ${s.point_count} points; fields ${s.available_fields.join(", ")}`);
const analyzed = await call("garmin_analyze_activity", { activity_id: firstId });
assert.ok(!analyzed.isError, text(analyzed));
const compared = await call("garmin_compare_activities", { activity_ids: [firstId, page.activities[1]?.id] });
assert.ok(!compared.isError, text(compared));
const exported = await call("garmin_download_activity_fit", { activity_id: firstId });
assert.ok(!exported.isError, text(exported));

for (const [name, args] of [
  ["garmin_get_daily_health", {}],
  ["garmin_get_daily_health", { group_by: "month", start_date: "2026-01-01" }],
  ["garmin_get_sleep", {}],
  ["garmin_get_hrv", {}],
  ["garmin_get_intraday", {}],
  ["garmin_get_body_composition", {}],
  ["garmin_get_nutrition", {}],
  ["garmin_get_womens_health", {}],
  ["garmin_training_summary", {}],
  ["garmin_recovery_trends", {}],
  [
    "garmin_query",
    { sql: "SELECT sport, COUNT(*) AS n FROM activities GROUP BY sport ORDER BY n DESC LIMIT 5" },
  ],
] as const) {
  const r = await call(name, args);
  assert.ok(!r.isError, text(r));
}

const invalid = await call("garmin_list_activities", { limit: 500 }, true);
assert.equal(invalid.isError, true, "limit=500 must be rejected by input validation");

console.error("\n--- sample output: garmin_list_activities (markdown) ---\n");
console.error(text(await call("garmin_list_activities", { limit: 3 })));
console.error("\n--- sample output: garmin_get_activity (markdown) ---\n");
console.error(text(detail));

await client.close();
console.error("\nSmoke test passed");
