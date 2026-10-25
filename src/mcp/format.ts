import * as z from "zod/v4";

/** Keep tool responses well inside a model's context budget. Trim by returning fewer items, never by cutting text. */
export const CHARACTER_LIMIT = 25_000;

export const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' for readable text (default), 'json' for complete structured data");

export type ResponseFormat = z.infer<typeof responseFormatSchema>;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}

export function markdownResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function render(
  format: ResponseFormat,
  data: Record<string, unknown>,
  markdown: () => string,
): ToolResult {
  return format === "json" ? jsonResult(data) : markdownResult(markdown());
}

/** Attribution Garmin's API brand guidelines ask for on analytics built from Garmin device data. */
export const GARMIN_DERIVED_ATTRIBUTION = "Insights derived in part from Garmin device-sourced data.";

/** render() for analysis results: adds Garmin's attribution as `data_source` and a closing line. */
export function renderDerived(
  format: ResponseFormat,
  data: Record<string, unknown>,
  markdown: () => string,
): ToolResult {
  return render(format, { ...data, data_source: GARMIN_DERIVED_ATTRIBUTION }, () => {
    return `${markdown()}\n\n_${GARMIN_DERIVED_ATTRIBUTION}_`;
  });
}

// ---- value formatting for markdown ----

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatKm(meters: number | null | undefined): string {
  return meters == null || meters === 0 ? "–" : `${(meters / 1000).toFixed(2)} km`;
}

/** Pace as min:ss per km, from speed in m/s. */
export function formatPace(metersPerSecond: number | null | undefined): string {
  if (!metersPerSecond) return "–";
  return `${formatDuration(1000 / metersPerSecond)} /km`;
}

/** Swim pace per 100 m, from speed in m/s. */
export function formatSwimPace(metersPerSecond: number | null | undefined): string {
  if (!metersPerSecond) return "–";
  return `${formatDuration(100 / metersPerSecond)} /100m`;
}

export function formatKmh(metersPerSecond: number | null | undefined): string {
  return metersPerSecond ? `${(metersPerSecond * 3.6).toFixed(1)} km/h` : "–";
}

export function round(value: number | null | undefined, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Drops null/undefined fields so JSON output stays compact. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>;
}
