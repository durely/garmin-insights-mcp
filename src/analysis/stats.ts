// Small statistics helpers. All functions ignore null/undefined values.

type Maybe = number | null | undefined;

const valid = (xs: readonly Maybe[]): number[] =>
  xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

export function mean(xs: readonly Maybe[]): number | null {
  const v = valid(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function median(xs: readonly Maybe[]): number | null {
  const v = valid(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

export function stdev(xs: readonly Maybe[]): number | null {
  const v = valid(xs);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Pearson correlation over pairs where both values are present. */
export function pearson(xs: readonly Maybe[], ys: readonly Maybe[]): { r: number | null; n: number } {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y))
      pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 3) return { r: null, n };
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}

/** "weak" / "moderate" / "strong" for |r|, as a rough reading aid. */
export function correlationStrength(r: number | null): string {
  if (r === null) return "n/a";
  const a = Math.abs(r);
  const direction = r > 0 ? "positive" : "negative";
  if (a < 0.1) return "none";
  if (a < 0.3) return `weak ${direction}`;
  if (a < 0.5) return `moderate ${direction}`;
  return `strong ${direction}`;
}

export function round(value: number | null | undefined, digits = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Highest average of `values` over any window of `windowS` seconds (time-based, tolerant of
 * gaps). Samples without a value are skipped. Returns null if the data is shorter than the window.
 */
export function bestAverage(
  t: readonly number[],
  values: readonly Maybe[],
  windowS: number,
): { value: number; start_s: number } | null {
  let best: { value: number; start_s: number } | null = null;
  let i = 0;
  let sum = 0;
  let count = 0;
  const idx: number[] = [];
  for (let j = 0; j < t.length; j++) {
    const v = values[j];
    if (typeof v !== "number") continue;
    idx.push(j);
    sum += v;
    count++;
    // Shrink from the left while the window is longer than needed.
    while (
      i < idx.length - 1 &&
      (t[idx.at(-1) as number] as number) - (t[idx[i + 1] as number] as number) >= windowS - 1
    ) {
      sum -= values[idx[i] as number] as number;
      count--;
      i++;
    }
    const span = (t[idx.at(-1) as number] as number) - (t[idx[i] as number] as number);
    if (span >= windowS - 1 && count > 0) {
      const avg = sum / count;
      if (!best || avg > best.value) best = { value: avg, start_s: t[idx[i] as number] as number };
    }
  }
  return best;
}

/** Fastest time to cover `meters`, from a cumulative distance stream. */
export function fastestDistance(
  t: readonly number[],
  distance: readonly Maybe[],
  meters: number,
): { seconds: number; start_s: number } | null {
  const idx: number[] = [];
  for (let j = 0; j < t.length; j++) if (typeof distance[j] === "number") idx.push(j);
  let best: { seconds: number; start_s: number } | null = null;
  let i = 0;
  for (let k = 0; k < idx.length; k++) {
    const dj = distance[idx[k] as number] as number;
    // Move the left edge as far right as possible while still covering the distance.
    while (i + 1 < k && dj - (distance[idx[i + 1] as number] as number) >= meters) i++;
    const di = distance[idx[i] as number] as number;
    if (dj - di >= meters) {
      const seconds = (t[idx[k] as number] as number) - (t[idx[i] as number] as number);
      if (!best || seconds < best.seconds) best = { seconds, start_s: t[idx[i] as number] as number };
    }
  }
  return best;
}

/** Exponentially weighted moving average step, with time constant `days`. */
export function ewmaStep(previous: number, value: number, days: number): number {
  return previous + (value - previous) / days;
}
