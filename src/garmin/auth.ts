// Exchanges a Personal API key for a short-lived bearer token (JWT, valid 24h, no refresh tokens).
// Tokens are cached in memory and on disk, and re-exchanged when less than an hour remains.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GarminApiError } from "./errors.ts";

export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_WINDOW_MS = 60 * 60 * 1000;

export interface TokenManagerOptions {
  baseUrl: string;
  loadKey: () => Promise<string>;
  /** Persist the token between runs. Omit to keep it in memory only. */
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called for non-fatal problems, such as an unwritable token cache. */
  onWarning?: (message: string) => void;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms, from the JWT exp claim
  keyFingerprint: string; // detects a rotated key without storing the key itself
}

export interface TokenInfo {
  expiresAt: Date;
  issuedAt: Date | undefined;
  scopes: string[];
}

export class TokenManager {
  readonly #opts: Required<Omit<TokenManagerOptions, "cacheFile">> & { cacheFile: string | undefined };
  #cached: CachedToken | undefined;
  #inflight: Promise<CachedToken> | undefined;

  constructor(options: TokenManagerOptions) {
    this.#opts = {
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      onWarning: () => {},
      ...options,
      cacheFile: options.cacheFile,
    };
  }

  /** Returns a token with at least an hour of validity, exchanging the key if needed. */
  async getToken(): Promise<string> {
    const key = await this.#opts.loadKey();
    const fingerprint = fingerprintOf(key);
    if (this.#isFresh(this.#cached, fingerprint)) return this.#cached.accessToken;

    const fromDisk = await this.#readCache();
    if (this.#isFresh(fromDisk, fingerprint)) {
      this.#cached = fromDisk;
      return fromDisk.accessToken;
    }

    // Concurrent callers share one exchange.
    this.#inflight ??= this.#exchange(key, fingerprint).finally(() => {
      this.#inflight = undefined;
    });
    this.#cached = await this.#inflight;
    return this.#cached.accessToken;
  }

  /** Forget the current token, e.g. after the API answered 401. */
  async invalidate(): Promise<void> {
    this.#cached = undefined;
    if (this.#opts.cacheFile) await rm(this.#opts.cacheFile, { force: true });
  }

  /** Details of the current token, for status output. Does not trigger an exchange. */
  currentTokenInfo(): TokenInfo | undefined {
    if (!this.#cached) return undefined;
    const claims = decodeJwtClaims(this.#cached.accessToken);
    return {
      expiresAt: new Date(this.#cached.expiresAt),
      issuedAt: typeof claims.iat === "number" ? new Date(claims.iat * 1000) : undefined,
      scopes: Array.isArray(claims.scope) ? claims.scope.map(String) : [],
    };
  }

  #isFresh(token: CachedToken | undefined, fingerprint: string): token is CachedToken {
    return (
      token !== undefined &&
      token.keyFingerprint === fingerprint &&
      token.expiresAt - this.#opts.now() > REFRESH_WINDOW_MS
    );
  }

  async #exchange(key: string, fingerprint: string): Promise<CachedToken> {
    let res: Response;
    try {
      res = await this.#opts.fetch(this.#opts.baseUrl + TOKEN_PATH, {
        method: "POST",
        headers: { Authorization: `ApiKey ${key}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new GarminApiError("network", "Could not reach Garmin to exchange the API key for a token.", {
        path: TOKEN_PATH,
        cause,
      });
    }
    const body = (await res.text()).trim();
    if (res.status === 401 || res.status === 403) {
      throw new GarminApiError(
        "key_rejected",
        "Garmin rejected the Personal API key: it may be expired, revoked or mistyped. " +
          "Create a new key at https://connect.garmin.com/app/settings/personalApiToken.",
        { status: res.status, path: TOKEN_PATH },
      );
    }
    if (!res.ok) {
      throw new GarminApiError(
        "server_error",
        `Token exchange failed with HTTP ${res.status}. Try again later.`,
        {
          status: res.status,
          path: TOKEN_PATH,
        },
      );
    }
    // Observed: the endpoint returns the bare JWT as text/plain. Accept JSON too, in case that changes.
    const accessToken = parseTokenBody(body);
    const exp = decodeJwtClaims(accessToken).exp;
    if (typeof exp !== "number") {
      throw new GarminApiError("server_error", "Garmin returned a token without an expiry claim.", {
        path: TOKEN_PATH,
      });
    }
    const token: CachedToken = { accessToken, expiresAt: exp * 1000, keyFingerprint: fingerprint };
    await this.#writeCache(token);
    return token;
  }

  async #readCache(): Promise<CachedToken | undefined> {
    if (!this.#opts.cacheFile) return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.#opts.cacheFile, "utf8")) as Partial<CachedToken>;
      if (
        typeof parsed.accessToken === "string" &&
        typeof parsed.expiresAt === "number" &&
        typeof parsed.keyFingerprint === "string"
      ) {
        return parsed as CachedToken;
      }
    } catch {
      // Missing or corrupt cache: fall through to a fresh exchange.
    }
    return undefined;
  }

  async #writeCache(token: CachedToken): Promise<void> {
    const file = this.#opts.cacheFile;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(token), { mode: 0o600 });
      await chmod(file, 0o600); // writeFile's mode only applies when creating the file
    } catch (error) {
      // A read-only or unwritable data dir (e.g. a Docker volume) must not break requests:
      // the token still works from memory, it just isn't reused after a restart.
      this.#opts.onWarning(`Could not cache the Garmin token in ${file}: ${(error as Error).message}`);
    }
  }
}

function parseTokenBody(body: string): string {
  if (body.startsWith("{")) {
    const json = JSON.parse(body) as Record<string, unknown>;
    const token = json.access_token ?? json.accessToken ?? json.token;
    if (typeof token === "string") return token;
    throw new GarminApiError("server_error", "Token response did not contain an access token.", {
      path: TOKEN_PATH,
    });
  }
  return body.replace(/^"|"$/g, "");
}

export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fingerprintOf(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
