// Data access for the local cache. All SQL lives here.

import type { SQLInputValue } from "node:sqlite";
import {
  type ActivityDetail,
  type ActivityWorkout,
  parentTypeKey,
  type SummarizedActivity,
} from "../garmin/index.ts";
import { type Db, transaction } from "./db.ts";

export interface SyncState {
  domain: string;
  oldest_date: string | null;
  newest_date: string | null;
  backfill_complete: number;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface SyncRun {
  id: number;
  owner: string;
  mode: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  total_tasks: number;
  done_tasks: number;
  current: string | null;
  error_count: number;
  last_error: string | null;
}

export interface Lease {
  owner: string;
  started_at: string;
  heartbeat_at: string;
}

export interface FitRow {
  id: number;
  path: string;
  size: number;
  sha256: string;
  downloaded_at: string;
  parser: string | null;
  summary_json: string | null;
  parsed_at: string | null;
}

export const ACTIVITY_SORT_COLUMNS = {
  date: "start_local",
  distance: "distance_m",
  duration: "duration_s",
  elevation_gain: "elevation_gain_m",
  training_load: "training_load",
} as const;

export interface ActivityFilter {
  startDate?: string;
  endDate?: string;
  /** Matches the type key or its parent type key, so "cycling" includes virtual_ride and road_biking. */
  type?: string;
  search?: string;
  minDistanceM?: number;
  maxDistanceM?: number;
  minDurationS?: number;
  maxDurationS?: number;
  /** "parents": multisport parent rows, no legs (Garmin's default). "legs": the legs instead of the parents. */
  multisport: "parents" | "legs";
  sortBy: keyof typeof ACTIVITY_SORT_COLUMNS;
  sortOrder: "asc" | "desc";
  limit: number;
  offset: number;
}

export class Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ---- activities ----

  upsertActivities(items: SummarizedActivity[], fetchedAt: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO activity (
        id, parent_id, is_multisport_parent, type_key, parent_type_key, name, start_local, start_utc, start_date,
        duration_s, moving_s, distance_m, elevation_gain_m, avg_speed_mps, avg_hr, max_hr, avg_power_w,
        norm_power_w, calories, aerobic_te, anaerobic_te, training_load, tss, vo2max, raw_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        parent_id = excluded.parent_id, is_multisport_parent = excluded.is_multisport_parent,
        type_key = excluded.type_key, parent_type_key = excluded.parent_type_key, name = excluded.name,
        start_local = excluded.start_local, start_utc = excluded.start_utc, start_date = excluded.start_date,
        duration_s = excluded.duration_s, moving_s = excluded.moving_s, distance_m = excluded.distance_m,
        elevation_gain_m = excluded.elevation_gain_m, avg_speed_mps = excluded.avg_speed_mps,
        avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, avg_power_w = excluded.avg_power_w,
        norm_power_w = excluded.norm_power_w, calories = excluded.calories, aerobic_te = excluded.aerobic_te,
        anaerobic_te = excluded.anaerobic_te, training_load = excluded.training_load, tss = excluded.tss,
        vo2max = excluded.vo2max, raw_json = excluded.raw_json, fetched_at = excluded.fetched_at
    `);
    // Garmin fills in some metrics after upload, and users rename or edit activities: when the
    // summary changed, drop the cached detail so garmin_get_activity fetches it again.
    const invalidateDetail = this.db.prepare(
      "DELETE FROM activity_detail WHERE id = ? AND EXISTS (SELECT 1 FROM activity WHERE id = ? AND raw_json <> ?)",
    );
    let count = 0;
    transaction(this.db, () => {
      for (const a of items) {
        if (!a.activityId) continue;
        const json = JSON.stringify(withoutOwner(a));
        invalidateDetail.run(a.activityId, a.activityId, json);
        stmt.run(
          a.activityId,
          v(a.parentId),
          a.isParent ? 1 : 0,
          v(a.activityType?.typeKey),
          parentTypeKey(a.activityType),
          v(a.activityName),
          v(a.startTimeLocal),
          v(a.startTimeGMT),
          a.startTimeLocal ? a.startTimeLocal.slice(0, 10) : null,
          v(a.duration),
          v(a.movingDuration),
          v(a.distance),
          v(a.elevationGain),
          v(a.averageSpeed),
          v(a.averageHR),
          v(a.maxHR),
          v(a.avgPower),
          v(a.normPower),
          v(a.calories),
          v(a.aerobicTrainingEffect),
          v(a.anaerobicTrainingEffect),
          v(a.activityTrainingLoad),
          v(a.trainingStressScore),
          v(a.vO2MaxValue),
          json,
          fetchedAt,
        );
        count++;
      }
    });
    return count;
  }

  queryActivities(filter: ActivityFilter): { total: number; items: SummarizedActivity[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const add = (clause: string, ...values: SQLInputValue[]) => {
      where.push(clause);
      params.push(...values);
    };
    if (filter.startDate) add("start_date >= ?", filter.startDate);
    if (filter.endDate) add("start_date <= ?", filter.endDate);
    if (filter.type) add("(type_key = ? OR parent_type_key = ?)", filter.type, filter.type);
    if (filter.search) add("name LIKE ? ESCAPE '\\'", `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`);
    if (filter.minDistanceM !== undefined) add("distance_m >= ?", filter.minDistanceM);
    if (filter.maxDistanceM !== undefined) add("distance_m <= ?", filter.maxDistanceM);
    if (filter.minDurationS !== undefined) add("duration_s >= ?", filter.minDurationS);
    if (filter.maxDurationS !== undefined) add("duration_s <= ?", filter.maxDurationS);
    add(filter.multisport === "legs" ? "is_multisport_parent = 0" : "parent_id IS NULL");

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM activity ${whereSql}`).get(...params) as { n: number }
    ).n;
    const column = ACTIVITY_SORT_COLUMNS[filter.sortBy];
    const order = filter.sortOrder === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT raw_json FROM activity ${whereSql} ORDER BY ${column} IS NULL, ${column} ${order}, id ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as Array<{ raw_json: string }>;
    return { total, items: rows.map((r) => JSON.parse(r.raw_json) as SummarizedActivity) };
  }

  activityStats(): { count: number; earliest: string | null; latest: string | null } {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS count, MIN(start_date) AS earliest, MAX(start_date) AS latest FROM activity",
      )
      .get() as { count: number; earliest: string | null; latest: string | null };
  }

  getActivityDetail(
    id: number,
  ): { detail: ActivityDetail; workouts: ActivityWorkout[]; fetched_at: string } | undefined {
    const row = this.db
      .prepare("SELECT raw_json, workouts_json, fetched_at FROM activity_detail WHERE id = ?")
      .get(id) as { raw_json: string; workouts_json: string; fetched_at: string } | undefined;
    if (!row) return undefined;
    return {
      detail: JSON.parse(row.raw_json),
      workouts: JSON.parse(row.workouts_json),
      fetched_at: row.fetched_at,
    };
  }

  saveActivityDetail(
    id: number,
    detail: ActivityDetail,
    workouts: ActivityWorkout[],
    fetchedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO activity_detail (id, raw_json, workouts_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET raw_json = excluded.raw_json, workouts_json = excluded.workouts_json,
           fetched_at = excluded.fetched_at`,
      )
      .run(id, JSON.stringify(detail), JSON.stringify(workouts), fetchedAt);
  }

  /** The cached columns needed to locate an activity's FIT file and session. */
  getActivityRef(
    id: number,
  ): { id: number; parent_id: number | null; type_key: string | null; start_utc: string | null } | undefined {
    return this.db.prepare("SELECT id, parent_id, type_key, start_utc FROM activity WHERE id = ?").get(id) as
      | { id: number; parent_id: number | null; type_key: string | null; start_utc: string | null }
      | undefined;
  }

  // ---- FIT files ----

  getFit(id: number): FitRow | undefined {
    return this.db.prepare("SELECT * FROM activity_fit WHERE id = ?").get(id) as FitRow | undefined;
  }

  saveFit(row: Omit<FitRow, "parser" | "summary_json" | "parsed_at">): void {
    this.db
      .prepare(
        `INSERT INTO activity_fit (id, path, size, sha256, downloaded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET path = excluded.path, size = excluded.size, sha256 = excluded.sha256,
           downloaded_at = excluded.downloaded_at, parser = NULL, summary_json = NULL, parsed_at = NULL`,
      )
      .run(row.id, row.path, row.size, row.sha256, row.downloaded_at);
  }

  saveFitSummary(id: number, parser: string, summary: unknown, parsedAt: string): void {
    this.db
      .prepare("UPDATE activity_fit SET parser = ?, summary_json = ?, parsed_at = ? WHERE id = ?")
      .run(parser, JSON.stringify(summary), parsedAt, id);
  }

  deleteFit(id: number): void {
    this.db.prepare("DELETE FROM activity_fit WHERE id = ?").run(id);
  }

  /** Top-level activities (no multisport legs) without a downloaded FIT file, newest first. */
  activitiesWithoutFit(): number[] {
    const rows = this.db
      .prepare(
        `SELECT a.id FROM activity a LEFT JOIN activity_fit f ON f.id = a.id
         WHERE a.parent_id IS NULL AND f.id IS NULL ORDER BY a.start_local DESC`,
      )
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  fitStats(): { files: number; bytes: number } {
    return this.db
      .prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM activity_fit")
      .get() as {
      files: number;
      bytes: number;
    };
  }

  // ---- per-day data ----

  putDaily(domain: string, entries: Array<{ date: string; data: unknown }>, fetchedAt: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO daily_raw (domain, date, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (domain, date) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
    );
    transaction(this.db, () => {
      for (const e of entries) stmt.run(domain, e.date, JSON.stringify(e.data), fetchedAt);
    });
  }

  getDaily<T = unknown>(domain: string, start: string, end: string): Array<{ date: string; data: T }> {
    const rows = this.db
      .prepare("SELECT date, json FROM daily_raw WHERE domain = ? AND date BETWEEN ? AND ? ORDER BY date")
      .all(domain, start, end) as Array<{ date: string; json: string }>;
    return rows.map((r) => ({ date: r.date, data: JSON.parse(r.json) as T }));
  }

  dailyDates(domain: string, start: string, end: string): Set<string> {
    const rows = this.db
      .prepare("SELECT date FROM daily_raw WHERE domain = ? AND date BETWEEN ? AND ?")
      .all(domain, start, end) as Array<{ date: string }>;
    return new Set(rows.map((r) => r.date));
  }

  dailyStats(): Array<{ domain: string; days: number; earliest: string; latest: string }> {
    return this.db
      .prepare(
        "SELECT domain, COUNT(*) AS days, MIN(date) AS earliest, MAX(date) AS latest FROM daily_raw GROUP BY domain ORDER BY domain",
      )
      .all() as Array<{ domain: string; days: number; earliest: string; latest: string }>;
  }

  // ---- sync state ----

  getSyncState(domain: string): SyncState | undefined {
    return this.db.prepare("SELECT * FROM sync_state WHERE domain = ?").get(domain) as SyncState | undefined;
  }

  allSyncStates(): SyncState[] {
    return this.db.prepare("SELECT * FROM sync_state ORDER BY domain").all() as unknown as SyncState[];
  }

  updateSyncState(domain: string, patch: Partial<Omit<SyncState, "domain">>): void {
    this.db.prepare("INSERT INTO sync_state (domain) VALUES (?) ON CONFLICT (domain) DO NOTHING").run(domain);
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE sync_state SET ${set} WHERE domain = ?`)
      .run(...keys.map((k) => v(patch[k] as SQLInputValue | undefined)), domain);
  }

  resetSyncState(domains: string[]): void {
    const stmt = this.db.prepare("DELETE FROM sync_state WHERE domain = ?");
    transaction(this.db, () => {
      for (const d of domains) stmt.run(d);
    });
  }

  // ---- lease ----

  /** Takes the sync lease unless another live owner holds it. Returns true when acquired. */
  tryAcquireLease(owner: string, now: Date, staleMs: number): boolean {
    return transaction(this.db, () => {
      const current = this.db.prepare("SELECT * FROM sync_lease WHERE id = 1").get() as Lease | undefined;
      if (current && current.owner !== owner && now.getTime() - Date.parse(current.heartbeat_at) < staleMs) {
        return false;
      }
      const ts = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO sync_lease (id, owner, started_at, heartbeat_at) VALUES (1, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, started_at = excluded.started_at,
             heartbeat_at = excluded.heartbeat_at`,
        )
        .run(owner, ts, ts);
      return true;
    });
  }

  heartbeatLease(owner: string, now: Date): void {
    this.db
      .prepare("UPDATE sync_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?")
      .run(now.toISOString(), owner);
  }

  releaseLease(owner: string): void {
    this.db.prepare("DELETE FROM sync_lease WHERE id = 1 AND owner = ?").run(owner);
  }

  /** The live lease holder, if any. */
  activeLease(now: Date, staleMs: number): Lease | undefined {
    const lease = this.db.prepare("SELECT * FROM sync_lease WHERE id = 1").get() as Lease | undefined;
    if (!lease || now.getTime() - Date.parse(lease.heartbeat_at) >= staleMs) return undefined;
    return lease;
  }

  // ---- runs ----

  createRun(owner: string, mode: string, totalTasks: number, startedAt: string): number {
    const result = this.db
      .prepare(
        "INSERT INTO sync_run (owner, mode, started_at, status, total_tasks) VALUES (?, ?, ?, 'running', ?)",
      )
      .run(owner, mode, startedAt, totalTasks);
    return Number(result.lastInsertRowid);
  }

  updateRun(id: number, patch: Partial<Omit<SyncRun, "id">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE sync_run SET ${set} WHERE id = ?`)
      .run(...keys.map((k) => v(patch[k] as SQLInputValue | undefined)), id);
  }

  latestRun(): SyncRun | undefined {
    return this.db.prepare("SELECT * FROM sync_run ORDER BY id DESC LIMIT 1").get() as SyncRun | undefined;
  }

  /** Marks runs left "running" by a process that died (no live lease) as interrupted. */
  markOrphanedRuns(liveOwner: string | undefined, now: string): void {
    this.db
      .prepare(
        "UPDATE sync_run SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND (? IS NULL OR owner <> ?)",
      )
      .run(now, liveOwner ?? null, liveOwner ?? null);
  }
}

/** node:sqlite rejects undefined; store it as NULL. */
function v(value: SQLInputValue | undefined): SQLInputValue {
  return value === undefined ? null : value;
}

/** Owner identity fields Garmin includes in every activity summary; never stored. */
const OWNER_FIELDS = [
  "ownerId",
  "ownerDisplayName",
  "ownerFullName",
  "ownerProfileImageUrlSmall",
  "ownerProfileImageUrlMedium",
  "ownerProfileImageUrlLarge",
] as const;

function withoutOwner(a: SummarizedActivity): SummarizedActivity {
  const copy = { ...a } as Record<string, unknown>;
  for (const key of OWNER_FIELDS) delete copy[key];
  return copy as SummarizedActivity;
}
