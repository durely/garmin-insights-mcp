// Runs one read-only SQL query in a worker thread, so a slow query can be killed by a timeout.

import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { file, sql, maxRows } = workerData as { file: string; sql: string; maxRows: number };

try {
  const db = new DatabaseSync(file, { readOnly: true });
  const stmt = db.prepare(sql);
  const columns = stmt.columns().map((c) => c.name);
  const rows: unknown[][] = [];
  let truncated = false;
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(
      columns.map((c) => {
        const v = row[c];
        return typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? `<${v.length} bytes>` : v;
      }),
    );
  }
  db.close();
  parentPort?.postMessage({ ok: true, columns, rows, truncated });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
