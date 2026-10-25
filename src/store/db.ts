// SQLite database: opening, pragmas and schema migrations (tracked with PRAGMA user_version).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Append-only: never edit a released migration, add a new one.
 * Raw Garmin JSON is always kept, so new columns or views can be derived later without re-fetching.
 */
const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE activity (
    id                   INTEGER PRIMARY KEY,
    parent_id            INTEGER,
    is_multisport_parent INTEGER NOT NULL DEFAULT 0,
    type_key             TEXT,
    parent_type_key      TEXT,
    name                 TEXT,
    start_local          TEXT,
    start_utc            TEXT,
    start_date           TEXT,
    duration_s           REAL,
    moving_s             REAL,
    distance_m           REAL,
    elevation_gain_m     REAL,
    avg_speed_mps        REAL,
    avg_hr               REAL,
    max_hr               REAL,
    avg_power_w          REAL,
    norm_power_w         REAL,
    calories             REAL,
    aerobic_te           REAL,
    anaerobic_te         REAL,
    training_load        REAL,
    tss                  REAL,
    vo2max               REAL,
    raw_json             TEXT NOT NULL,
    fetched_at           TEXT NOT NULL
  );
  CREATE INDEX activity_start_date ON activity (start_date);
  CREATE INDEX activity_type ON activity (type_key);
  CREATE INDEX activity_parent_type ON activity (parent_type_key);
  CREATE INDEX activity_parent ON activity (parent_id);

  CREATE TABLE activity_detail (
    id            INTEGER PRIMARY KEY,
    raw_json      TEXT NOT NULL,
    workouts_json TEXT NOT NULL,
    fetched_at    TEXT NOT NULL
  );

  -- One row per (domain, local calendar date): range responses are split into days.
  CREATE TABLE daily_raw (
    domain     TEXT NOT NULL,
    date       TEXT NOT NULL,
    json       TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (domain, date)
  ) WITHOUT ROWID;

  -- Contiguous coverage [oldest_date, newest_date] per domain.
  CREATE TABLE sync_state (
    domain            TEXT PRIMARY KEY,
    oldest_date       TEXT,
    newest_date       TEXT,
    backfill_complete INTEGER NOT NULL DEFAULT 0,
    last_success_at   TEXT,
    last_error        TEXT,
    last_error_at     TEXT
  );

  -- Cross-process lock: only one sync at a time across all server processes and the CLI.
  CREATE TABLE sync_lease (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    owner        TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  );

  CREATE TABLE sync_run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner       TEXT NOT NULL,
    mode        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    total_tasks INTEGER NOT NULL DEFAULT 0,
    done_tasks  INTEGER NOT NULL DEFAULT 0,
    current     TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );
  `,
  // 2: FIT files (stored on disk; parsed summary cached here)
  `
  CREATE TABLE activity_fit (
    id            INTEGER PRIMARY KEY, -- activity the file was downloaded for (the parent, for multisport)
    path          TEXT NOT NULL,       -- relative to the data directory
    size          INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    downloaded_at TEXT NOT NULL,
    parser        TEXT,                -- parser + summary version that produced summary_json
    summary_json  TEXT,
    parsed_at     TEXT
  );
  `,
  // 3: readable views over the raw JSON (used by the health tools and SQL queries), and a
  //    re-fetch of the Body Battery curve at 15-minute resolution (it was synced with 6 points/day).
  `
  CREATE VIEW daily AS
  SELECT
    date,
    json_extract(json, '$.movement.steps.value')                    AS steps,
    json_extract(json, '$.movement.steps.goal')                     AS step_goal,
    json_extract(json, '$.movement.steps.distanceInMeters')         AS walk_distance_m,
    json_extract(json, '$.movement.floorsAscended.value')           AS floors_up,
    json_extract(json, '$.heartRate.restingValue')                  AS resting_hr,
    json_extract(json, '$.heartRate.minValue')                      AS min_hr,
    json_extract(json, '$.heartRate.maxValue')                      AS max_hr,
    json_extract(json, '$.stress.avgLevel')                         AS stress_avg,
    json_extract(json, '$.stress.maxLevel')                         AS stress_max,
    round(json_extract(json, '$.stress.restProportion') * 100, 1)   AS stress_rest_pct,
    round(json_extract(json, '$.stress.lowStressProportion') * 100, 1)    AS stress_low_pct,
    round(json_extract(json, '$.stress.mediumStressProportion') * 100, 1) AS stress_medium_pct,
    round(json_extract(json, '$.stress.highStressProportion') * 100, 1)   AS stress_high_pct,
    json_extract(json, '$.bodyBattery.minValue')                    AS body_battery_min,
    json_extract(json, '$.bodyBattery.maxValue')                    AS body_battery_max,
    json_extract(json, '$.bodyBattery.chargedValue')                AS body_battery_charged,
    json_extract(json, '$.bodyBattery.drainedValue')                AS body_battery_drained,
    json_extract(json, '$.intensityMinutes.moderate')               AS intensity_moderate_min,
    json_extract(json, '$.intensityMinutes.vigorous')               AS intensity_vigorous_min,
    json_extract(json, '$.calories.burnedTotal')                    AS calories_total,
    json_extract(json, '$.calories.burnedActive')                   AS calories_active,
    json_extract(json, '$.respiration.avgValue')                    AS respiration_avg,
    json_extract(json, '$.hydration.consumedInMl')                  AS hydration_ml
  FROM daily_raw WHERE domain = 'daily_summaries';

  -- Garmin's sleep date is the morning you wake up. "Local" timestamps are local wall-clock time
  -- encoded as epoch milliseconds, so they convert without a time zone.
  CREATE VIEW sleep AS
  SELECT
    date,
    datetime(json_extract(json, '$.sleepStartTimestampLocal') / 1000, 'unixepoch') AS start_local,
    datetime(json_extract(json, '$.sleepEndTimestampLocal') / 1000, 'unixepoch')   AS end_local,
    json_extract(json, '$.sleepTimeSeconds')           AS sleep_s,
    json_extract(json, '$.deepSleepSeconds')           AS deep_s,
    json_extract(json, '$.lightSleepSeconds')          AS light_s,
    json_extract(json, '$.remSleepSeconds')            AS rem_s,
    json_extract(json, '$.awakeSleepSeconds')          AS awake_s,
    json_extract(json, '$.napTimeSeconds')             AS nap_s,
    json_extract(json, '$.sleepScores.overall.value')  AS score,
    json_extract(json, '$.sleepScores.overall.qualifierKey') AS quality,
    json_extract(json, '$.sleepScoreFeedback')         AS feedback,
    json_extract(json, '$.awakeCount')                 AS awake_count,
    json_extract(json, '$.averageRespirationValue')    AS respiration_avg,
    json_extract(json, '$.avgSleepStress')             AS sleep_stress_avg
  FROM daily_raw
  WHERE domain = 'sleep' AND json_extract(json, '$.sleepTimeSeconds') IS NOT NULL;

  CREATE VIEW hrv AS
  SELECT
    date,
    json_extract(json, '$.lastNightAvg')           AS last_night_avg,
    json_extract(json, '$.lastNight5MinHigh')      AS last_night_5min_high,
    json_extract(json, '$.weeklyAvg')              AS weekly_avg,
    json_extract(json, '$.baseline.balancedLow')   AS baseline_low,
    json_extract(json, '$.baseline.balancedUpper') AS baseline_high,
    json_extract(json, '$.status')                 AS status
  FROM daily_raw WHERE domain = 'hrv';

  -- Garmin stores weight and masses in grams.
  CREATE VIEW weight AS
  SELECT
    date,
    round(json_extract(json, '$.latestWeight.weight') / 1000.0, 2)     AS weight_kg,
    json_extract(json, '$.latestWeight.bmi')                           AS bmi,
    json_extract(json, '$.latestWeight.bodyFat')                       AS body_fat_pct,
    json_extract(json, '$.latestWeight.bodyWater')                     AS body_water_pct,
    round(json_extract(json, '$.latestWeight.muscleMass') / 1000.0, 2) AS muscle_mass_kg,
    round(json_extract(json, '$.latestWeight.boneMass') / 1000.0, 2)   AS bone_mass_kg,
    json_extract(json, '$.latestWeight.visceralFat')                   AS visceral_fat,
    json_extract(json, '$.latestWeight.sourceType')                    AS source,
    json_extract(json, '$.numOfWeightEntries')                         AS entries
  FROM daily_raw WHERE domain = 'weight' AND json_extract(json, '$.latestWeight.weight') IS NOT NULL;

  CREATE VIEW activities AS
  SELECT id, parent_id, is_multisport_parent, type_key, parent_type_key AS sport, name, start_local, start_date,
         duration_s, moving_s, distance_m, elevation_gain_m, avg_speed_mps, avg_hr, max_hr, avg_power_w,
         norm_power_w, calories, aerobic_te, anaerobic_te, training_load, tss, vo2max
  FROM activity;

  DELETE FROM daily_raw WHERE domain = 'body_battery';
  DELETE FROM sync_state WHERE domain = 'body_battery';
  `,
  // 4: activity summaries no longer keep the owner's name, display name, profile picture URLs or
  //    account ID (nothing uses them, and garmin_query could otherwise return them).
  `
  UPDATE activity SET raw_json = json_remove(raw_json,
    '$.ownerId', '$.ownerDisplayName', '$.ownerFullName',
    '$.ownerProfileImageUrlSmall', '$.ownerProfileImageUrlMedium', '$.ownerProfileImageUrlLarge');
  `,
];

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000"); // several server processes may share one file
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Runs fn in a write transaction. BEGIN IMMEDIATE takes the write lock up front, avoiding upgrade deadlocks. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
