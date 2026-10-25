// Garmin addresses wellness data by the user's *local* calendar date (yyyy-MM-dd).
// All arithmetic here is on calendar dates, done in UTC so DST never shifts a day.

/** A calendar date string, yyyy-MM-dd. */
export type CalendarDate = string & { readonly __brand: "CalendarDate" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isCalendarDate(value: string): value is CalendarDate {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function toCalendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) throw new Error(`Invalid date "${value}", expected yyyy-MM-dd`);
  return value;
}

/** Today's date in the given IANA time zone, e.g. "Europe/Brussels". */
export function today(timeZone: string, now: Date = new Date()): CalendarDate {
  // en-CA formats as yyyy-MM-dd.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now) as CalendarDate;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const t = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10) as CalendarDate;
}

/** Number of calendar days from start to end, both inclusive. 2026-01-01..2026-01-01 is 1. */
export function spanDays(start: CalendarDate, end: CalendarDate): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Splits an inclusive date range into consecutive chunks of at most maxDays each. */
export function chunkRange(
  start: CalendarDate,
  end: CalendarDate,
  maxDays: number,
): Array<{ start: CalendarDate; end: CalendarDate }> {
  if (maxDays < 1) throw new Error("maxDays must be at least 1");
  if (spanDays(start, end) < 1) return [];
  const chunks: Array<{ start: CalendarDate; end: CalendarDate }> = [];
  let cursor = start;
  while (spanDays(cursor, end) > 0) {
    const chunkEnd = spanDays(cursor, end) > maxDays ? addDays(cursor, maxDays - 1) : end;
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}
