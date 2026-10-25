// Builds a small synthetic FIT activity for tests (no real user data): a 10-minute run session
// (2 laps) followed by a 10-minute ride session (1 lap), recorded every second.

import { zipSync } from "fflate";
import { FitBaseType, FitEncoder } from "fit-file-parser";

export const FIXTURE_START = new Date("2026-01-01T10:00:00Z");
export const RUN_SECONDS = 600;
export const RIDE_SECONDS = 600;

const ENUM = FitBaseType.Enum;
const U8 = FitBaseType.Uint8;
const U16 = FitBaseType.Uint16;
const U32 = FitBaseType.Uint32;

const f = (number: number, size: number, baseType: number, value: number) => ({
  number,
  size,
  baseType,
  value,
});
const ts = (offsetS: number) => FitEncoder.toFitTimestamp(new Date(FIXTURE_START.getTime() + offsetS * 1000));

// FIT profile message and field numbers (Garmin FIT SDK profile).
const MSG = { fileId: 0, session: 18, lap: 19, record: 20 };

export function buildFixtureFit(): Uint8Array {
  const enc = new FitEncoder();
  // file_id: type=activity, manufacturer=garmin, product=4315 (Forerunner 965), time_created
  enc.writeMessage(
    MSG.fileId,
    [f(0, 1, ENUM, 4), f(1, 2, U16, 1), f(2, 2, U16, 4315), f(4, 4, U32, ts(0))],
    0,
  );

  for (let s = 0; s <= RUN_SECONDS + RIDE_SECONDS; s++) {
    const riding = s > RUN_SECONDS;
    const fields = [
      f(253, 4, U32, ts(s)), // timestamp
      f(3, 1, U8, riding ? 150 : 140), // heart_rate
      f(4, 1, U8, riding ? (s % 60 < 10 ? 0 : 90) : 80), // cadence: run strides/min, ride rpm with coasting
      f(73, 4, U32, riding ? 8000 : 3000), // enhanced_speed, m/s × 1000
      f(5, 4, U32, Math.round((riding ? RUN_SECONDS * 3 + (s - RUN_SECONDS) * 8 : s * 3) * 100)), // distance × 100
    ];
    if (riding) fields.push(f(7, 2, U16, s % 2 === 0 ? 180 : 220)); // power
    enc.writeMessage(MSG.record, fields, riding ? 2 : 1);
  }

  const lap = (index: number, start: number, seconds: number, distanceM: number, avgHr: number) =>
    enc.writeMessage(
      MSG.lap,
      [
        f(254, 2, U16, index), // message_index
        f(253, 4, U32, ts(start + seconds)),
        f(2, 4, U32, ts(start)), // start_time
        f(7, 4, U32, seconds * 1000), // total_elapsed_time
        f(8, 4, U32, seconds * 1000), // total_timer_time
        f(9, 4, U32, distanceM * 100), // total_distance
        f(15, 1, U8, avgHr), // avg_heart_rate
        f(23, 1, ENUM, index === 1 ? 1 : 0), // intensity: active, rest, active
      ],
      3,
    );
  lap(0, 0, 300, 900, 138);
  lap(1, 300, 300, 900, 142);
  lap(2, RUN_SECONDS, RIDE_SECONDS, 4800, 150);

  const session = (
    start: number,
    seconds: number,
    sport: number,
    firstLap: number,
    laps: number,
    distanceM: number,
  ) =>
    enc.writeMessage(
      MSG.session,
      [
        f(253, 4, U32, ts(start + seconds)),
        f(2, 4, U32, ts(start)), // start_time
        f(7, 4, U32, seconds * 1000),
        f(8, 4, U32, seconds * 1000),
        f(9, 4, U32, distanceM * 100),
        f(5, 1, ENUM, sport), // sport: 1 running, 2 cycling
        f(25, 2, U16, firstLap), // first_lap_index
        f(26, 2, U16, laps), // num_laps
      ],
      4,
    );
  session(0, RUN_SECONDS, 1, 0, 2, 1800);
  session(RUN_SECONDS, RIDE_SECONDS, 2, 2, 1, 4800);

  return enc.close();
}

/** The fixture wrapped like Garmin's download: a ZIP with one <id>_ACTIVITY.fit. */
export function buildFixtureZip(activityId: number): Uint8Array {
  return zipSync({ [`${activityId}_ACTIVITY.fit`]: buildFixtureFit() });
}
