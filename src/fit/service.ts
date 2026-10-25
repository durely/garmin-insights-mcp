// FIT files: download on demand, keep on disk, cache the parsed summary in SQLite and recent
// parses in memory. Second-by-second data is re-parsed from the file when needed (a large
// multisport file parses in ~70 ms), which keeps the database small.
//
// Multisport: Garmin returns the whole multisport file for the parent and for each leg, so we
// download it once (for the parent) and select the leg's session by start time.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { GarminClient } from "../garmin/index.ts";
import type { Store } from "../store/store.ts";
import type { FitParser, FitSummary, ParsedFit } from "./model.ts";

/** Real activity files are well under 10 MB; refuse anything absurd (e.g. a zip bomb). */
const MAX_FIT_BYTES = 64 * 1024 * 1024;
const MEMORY_CACHE_SIZE = 4;

export interface FitLocation {
  /** The activity whose file this is (the multisport parent for legs). */
  fileId: number;
  /** For a multisport leg: the index of its session in the file. */
  sessionIndex: number | null;
}

export class FitService {
  readonly #store: Store;
  readonly #client: GarminClient;
  readonly #parser: FitParser;
  readonly #dataDir: string;
  readonly #memory = new Map<number, ParsedFit>(); // insertion-ordered LRU
  readonly #inflight = new Map<number, Promise<void>>();

  constructor(options: { store: Store; client: GarminClient; parser: FitParser; dataDir: string }) {
    this.#store = options.store;
    this.#client = options.client;
    this.#parser = options.parser;
    this.#dataDir = options.dataDir;
  }

  /** Summary (sessions, laps, lengths, metrics) for an activity, downloading its file if needed. */
  async getSummary(activityId: number, signal?: AbortSignal): Promise<{ summary: FitSummary } & FitLocation> {
    const { fileId, legStart } = await this.#locate(activityId, signal);
    await this.ensureDownloaded(fileId, signal);
    const row = this.#store.getFit(fileId);
    const summary =
      row?.summary_json && row.parser === this.#parser.id
        ? (JSON.parse(row.summary_json) as FitSummary)
        : (await this.#parse(fileId)).summary;
    return { summary, fileId, sessionIndex: sessionFor(legStart, summary) };
  }

  /** Full parse including second-by-second streams. */
  async getParsed(activityId: number, signal?: AbortSignal): Promise<ParsedFit & FitLocation> {
    const { fileId, legStart } = await this.#locate(activityId, signal);
    await this.ensureDownloaded(fileId, signal);
    const parsed = await this.#parse(fileId);
    return { ...parsed, fileId, sessionIndex: sessionFor(legStart, parsed.summary) };
  }

  /** Absolute path of the original FIT file, downloading it if needed. */
  async getFilePath(
    activityId: number,
    signal?: AbortSignal,
  ): Promise<{ path: string; size: number; sha256: string; fileId: number }> {
    const { fileId } = await this.#locate(activityId, signal);
    await this.ensureDownloaded(fileId, signal);
    const row = this.#store.getFit(fileId);
    if (!row) throw new Error(`FIT file for activity ${activityId} is missing after download.`);
    return { path: join(this.#dataDir, row.path), size: row.size, sha256: row.sha256, fileId };
  }

  /** Which file holds this activity: multisport legs live in their parent's file. */
  async #locate(
    activityId: number,
    signal?: AbortSignal,
  ): Promise<{ fileId: number; legStart: number | null }> {
    const ref = this.#store.getActivityRef(activityId);
    if (ref) {
      return ref.parent_id
        ? { fileId: ref.parent_id, legStart: parseGmt(ref.start_utc) }
        : { fileId: activityId, legStart: null };
    }
    // Not in the cache (an ID from a Garmin Connect URL, or uploaded since the last sync):
    // ask Garmin whether it's a multisport leg before downloading anything.
    if (this.#store.getFit(activityId)) return { fileId: activityId, legStart: null };
    const detail =
      this.#store.getActivityDetail(activityId)?.detail ??
      (await this.#client.getActivity(activityId, signal));
    if (!detail?.parentId) return { fileId: activityId, legStart: null };
    return { fileId: detail.parentId, legStart: parseGmt(detail.summaryDTO?.startTimeGMT) };
  }

  /** Downloads and indexes the file unless it's already on disk. Concurrent calls share one download. */
  async ensureDownloaded(fileId: number, signal?: AbortSignal): Promise<void> {
    if (this.#store.getFit(fileId)) return;
    let pending = this.#inflight.get(fileId);
    if (!pending) {
      pending = this.#download(fileId, signal).finally(() => this.#inflight.delete(fileId));
      this.#inflight.set(fileId, pending);
    }
    await pending;
  }

  async #download(fileId: number, signal?: AbortSignal): Promise<void> {
    const zip = await this.#client.downloadActivityFile(fileId, signal);
    const fit = extractFit(zip);
    const relative = join("fit", `${fileId}.fit`);
    const absolute = join(this.#dataDir, relative);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, fit, { mode: 0o600 });
    this.#store.saveFit({
      id: fileId,
      path: relative,
      size: fit.length,
      sha256: createHash("sha256").update(fit).digest("hex"),
      downloaded_at: new Date().toISOString(),
    });
    this.#memory.delete(fileId);
  }

  async #parse(fileId: number, retried = false): Promise<ParsedFit> {
    const cached = this.#memory.get(fileId);
    if (cached) {
      this.#memory.delete(fileId); // refresh LRU position
      this.#memory.set(fileId, cached);
      return cached;
    }
    const row = this.#store.getFit(fileId);
    if (!row) throw new Error(`No FIT file downloaded for activity ${fileId}.`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.#dataDir, row.path)));
    } catch (cause) {
      if (retried) throw new Error(`Could not read the FIT file for activity ${fileId}.`, { cause });
      // The file was deleted from disk: forget it and download it again, once.
      this.#store.deleteFit(fileId);
      await rm(join(this.#dataDir, row.path), { force: true });
      await this.ensureDownloaded(fileId);
      return this.#parse(fileId, true);
    }
    const parsed = await this.#parser.parse(bytes);
    if (row.parser !== this.#parser.id || !row.summary_json) {
      this.#store.saveFitSummary(fileId, this.#parser.id, parsed.summary, new Date().toISOString());
    }
    this.#memory.set(fileId, parsed);
    while (this.#memory.size > MEMORY_CACHE_SIZE) {
      const oldest = this.#memory.keys().next().value;
      if (oldest === undefined) break;
      this.#memory.delete(oldest);
    }
    return parsed;
  }
}

/** Garmin GMT timestamps come as "2026-01-01 07:00:00" or "2026-01-01T07:00:00.0", without a zone. */
function parseGmt(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.replace(" ", "T");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(t) ? null : t;
}

/** For a multisport leg: the session starting closest to the leg's start time. */
function sessionFor(legStart: number | null, summary: FitSummary): number | null {
  if (legStart === null || summary.sessions.length === 0) return null;
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const s of summary.sessions) {
    if (!s.start_time) continue;
    const gap = Math.abs(Date.parse(s.start_time) - legStart);
    if (gap < bestGap) {
      best = s.index;
      bestGap = gap;
    }
  }
  return best;
}

/** Pulls the .fit file out of Garmin's ZIP download, guarding against oversized entries. */
export function extractFit(zip: Uint8Array): Uint8Array {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (file) => /\.fit$/i.test(file.name) && file.originalSize <= MAX_FIT_BYTES,
    });
  } catch (cause) {
    throw new Error("Garmin's activity download wasn't a valid ZIP file.", { cause });
  }
  const fit = Object.values(entries)[0];
  if (!fit || fit.length === 0) throw new Error("Garmin's activity download contained no FIT file.");
  if (fit.length > MAX_FIT_BYTES)
    throw new Error("The activity file is unexpectedly large; refusing to process it.");
  return fit;
}
