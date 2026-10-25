// Fetches per-day data that isn't in the cache yet, when a tool asks for it: older days of the
// "recent" detail domains (beyond GARMIN_MCP_DETAIL_DAYS) and on-demand domains like food logs.

import {
  addDays,
  type CalendarDate,
  chunkRange,
  GarminApiError,
  type GarminClient,
  spanDays,
  today as todayIn,
} from "../garmin/index.ts";
import type { Store } from "../store/store.ts";
import { DOMAINS, type Domain, ON_DEMAND_DOMAINS } from "./domains.ts";

/** Upper bound on days fetched in one tool call, to keep calls fast and polite. */
export const MAX_ON_DEMAND_DAYS = 31;

export interface OnDemandContext {
  store: Store;
  client: GarminClient;
  timeZone: string;
}

/**
 * Makes sure every day in [start, end] is cached for the domain. Today and yesterday are always
 * re-fetched, since they're still filling in. Returns how many requests were made.
 */
export async function ensureDays(
  ctx: OnDemandContext,
  domainName: string,
  start: CalendarDate,
  end: CalendarDate,
  signal?: AbortSignal,
): Promise<number> {
  const domain: Domain | undefined = [...DOMAINS, ...ON_DEMAND_DOMAINS].find((d) => d.name === domainName);
  if (!domain) throw new Error(`Unknown data domain ${domainName}`);
  const days = spanDays(start, end);
  if (days < 1) throw new GarminApiError("bad_request", `Invalid range: ${start} is after ${end}.`);
  if (days > MAX_ON_DEMAND_DAYS) {
    throw new GarminApiError(
      "bad_request",
      `At most ${MAX_ON_DEMAND_DAYS} days of ${domainName} can be fetched at once; ${start}..${end} is ${days} days.`,
    );
  }

  const today = todayIn(ctx.timeZone);
  const yesterday = addDays(today, -1);
  const have = ctx.store.dailyDates(domain.name, start, end);
  const missing: CalendarDate[] = [];
  for (let d = start; spanDays(d, end) >= 1; d = addDays(d, 1)) {
    if (d > today) continue; // the future has no data
    if (!have.has(d) || d >= yesterday) missing.push(d);
  }
  if (missing.length === 0) return 0;

  const now = () => new Date().toISOString();
  if (domain.kind === "day") {
    for (const date of missing) {
      const data = await domain.fetch(ctx.client, date, signal ?? new AbortController().signal);
      ctx.store.putDaily(domain.name, [{ date, data: data ?? null }], now());
    }
    return missing.length;
  }
  // Range domain: one request per chunk covering the missing days.
  const first = missing[0] as CalendarDate;
  const last = missing.at(-1) as CalendarDate;
  let requests = 0;
  for (const c of chunkRange(first, last, domain.maxDays)) {
    const entries = await domain.fetch(ctx.client, c.start, c.end, signal ?? new AbortController().signal);
    ctx.store.putDaily(domain.name, entries, now());
    requests++;
  }
  return requests;
}
