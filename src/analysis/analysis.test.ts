import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FitFileParserAdapter } from "../fit/fit-file-parser.ts";
import type { ParsedFit } from "../fit/model.ts";
import type { CalendarDate } from "../garmin/dates.ts";
import { runQuery, validateQuery } from "../query/run.ts";
import type { LoadRow, RecoveryRow } from "../store/analysis.ts";
import { openDatabase } from "../store/db.ts";
import { buildFixtureFit, RUN_SECONDS } from "../testing/fit-fixture.ts";
import { analyzeActivity, normalizedPower } from "./activity.ts";
import { activityLoad, banisterTrimp, calibrateScale, fitnessSeries } from "./load.ts";
import { bestAverage, fastestDistance, median, pearson } from "./stats.ts";
import { intensityOf, periodStart, recoveryAnalysis, trainingPeriods } from "./training.ts";

const d = (s: string) => s as CalendarDate;
const seconds = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("stats", () => {
  it("finds the best average over a time window, tolerating gaps", () => {
    const t = seconds(100);
    const v = t.map((i) => (i >= 40 && i < 60 ? 300 : 100));
    expect(bestAverage(t, v, 20)).toEqual({ value: 300, start_s: 40 });
    expect(bestAverage(t, v, 200)).toBeNull();
    const withGaps = v.map((x, i) => (i % 2 ? null : x));
    // Every other sample: a 20 s window needs one 100 W sample at its edge → (10×300 + 100) / 11.
    expect(bestAverage(t, withGaps, 20)?.value).toBeCloseTo(3100 / 11, 5);
  });

  it("finds the fastest time over a distance from a cumulative stream", () => {
    const t = seconds(600);
    const dist = t.map((i) => (i < 300 ? i * 3 : 900 + (i - 300) * 5)); // 3 m/s, then 5 m/s
    expect(fastestDistance(t, dist, 1000)).toEqual({ seconds: 200, start_s: 300 });
    expect(fastestDistance(t, dist, 10_000)).toBeNull();
  });

  it("computes median and Pearson correlation over present values", () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(pearson([1, 2, 3, 4, null], [2, 4, 6, 8, 10]).r).toBeCloseTo(1);
    expect(pearson([1, 2], [1, 2]).r).toBeNull();
  });
});

describe("load", () => {
  it("computes Banister TRIMP and calibrates it to Garmin's scale", () => {
    expect(banisterTrimp(150, 3600, 50, 190)).toBeCloseTo(
      60 * (100 / 140) * 0.64 * Math.exp(1.92 * (100 / 140)),
      5,
    );
    const rows = Array.from({ length: 25 }, () => ({ training_load: 120, avg_hr: 150, duration_s: 3600 }));
    const scale = calibrateScale(rows, 50, 190) as number;
    expect(scale).toBeCloseTo(120 / (banisterTrimp(150, 3600, 50, 190) as number), 5);
    expect(calibrateScale(rows.slice(0, 5), 50, 190)).toBeNull(); // too few to calibrate
    const settings = { restingHr: 50, maxHr: 190, scale };
    expect(activityLoad({ training_load: 80, avg_hr: 150, duration_s: 3600 }, settings)).toEqual({
      load: 80,
      source: "garmin",
    });
    expect(activityLoad({ training_load: null, avg_hr: 150, duration_s: 3600 }, settings).load).toBeCloseTo(
      120,
      5,
    );
    expect(activityLoad({ training_load: null, avg_hr: null, duration_s: 3600 }, settings).source).toBe(
      "none",
    );
  });

  it("builds a fitness/fatigue/form series from daily load", () => {
    const series = fitnessSeries(new Map([["2026-01-01", 100]]), d("2026-01-01"), d("2026-01-03"));
    expect(series[0]).toMatchObject({ load: 100, ctl: 2.4, atl: 14.3, tsb: 0 });
    expect(series[1]?.tsb).toBeCloseTo(2.4 - 14.3, 0); // yesterday's CTL − ATL
    expect(series[2]?.atl).toBeLessThan(series[1]?.atl as number);
  });
});

describe("training", () => {
  const row = (date: string, extra: Partial<LoadRow> = {}): LoadRow => ({
    id: Math.random(),
    start_date: date,
    sport: "running",
    type_key: "running",
    name: null,
    duration_s: 3600,
    distance_m: 10_000,
    elevation_gain_m: 50,
    avg_hr: 150,
    training_load: 100,
    hr_z1: 600,
    hr_z2: 2400,
    hr_z3: 300,
    hr_z4: 200,
    hr_z5: 100,
    ...extra,
  });

  it("buckets by Monday-based week and by month", () => {
    expect(periodStart("2026-10-25", "week")).toBe("2026-10-19"); // Sunday → Monday before
    expect(periodStart("2026-10-19", "week")).toBe("2026-10-19");
    expect(periodStart("2026-10-25", "month")).toBe("2026-10-01");
  });

  it("classifies the intensity distribution from zone times", () => {
    expect(intensityOf([row("2026-01-01")])).toMatchObject({
      low_pct: 83,
      moderate_pct: 8,
      high_pct: 8,
      pattern: "pyramidal",
    });
    expect(
      intensityOf([row("2026-01-01", { hr_z1: null, hr_z2: null, hr_z3: null, hr_z4: null, hr_z5: null })]),
    ).toBeNull();
  });

  it("summarizes periods per sport, including empty weeks", () => {
    const rows = [
      row("2026-03-02"),
      row("2026-03-04", { sport: "cycling", distance_m: 40_000 }),
      row("2026-03-17"),
    ];
    const settings = { restingHr: 50, maxHr: 190, scale: null };
    const periods = trainingPeriods(rows, settings, {
      start: "2026-03-02",
      end: "2026-03-22",
      period: "week",
      fitness: [],
    });
    expect(periods.map((p) => [p.period, p.sessions, p.distance_km, p.load])).toEqual([
      ["2026-03-02", 2, 50, 200],
      ["2026-03-09", 0, 0, 0],
      ["2026-03-16", 1, 10, 100],
    ]);
    expect(periods[0]?.by_sport.map((s) => s.sport).sort()).toEqual(["cycling", "running"]);
  });

  it("flags recovery days against a rolling baseline", () => {
    const rows: RecoveryRow[] = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`.replace(/-(3[2-9]|4\d)$/, (m) => m),
      resting_hr: 48 + (i % 2),
      hrv: 55 + (i % 3),
      hrv_status: "BALANCED",
      sleep_score: 80,
      sleep_s: 27_000,
      body_battery_max: 85,
      stress_avg: 25,
    })).slice(0, 31);
    const last = rows.at(-1) as RecoveryRow;
    last.hrv = 30;
    last.resting_hr = 60;
    last.sleep_score = 50;
    const result = recoveryAnalysis(rows, new Map(), [], "2026-01-29");
    expect(result.days.at(-1)?.flags).toEqual([
      "HRV below baseline",
      "resting HR above baseline",
      "poor sleep",
    ]);
    expect(result.days[0]?.flags).toEqual([]);
    expect(result.correlations[0]?.reading).toBe("too few days");
  });
});

describe("analyzeActivity on the synthetic run + ride FIT", () => {
  let parsed: ParsedFit;
  beforeAll(async () => {
    parsed = await new FitFileParserAdapter().parse(buildFixtureFit());
  });
  const zones = {
    floors: [120, 135, 145, 155, 170] as [number, number, number, number, number],
    maxHr: 190,
    source: "test",
  };

  it("puts the run leg's heart rate in the right zone and detects lap-based intervals", () => {
    const a = analyzeActivity(parsed, { sessionIndex: 0, family: "run", hrZones: zones, ftp: null });
    expect(a.duration_s).toBe(RUN_SECONDS - 1);
    expect(a.hr_zones?.find((z) => z.zone.startsWith("Z2"))?.pct).toBe(100); // 140 bpm throughout
    expect(a.power).toBeNull();
    expect(a.fastest.find((f) => f.meters === 1000)?.seconds).toBe(334); // 3 m/s: 333.3 s, first passed at the 334 s sample
    expect(a.trimp_edwards).toBe(20); // ~10 minutes × zone 2
  });

  it("computes power metrics, zones and TSS for the ride leg", () => {
    const a = analyzeActivity(parsed, { sessionIndex: 1, family: "bike", hrZones: zones, ftp: 250 });
    expect(a.power?.avg_w).toBe(200);
    expect(a.power?.normalized_w).toBeGreaterThanOrEqual(200);
    expect(a.power?.intensity_factor).toBeCloseTo(0.8, 1);
    expect(a.power_zones?.find((z) => z.zone.startsWith("Z2"))?.pct).toBe(50); // 180 W samples
    expect(a.best_power.find((b) => b.window_s === 60)?.watts).toBe(200);
  });

  it("computes normalized power as the 4th-power mean of 30 s averages", () => {
    const t = seconds(120);
    expect(
      normalizedPower(
        t,
        t.map(() => 200),
      ),
    ).toBeCloseTo(200, 5);
    expect(
      normalizedPower(
        t.slice(0, 10),
        t.slice(0, 10).map(() => 200),
      ),
    ).toBeNull();
  });
});

describe("garmin_query safety", () => {
  it("accepts one read statement and rejects everything else", () => {
    expect(validateQuery("SELECT 1;")).toBe("SELECT 1");
    expect(validateQuery("  with x as (select 1) select * from x")).toContain("with");
    expect(() => validateQuery("DELETE FROM activity")).toThrow(/SELECT or WITH/);
    expect(() => validateQuery("ATTACH DATABASE 'x.db' AS x")).toThrow(/SELECT or WITH/);
    expect(() => validateQuery("SELECT 1; DROP TABLE activity")).toThrow(/one statement/);
    expect(validateQuery("SELECT ';' AS semicolon -- ; comment")).toContain("';'"); // inside strings and comments is fine
  });

  it("runs in a worker with a row cap and a timeout", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "garmin-query-")), "q.db");
    openDatabase(file).close();
    const r = await runQuery(
      file,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT 50) SELECT x FROM c",
      {
        maxRows: 10,
        timeoutMs: 5000,
      },
    );
    expect(r.columns).toEqual(["x"]);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    await expect(
      runQuery(file, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", {
        maxRows: 10,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/stopped/);
    await expect(
      runQuery(file, "SELECT * FROM no_such_table", { maxRows: 10, timeoutMs: 5000 }),
    ).rejects.toThrow(/SQL error/);
  });
});
