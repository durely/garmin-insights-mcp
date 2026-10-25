// Public surface of the Garmin client. This module has no MCP or storage dependencies,
// so it can be extracted into its own package later.

export { type ActivityTypeRef, PARENT_TYPE_KEYS, parentTypeKey } from "./activity-types.ts";
export { decodeJwtClaims, type TokenInfo, TokenManager } from "./auth.ts";
export * from "./client.ts";
export * from "./dates.ts";
export { GarminApiError, type GarminErrorKind } from "./errors.ts";
export { GarminHttp, type GarminHttpOptions } from "./http.ts";
