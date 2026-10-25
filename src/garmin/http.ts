// HTTP transport for the Personal API: auth header, throttling, retries, timeouts, typed errors.

import type { TokenManager } from "./auth.ts";
import { errorForStatus, GarminApiError } from "./errors.ts";

export type Query = Record<string, string | number | boolean | undefined>;

export interface GarminHttpOptions {
  baseUrl: string;
  tokens: Pick<TokenManager, "getToken" | "invalidate">;
  fetch?: typeof fetch;
  /** Minimum gap between request starts. Garmin publishes no limits; 4 req/s was comfortably fine in testing. */
  requestsPerSecond?: number;
  /** Retries for 429 and 5xx responses (502/503/504 and network errors). */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class GarminHttp {
  readonly #opts: Required<GarminHttpOptions>;
  #nextSlot = 0;

  constructor(options: GarminHttpOptions) {
    this.#opts = {
      fetch: globalThis.fetch.bind(globalThis),
      requestsPerSecond: 4,
      maxRetries: 3,
      timeoutMs: 30_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      ...options,
    };
  }

  /** GET a JSON endpoint. Returns null for empty bodies (Garmin answers 204 or an empty 200 when there's no data). */
  async getJson<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T | null> {
    const res = await this.#request(path, query, "application/json", signal);
    const text = await res.text();
    if (res.status === 204 || text.length === 0) return null;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new GarminApiError("server_error", `Garmin returned invalid JSON for ${path}.`, { path, cause });
    }
  }

  /** GET a binary endpoint, e.g. the activity file download (a ZIP). */
  async getBytes(path: string, accept: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.#request(path, undefined, accept, signal);
    return new Uint8Array(await res.arrayBuffer());
  }

  async #request(
    path: string,
    query: Query | undefined,
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = this.#url(path, query);
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      const token = await this.#opts.tokens.getToken();

      let res: Response;
      try {
        res = await this.#opts.fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.#opts.timeoutMs)])
            : AbortSignal.timeout(this.#opts.timeoutMs),
        });
      } catch (cause) {
        if (signal?.aborted) throw cause; // the caller cancelled; don't retry
        const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
        if (attempt < this.#opts.maxRetries) {
          await this.#opts.sleep(this.#backoffMs(attempt));
          continue;
        }
        throw new GarminApiError(
          timedOut ? "timeout" : "network",
          timedOut
            ? `Garmin did not respond within ${this.#opts.timeoutMs / 1000}s for ${path}. Try again, or request a smaller date range.`
            : `Could not reach Garmin for ${path}. Check the network connection.`,
          { path, cause },
        );
      }

      if (res.ok) return res;

      // A 401 usually means the cached token was revoked or expired early: get a new one, once.
      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        await res.body?.cancel();
        await this.#opts.tokens.invalidate();
        continue;
      }

      if (RETRYABLE.has(res.status) && attempt < this.#opts.maxRetries) {
        await res.body?.cancel();
        await this.#opts.sleep(retryAfterMs(res) ?? this.#backoffMs(attempt));
        continue;
      }

      await res.body?.cancel();
      throw errorForStatus(res.status, path);
    }
  }

  #url(path: string, query: Query | undefined): string {
    const url = new URL(this.#opts.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Spaces request starts at least 1/requestsPerSecond apart, across concurrent callers. */
  async #throttle(): Promise<void> {
    const gap = 1000 / this.#opts.requestsPerSecond;
    const now = this.#opts.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + gap;
    if (slot > now) await this.#opts.sleep(slot - now);
  }

  #backoffMs(attempt: number): number {
    const base = 1000 * 2 ** attempt; // 1s, 2s, 4s
    return base + Math.floor(Math.random() * 250);
  }
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds, 60) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - Date.now(), 60_000));
}
