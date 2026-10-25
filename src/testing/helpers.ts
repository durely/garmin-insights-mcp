// Test doubles. Fixture values are invented; never commit real Garmin responses.

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

/** A fetch replacement that routes by path and records every request. */
export function fakeFetch(routes: Record<string, Responder | Responder[]>, fallback?: Responder) {
  const requests: RecordedRequest[] = [];
  const counters = new Map<string, number>();

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    requests.push(req);
    const route = routes[url.pathname];
    if (!route) return fallback ? fallback(req) : new Response("{}", { status: 404 });
    if (Array.isArray(route)) {
      // Successive calls get successive responders; the last one repeats.
      const n = counters.get(url.pathname) ?? 0;
      counters.set(url.pathname, n + 1);
      const responder = route[Math.min(n, route.length - 1)];
      if (!responder) throw new Error(`no responder for ${url.pathname}`);
      return responder(req);
    }
    return route(req);
  }) as typeof fetch;

  return { fetch: fn, requests };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const status = (code: number, body = "{}") =>
  new Response(code === 204 ? null : body, { status: code });

/** An unsigned JWT with the given claims; the API's tokens are only decoded, never verified client-side. */
export function makeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
export const BASE_URL = "https://personal.connectapi.garmin.com";

/** Token endpoint responder: bare JWT as text/plain, like the real API. */
export function tokenResponder(nowMs: number, lifetimeMs = 24 * 3600_000) {
  return () =>
    new Response(
      makeJwt({
        exp: Math.floor((nowMs + lifetimeMs) / 1000),
        iat: Math.floor(nowMs / 1000),
        scope: ["CONNECT_READ"],
      }),
      { status: 200, headers: { "content-type": "text/plain" } },
    );
}

export const noSleep = async () => {};
