import { describe, expect, it } from "vitest";
import { addDays, type CalendarDate, chunkRange, isCalendarDate, spanDays, today } from "./dates.ts";

const d = (s: string) => s as CalendarDate;

describe("dates", () => {
  it("validates calendar dates strictly", () => {
    expect(isCalendarDate("2026-10-24")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-1-5")).toBe(false);
  });

  it("counts inclusive spans", () => {
    expect(spanDays(d("2026-10-24"), d("2026-10-24"))).toBe(1);
    expect(spanDays(d("2026-10-01"), d("2026-10-28"))).toBe(28);
    expect(spanDays(d("2026-10-02"), d("2026-10-01"))).toBe(0);
  });

  it("adds days across DST and leap years", () => {
    expect(addDays(d("2026-03-28"), 2)).toBe("2026-03-30"); // EU DST switch on 2026-03-29
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
  });

  it("uses the given time zone for today", () => {
    const lateEveningUtc = new Date("2026-10-24T23:30:00Z");
    expect(today("UTC", lateEveningUtc)).toBe("2026-10-24");
    expect(today("Europe/Brussels", lateEveningUtc)).toBe("2026-10-25");
    expect(today("America/New_York", lateEveningUtc)).toBe("2026-10-24");
  });

  it("chunks ranges within a cap, covering every day exactly once", () => {
    const chunks = chunkRange(d("2026-01-01"), d("2026-03-01"), 28);
    expect(chunks).toEqual([
      { start: "2026-01-01", end: "2026-01-28" },
      { start: "2026-01-29", end: "2026-02-25" },
      { start: "2026-02-26", end: "2026-03-01" },
    ]);
    expect(chunks.reduce((n, c) => n + spanDays(c.start, c.end), 0)).toBe(
      spanDays(d("2026-01-01"), d("2026-03-01")),
    );
    expect(chunkRange(d("2026-01-02"), d("2026-01-01"), 28)).toEqual([]);
  });
});
