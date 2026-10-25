// Errors carry messages that say how to recover: MCP tools surface them to the model verbatim.

export type GarminErrorKind =
  | "missing_key"
  | "key_rejected"
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network";

export class GarminApiError extends Error {
  readonly kind: GarminErrorKind;
  readonly status: number | undefined;
  readonly path: string | undefined;

  constructor(
    kind: GarminErrorKind,
    message: string,
    options: { status?: number; path?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GarminApiError";
    this.kind = kind;
    this.status = options.status;
    this.path = options.path;
  }
}

export function errorForStatus(status: number, path: string): GarminApiError {
  switch (status) {
    case 400:
      return new GarminApiError(
        "bad_request",
        `Garmin rejected the request (HTTP 400) for ${path}. Garmin gives no details; the usual cause is a date range longer than the endpoint allows, an invalid date, or an unknown activity type.`,
        { status, path },
      );
    case 401:
      return new GarminApiError(
        "unauthorized",
        "Garmin rejected the access token (HTTP 401). The server will fetch a new token automatically; if this keeps happening, the API key may have been revoked.",
        { status, path },
      );
    case 403:
      return new GarminApiError(
        "unauthorized",
        `Garmin denied access (HTTP 403) to ${path}. The Personal API key may not include this data type.`,
        { status, path },
      );
    case 404:
      return new GarminApiError(
        "not_found",
        `Not found (HTTP 404): ${path}. Check the ID; garmin_list_activities returns valid activity IDs.`,
        { status, path },
      );
    case 429:
      return new GarminApiError(
        "rate_limited",
        "Garmin is rate limiting requests (HTTP 429). Wait a minute, or lower GARMIN_MCP_REQUESTS_PER_SECOND.",
        { status, path },
      );
    default:
      return new GarminApiError(
        status >= 500 ? "server_error" : "bad_request",
        status >= 500
          ? `Garmin returned a server error (HTTP ${status}) for ${path}. Try again later. Note: activity search fails with HTTP 500 when limit is above ~200.`
          : `Garmin returned HTTP ${status} for ${path}.`,
        { status, path },
      );
  }
}
