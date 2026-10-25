import { ZoneProfile } from "../analysis/profile.ts";
import { type Config, loadApiKey } from "../config.ts";
import { FitFileParserAdapter } from "../fit/fit-file-parser.ts";
import { FitService } from "../fit/service.ts";
import { GarminClient, GarminHttp, TokenManager } from "../garmin/index.ts";
import { log } from "../log.ts";
import { openDatabase } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { SyncEngine } from "../sync/engine.ts";
import { Freshness } from "../sync/freshness.ts";

/** Long-lived dependencies, created once per process and shared by every McpServer instance. */
export interface AppContext {
  config: Config;
  tokens: TokenManager;
  client: GarminClient;
  store: Store;
  sync: SyncEngine;
  freshness: Freshness;
  fit: FitService;
  zones: ZoneProfile;
}

export function createAppContext(
  config: Config,
  options: {
    fetch?: typeof fetch;
    dbFile?: string;
    freshness?: { firstSyncWaitMs?: number; refreshWaitMs?: number };
  } = {},
): AppContext {
  const tokens = new TokenManager({
    baseUrl: config.baseUrl,
    loadKey: () => loadApiKey(config),
    cacheFile: config.tokenCacheFile,
    onWarning: (message) => log.warn(message),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const http = new GarminHttp({
    baseUrl: config.baseUrl,
    tokens,
    requestsPerSecond: config.requestsPerSecond,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const client = new GarminClient(http);
  const store = new Store(openDatabase(options.dbFile ?? config.dbFile));
  const fit = new FitService({ store, client, parser: new FitFileParserAdapter(), dataDir: config.dataDir });
  const sync = new SyncEngine({
    store,
    client,
    timeZone: config.timeZone,
    detailDays: config.detailDays,
    fitFiles: {
      missing: () => store.activitiesWithoutFit(),
      fetch: async (id, signal) => {
        await fit.getSummary(id, signal); // downloads, then parses and caches the summary
      },
    },
  });
  const freshness = new Freshness(sync, store, {
    autoSync: config.autoSync,
    staleAfterMs: config.staleAfterMs,
    ...options.freshness,
  });
  return { config, tokens, client, store, sync, freshness, fit, zones: new ZoneProfile(store, client) };
}
