// Garmin's activity type hierarchy. Each activity has { typeId, typeKey, parentTypeId }.
// parentTypeId 17 is the root, so types directly under it (running, cycling, walking, ...) are
// their own parent. The Personal API has no endpoint listing types; these parent IDs were
// observed in real data and confirmed with the search API's activityType filter (2026-10).

export const ROOT_PARENT_TYPE_ID = 17;

export const PARENT_TYPE_KEYS: Readonly<Record<number, string>> = {
  1: "running",
  2: "cycling",
  3: "hiking",
  4: "other",
  9: "walking",
  26: "swimming",
  29: "fitness_equipment",
  89: "multi_sport",
  219: "racket_sports",
  228: "water_sports",
};

export interface ActivityTypeRef {
  typeId?: number;
  typeKey?: string;
  parentTypeId?: number;
}

/** The parent type key for filtering by sport, e.g. road_biking → cycling, running → running. */
export function parentTypeKey(type: ActivityTypeRef | undefined): string | null {
  if (!type?.typeKey) return null;
  if (type.parentTypeId === undefined || type.parentTypeId === ROOT_PARENT_TYPE_ID) return type.typeKey;
  return PARENT_TYPE_KEYS[type.parentTypeId] ?? `type_${type.parentTypeId}`;
}
