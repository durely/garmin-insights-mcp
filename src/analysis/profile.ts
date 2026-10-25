// The user's heart rate zones per sport, cached for a day (the analysis tools need them often).

import type { GarminClient, HeartRateZones } from "../garmin/index.ts";
import type { Store } from "../store/store.ts";
import type { Family, HrZones } from "./activity.ts";

const CACHE_KEY = "hr_zones";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SPORT_FOR_FAMILY: Record<Family, string> = {
  run: "RUNNING",
  bike: "CYCLING",
  swim: "SWIMMING",
  other: "DEFAULT",
};

export class ZoneProfile {
  readonly #store: Store;
  readonly #client: GarminClient;

  constructor(store: Store, client: GarminClient) {
    this.#store = store;
    this.#client = client;
  }

  async all(signal?: AbortSignal): Promise<HeartRateZones[]> {
    const cached = this.#store.getMeta(CACHE_KEY);
    if (cached) {
      const { fetchedAt, zones } = JSON.parse(cached) as { fetchedAt: number; zones: HeartRateZones[] };
      if (Date.now() - fetchedAt < MAX_AGE_MS) return zones;
    }
    try {
      const zones = await this.#client.getHeartRateZones(signal);
      this.#store.setMeta(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), zones }));
      return zones;
    } catch (error) {
      if (cached) return (JSON.parse(cached) as { zones: HeartRateZones[] }).zones; // stale beats nothing offline
      throw error;
    }
  }

  /** Zones for a sport family, falling back to the DEFAULT set. */
  async forFamily(family: Family, signal?: AbortSignal): Promise<HrZones | null> {
    const zones = await this.all(signal);
    const z =
      zones.find((x) => x.sport === SPORT_FOR_FAMILY[family]) ?? zones.find((x) => x.sport === "DEFAULT");
    if (!z?.zone1Floor || !z.zone2Floor || !z.zone3Floor || !z.zone4Floor || !z.zone5Floor) return null;
    return {
      floors: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor],
      maxHr: z.maxHeartRateUsed ?? null,
      source: `${z.sport ?? "DEFAULT"} zones (${z.trainingMethod ?? "?"})`,
    };
  }

  async maxHr(signal?: AbortSignal): Promise<number | null> {
    const zones = await this.all(signal);
    return (zones.find((x) => x.sport === "DEFAULT") ?? zones[0])?.maxHeartRateUsed ?? null;
  }
}
