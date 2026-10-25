// Sync engine: pulls Garmin data into the local cache.
//
// - Activities first (a few paged calls), then history domains, then recent per-day detail.
// - Range domains keep a contiguous coverage window per domain: new days are fetched forward,
//   history backward (newest first), one chunk at a time, so an interrupted backfill resumes
//   where it stopped.
// - One sync at a time across all processes, via a lease row with a heartbeat.
// - Progress is written to sync_run so any process (or the CLI) can report it.

import { randomUUID } from "node:crypto";
import {
  addDays,
  type CalendarDate,
  chunkRange,
  GarminApiError,
  type GarminClient,
  MAX_SEARCH_LIMIT,
  spanDays,
  today as todayIn,
} from "../garmin/index.ts";
import { log } from "../log.ts";
import type { Store, SyncState } from "../store/store.ts";
import {
  ACTIVITIES_DOMAIN,
  ALL_DOMAIN_NAMES,
  type DayDomain,
  DOMAINS,
  type Domain,
  FIT_FILES_DOMAIN,
  type RangeDomain,
} from "./domains.ts";

export interface SyncOptions {
  /** "auto": new data plus whatever history is still missing. "full": forget coverage and re-download. */
  mode: "auto" | "full";
  /** History start date. Defaults to the first activity's date. */
  from?: CalendarDate;
  /** Subset of domains; defaults to all. */
  domains?: string[];
}

export interface SyncSummary {
  runId: number;
  status: "completed" | "failed" | "interrupted";
  tasksDone: number;
  tasksTotal: number;
  errors: string[];
}

export class SyncBusyError extends Error {
  readonly owner: string;
  constructor(owner: string) {
    super(
      "Another Garmin sync is already running (in another session or the CLI). Check garmin_sync_status.",
    );
    this.name = "SyncBusyError";
    this.owner = owner;
  }
}

export interface SyncEngineOptions {
  store: Store;
  client: GarminClient;
  timeZone: string;
  /** How many recent days of per-day detail to keep synced. */
  detailDays: number;
  owner?: string;
  now?: () => Date;
  leaseStaleMs?: number;
  heartbeatMs?: number;
  /** Bulk FIT download for the opt-in fit_files domain. */
  fitFiles?: { missing(): number[]; fetch(activityId: number, signal: AbortSignal): Promise<void> };
}

interface Task {
  label: string;
  run: (signal: AbortSignal) => Promise<void>;
}

const FATAL_KINDS = new Set(["missing_key", "key_rejected", "unauthorized", "rate_limited"]);
const PAGE_SIZE = 100;
/** Re-fetch this many recent days on incremental syncs: today's data is partial and activities get edited. */
const ACTIVITY_OVERLAP_DAYS = 7;
const RANGE_OVERLAP_DAYS = 2;

export class SyncEngine {
  readonly owner: string;
  readonly #o: Required<Omit<SyncEngineOptions, "owner" | "fitFiles">>;
  readonly #fitFiles: SyncEngineOptions["fitFiles"];
  #current: { runId: number; done: Promise<SyncSummary>; controller: AbortController } | undefined;
  #domainReady = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(options: SyncEngineOptions) {
    this.owner = options.owner ?? `pid-${process.pid}-${randomUUID().slice(0, 8)}`;
    const { fitFiles, ...rest } = options;
    this.#o = { now: () => new Date(), leaseStaleMs: 60_000, heartbeatMs: 15_000, ...rest };
    this.#fitFiles = fitFiles;
  }

  get running(): boolean {
    return this.#current !== undefined;
  }

  get leaseStaleMs(): number {
    return this.#o.leaseStaleMs;
  }

  /** Starts a sync in the background. Returns the running one if this process already has one. */
  start(options: SyncOptions = { mode: "auto" }): { runId: number; done: Promise<SyncSummary> } {
    if (this.#current) return this.#current;
    const { store, now } = this.#o;
    if (!store.tryAcquireLease(this.owner, now(), this.#o.leaseStaleMs)) {
      throw new SyncBusyError(store.activeLease(now(), this.#o.leaseStaleMs)?.owner ?? "unknown");
    }
    store.markOrphanedRuns(this.owner, now().toISOString());
    const runId = store.createRun(this.owner, options.mode, 0, now().toISOString());
    const controller = new AbortController();
    const names = options.domains ?? ALL_DOMAIN_NAMES;
    this.#domainReady = new Map(names.map((n) => [n, deferred()]));

    const heartbeat = setInterval(() => store.heartbeatLease(this.owner, now()), this.#o.heartbeatMs);
    heartbeat.unref();

    const done = this.#run(runId, options, names, controller.signal).finally(() => {
      clearInterval(heartbeat);
      store.releaseLease(this.owner);
      for (const d of this.#domainReady.values()) d.resolve();
      this.#current = undefined;
    });
    this.#current = { runId, done, controller };
    return this.#current;
  }

  /** Resolves when the domain has been synced in the current run (or immediately if not running/not included). */
  whenDomainSynced(domain: string): Promise<void> {
    return this.#domainReady.get(domain)?.promise ?? Promise.resolve();
  }

  /** Asks the running sync to stop after the current request; progress so far is kept. */
  stop(): void {
    this.#current?.controller.abort();
  }

  /**
   * For process exit: synchronously releases the lease and marks the run interrupted, so the next
   * session can start a sync immediately instead of waiting for the lease to go stale.
   */
  abandon(): void {
    if (!this.#current) return;
    const { store, now } = this.#o;
    store.updateRun(this.#current.runId, {
      status: "interrupted",
      finished_at: now().toISOString(),
      current: null,
    });
    store.releaseLease(this.owner);
  }

  async #run(
    runId: number,
    options: SyncOptions,
    names: string[],
    signal: AbortSignal,
  ): Promise<SyncSummary> {
    const { store } = this.#o;
    const today = todayIn(this.#o.timeZone, this.#o.now());
    const errors: string[] = [];
    let done = 0;
    let total = 0;
    const progress = (current: string | null) =>
      store.updateRun(runId, { done_tasks: done, total_tasks: total, current });
    const finish = (status: SyncSummary["status"]): SyncSummary => {
      store.updateRun(runId, {
        status,
        finished_at: this.#o.now().toISOString(),
        done_tasks: done,
        total_tasks: total,
        current: null,
        error_count: errors.length,
        last_error: errors.at(-1) ?? null,
      });
      log.info("Garmin sync finished", { runId, status, done, total, errors: errors.length });
      return { runId, status, tasksDone: done, tasksTotal: total, errors };
    };

    if (options.mode === "full") store.resetSyncState(names);
    log.info("Garmin sync started", { runId, mode: options.mode, domains: names.join(",") });

    try {
      if (names.includes(ACTIVITIES_DOMAIN)) {
        total += 1;
        progress("activities");
        await this.#guard(ACTIVITIES_DOMAIN, errors, () => this.#syncActivities(today, signal, progress));
        done += 1;
        this.#domainReady.get(ACTIVITIES_DOMAIN)?.resolve();
      }

      const historyStart = this.#historyStart(options.from, today);
      const detailStart = maxDate(historyStart, addDays(today, -(this.#o.detailDays - 1)));
      const plans = DOMAINS.filter((d) => names.includes(d.name)).map((domain) => ({
        domain,
        tasks: this.#plan(domain, domain.scope === "history" ? historyStart : detailStart, today),
        floor: domain.scope === "history" ? historyStart : detailStart,
      }));
      total += plans.reduce((n, p) => n + p.tasks.length, 0);
      progress(null);

      for (const { domain, tasks, floor } of plans) {
        let failed = false;
        for (const task of tasks) {
          if (signal.aborted) return finish("interrupted");
          progress(task.label);
          failed = !(await this.#guard(domain.name, errors, () => task.run(signal)));
          done += 1;
          if (failed) {
            done += tasks.length - tasks.indexOf(task) - 1; // skip the rest: coverage must stay contiguous
            break;
          }
        }
        if (!failed) this.#markDomainSynced(domain.name, floor);
        this.#domainReady.get(domain.name)?.resolve();
      }

      if (names.includes(FIT_FILES_DOMAIN) && this.#fitFiles) {
        const ids = this.#fitFiles.missing();
        total += ids.length;
        let failures = 0;
        let consecutive = 0;
        for (const id of ids) {
          if (signal.aborted) return finish("interrupted");
          progress(`fit_files ${id}`);
          const ok = await this.#guard(FIT_FILES_DOMAIN, errors, () =>
            (this.#fitFiles as NonNullable<SyncEngineOptions["fitFiles"]>).fetch(id, signal),
          );
          done += 1;
          failures += ok ? 0 : 1;
          consecutive = ok ? 0 : consecutive + 1;
          if (consecutive >= 10) {
            errors.push(`${FIT_FILES_DOMAIN}: stopped after 10 failed downloads in a row`);
            done += ids.length - ids.indexOf(id) - 1;
            break;
          }
        }
        if (failures === 0) {
          store.updateSyncState(FIT_FILES_DOMAIN, {
            backfill_complete: 1,
            last_success_at: this.#o.now().toISOString(),
            last_error: null,
          });
        }
        this.#domainReady.get(FIT_FILES_DOMAIN)?.resolve();
      }
      return finish(signal.aborted ? "interrupted" : "completed");
    } catch (error) {
      if (signal.aborted) return finish("interrupted");
      errors.push(messageOf(error));
      return finish("failed");
    }
  }

  /** Runs one unit of work. Returns false on a recoverable error; rethrows fatal ones (auth, rate limit). */
  async #guard(domain: string, errors: string[], fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      const message = messageOf(error);
      this.#o.store.updateSyncState(domain, {
        last_error: message,
        last_error_at: this.#o.now().toISOString(),
      });
      if (error instanceof GarminApiError && FATAL_KINDS.has(error.kind)) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      errors.push(`${domain}: ${message}`);
      log.warn("Garmin sync task failed", { domain, error: message });
      return false;
    }
  }

  async #syncActivities(
    today: CalendarDate,
    signal: AbortSignal,
    progress: (s: string) => void,
  ): Promise<void> {
    const { store, client } = this.#o;
    const state = store.getSyncState(ACTIVITIES_DOMAIN);
    const startDate =
      state?.backfill_complete && state.newest_date
        ? addDays(state.newest_date as CalendarDate, -ACTIVITY_OVERLAP_DAYS)
        : undefined;
    let fetched = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (signal.aborted) return;
      const page = await client.searchActivities(
        { start: offset, limit: Math.min(PAGE_SIZE, MAX_SEARCH_LIMIT), excludeChildren: false, startDate },
        signal,
      );
      store.upsertActivities(page, this.#o.now().toISOString());
      fetched += page.length;
      progress(`activities (${fetched} fetched)`);
      if (page.length < PAGE_SIZE) break;
    }
    const stats = store.activityStats();
    store.updateSyncState(ACTIVITIES_DOMAIN, {
      oldest_date: stats.earliest,
      newest_date: today,
      backfill_complete: 1,
      last_success_at: this.#o.now().toISOString(),
      last_error: null,
    });
  }

  #historyStart(from: CalendarDate | undefined, today: CalendarDate): CalendarDate {
    const { store } = this.#o;
    const saved = store.getMeta("history_start") as CalendarDate | undefined;
    const earliest = store.activityStats().earliest as CalendarDate | null;
    const candidates = [from, saved, earliest].filter((d): d is CalendarDate => Boolean(d));
    const start = candidates.sort()[0] ?? addDays(today, -365); // ISO dates sort chronologically
    if (start !== saved && (from || earliest)) store.setMeta("history_start", start);
    return start;
  }

  #plan(domain: Domain, floor: CalendarDate, today: CalendarDate): Task[] {
    const state = this.#o.store.getSyncState(domain.name);
    return domain.kind === "range"
      ? this.#planRange(domain, state, floor, today)
      : this.#planDays(domain, floor, today);
  }

  #planRange(
    domain: RangeDomain,
    state: SyncState | undefined,
    floor: CalendarDate,
    today: CalendarDate,
  ): Task[] {
    const tasks: Task[] = [];
    const fetchChunk = (start: CalendarDate, end: CalendarDate) => async (signal: AbortSignal) => {
      const entries = await domain.fetch(this.#o.client, start, end, signal);
      this.#o.store.putDaily(domain.name, entries, this.#o.now().toISOString());
      this.#extendCoverage(domain.name, start, end);
    };

    // Forward: from just before the newest synced day up to today.
    if (state?.newest_date) {
      const from = maxDate(floor, addDays(state.newest_date as CalendarDate, -RANGE_OVERLAP_DAYS));
      for (const c of chunkRange(from, today, domain.maxDays)) {
        tasks.push({ label: `${domain.name} ${c.start}..${c.end}`, run: fetchChunk(c.start, c.end) });
      }
    }
    // Backward: history not yet covered, newest first.
    let cursor = state?.oldest_date ? addDays(state.oldest_date as CalendarDate, -1) : today;
    while (spanDays(floor, cursor) >= 1) {
      const start = maxDate(floor, addDays(cursor, -(domain.maxDays - 1)));
      tasks.push({ label: `${domain.name} ${start}..${cursor}`, run: fetchChunk(start, cursor) });
      cursor = addDays(start, -1);
    }
    return tasks;
  }

  #planDays(domain: DayDomain, floor: CalendarDate, today: CalendarDate): Task[] {
    const have = this.#o.store.dailyDates(domain.name, floor, today);
    const yesterday = addDays(today, -1);
    const tasks: Task[] = [];
    // Newest first, so recent days are available soonest.
    for (let date = today; spanDays(floor, date) >= 1; date = addDays(date, -1)) {
      if (have.has(date) && date < yesterday) continue; // today and yesterday are re-fetched: still filling in
      const day = date;
      tasks.push({
        label: `${domain.name} ${day}`,
        run: async (signal) => {
          const data = await domain.fetch(this.#o.client, day, signal);
          // Days without data are stored too (as null), so they aren't fetched again.
          this.#o.store.putDaily(
            domain.name,
            [{ date: day, data: data ?? null }],
            this.#o.now().toISOString(),
          );
          this.#extendCoverage(domain.name, day, day);
        },
      });
    }
    return tasks;
  }

  #extendCoverage(domain: string, start: string, end: string): void {
    const state = this.#o.store.getSyncState(domain);
    this.#o.store.updateSyncState(domain, {
      oldest_date: !state?.oldest_date || start < state.oldest_date ? start : state.oldest_date,
      newest_date: !state?.newest_date || end > state.newest_date ? end : state.newest_date,
    });
  }

  #markDomainSynced(domain: string, floor: CalendarDate): void {
    const state = this.#o.store.getSyncState(domain);
    this.#o.store.updateSyncState(domain, {
      backfill_complete: state?.oldest_date && state.oldest_date <= floor ? 1 : 0,
      last_success_at: this.#o.now().toISOString(),
      last_error: null,
    });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a > b ? a : b;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
