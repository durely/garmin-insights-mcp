// Decides, per tool call, whether cached data is good enough or a sync is needed first.
//
// - Never synced: start the first sync (if no other process is running one) and wait for the
//   requested domain. Activities come first and take a few seconds; the rest continues in the
//   background.
// - Stale (older than staleAfterMs) and auto-sync on: start a background sync and wait briefly
//   for the requested domain, otherwise answer from the cache.
// - Another process is syncing: use the cache, or wait a little if there's nothing yet.

import type { Store } from "../store/store.ts";
import { SyncBusyError, type SyncEngine } from "./engine.ts";

export interface FreshnessOptions {
  autoSync: boolean;
  staleAfterMs: number;
  /** How long to wait for a first sync of the requested domain. */
  firstSyncWaitMs?: number;
  /** How long to wait for a refresh of stale data before answering from the cache. */
  refreshWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FreshnessResult {
  /** A note for the tool output, e.g. that history is still syncing. */
  note?: string;
}

export class Freshness {
  readonly #engine: SyncEngine;
  readonly #store: Store;
  readonly #o: Required<FreshnessOptions>;

  constructor(engine: SyncEngine, store: Store, options: FreshnessOptions) {
    this.#engine = engine;
    this.#store = store;
    this.#o = {
      firstSyncWaitMs: 90_000,
      refreshWaitMs: 10_000,
      pollMs: 1000,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
  }

  async ensure(domain: string): Promise<FreshnessResult> {
    const state = this.#store.getSyncState(domain);
    const synced = Boolean(state?.last_success_at);

    if (!synced) {
      if (!this.#o.autoSync && !this.#engine.running) {
        throw new Error(
          "The local Garmin cache is empty and auto-sync is off (GARMIN_MCP_AUTO_SYNC=false). Call garmin_sync to download your data first.",
        );
      }
      await this.#waitForFirstSync(domain, this.#o.firstSyncWaitMs);
      if (!this.#store.getSyncState(domain)?.last_success_at) {
        const error = this.#store.getSyncState(domain)?.last_error;
        throw new Error(
          error
            ? `The first Garmin sync of ${domain} failed: ${error}`
            : `The first Garmin sync is still downloading ${domain}. Try again in a minute; garmin_sync_status shows progress.`,
        );
      }
      return this.#historyNote();
    }

    const age = this.#o.now() - Date.parse(state?.last_success_at as string);
    if (this.#o.autoSync && age > this.#o.staleAfterMs && this.#tryStart()) {
      await withTimeout(this.#engine.whenDomainSynced(domain), this.#o.refreshWaitMs);
    }
    return this.#historyNote();
  }

  /** Starts a background sync unless one is already running somewhere. */
  #tryStart(): boolean {
    if (this.#engine.running) return false;
    try {
      this.#engine.start({ mode: "auto" }).done.catch(() => {});
      return true;
    } catch (error) {
      if (error instanceof SyncBusyError) return false;
      throw error;
    }
  }

  /**
   * Waits for the domain's first sync: runs it here if possible, otherwise follows the other
   * process's sync and takes over if that one stops (e.g. its session ended and the lease expired).
   */
  async #waitForFirstSync(domain: string, timeoutMs: number): Promise<void> {
    const deadline = this.#o.now() + timeoutMs;
    while (this.#o.now() < deadline) {
      if (this.#store.getSyncState(domain)?.last_success_at) return;
      if (this.#engine.running || this.#tryStart()) {
        await withTimeout(this.#engine.whenDomainSynced(domain), Math.max(0, deadline - this.#o.now()));
        return;
      }
      await this.#o.sleep(this.#o.pollMs);
    }
  }

  #historyNote(): FreshnessResult {
    const run = this.#store.latestRun();
    if (run?.status === "running") {
      return {
        note: `Garmin sync in progress (${run.done_tasks}/${run.total_tasks} steps); some history may be incomplete. garmin_sync_status shows progress.`,
      };
    }
    return {};
  }
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
