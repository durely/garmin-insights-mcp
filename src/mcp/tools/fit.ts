import { existsSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { FitLap, FitLength, FitSession, FitSummary } from "../../fit/model.ts";
import { selectStreams } from "../../fit/streams.ts";
import { speedText, sportFamily } from "../activity-view.ts";
import type { AppContext } from "../context.ts";
import {
  CHARACTER_LIMIT,
  compact,
  formatDuration,
  formatKm,
  render,
  responseFormatSchema,
} from "../format.ts";

const activityId = z.number().int().positive().describe("Garmin activity ID from garmin_list_activities");

const STREAM_FIELDS = [
  "heart_rate",
  "power",
  "speed",
  "cadence",
  "altitude",
  "distance",
  "temperature",
  "respiration_rate",
  "performance_condition",
  "vertical_oscillation",
  "stance_time",
  "position",
] as const;
const DEFAULT_STREAM_FIELDS = ["heart_rate", "power", "speed", "cadence", "altitude"];

export function registerFitTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "garmin_get_activity_laps",
    {
      title: "Get activity laps",
      description: `Get the laps (and sessions, swim lengths and Garmin's physiological metrics) of one activity, from its original FIT file.

Returns per lap: start offset, duration (elapsed and timer), distance, pace/speed, avg/max HR, avg/max/normalized power, cadence, ascent/descent, intensity (active/rest/warmup/cooldown) and lap trigger; for swims, stroke and lengths. Also: device, multisport sessions, and FIT-only metrics when the device recorded them (VO2max, recovery time, lactate threshold HR/power).

Use it for interval sessions, splits and pacing. Downloads the FIT file on first use (one request), then it's cached. For a multisport leg ID, returns only that leg's laps.`,
      inputSchema: z.strictObject({
        activity_id: activityId,
        lap_offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Skip this many laps (for activities with very many laps)"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ activity_id, lap_offset, response_format }, extra) => {
      const { summary, sessionIndex, fileId } = await ctx.fit.getSummary(activity_id, extra.mcpReq.signal);
      const sessions =
        sessionIndex === null ? summary.sessions : summary.sessions.filter((s) => s.index === sessionIndex);
      // For a multisport leg, number laps and measure offsets from the leg's start (like the streams' t axis).
      const origin = sessionIndex === null ? 0 : (summary.sessions[sessionIndex]?.start_offset_s ?? 0);
      const allLaps = (
        sessionIndex === null ? summary.laps : summary.laps.filter((l) => l.session_index === sessionIndex)
      ).map((l, i) => ({ ...l, number: i + 1, start_offset_s: l.start_offset_s - origin }));
      const lengths = sessionIndex === null ? summary.lengths : lengthsInSession(summary, sessionIndex);

      const build = (laps: Array<FitLap & { number: number }>) => {
        const nextOffset = lap_offset + laps.length;
        const hasMore = nextOffset < allLaps.length;
        const data = {
          activity_id,
          ...(fileId !== activity_id ? { multisport_parent_id: fileId, session_index: sessionIndex } : {}),
          device: summary.device,
          metrics: compact({ ...summary.metrics }),
          sessions: sessions.map((s) => compact({ ...s })),
          lap_count: allLaps.length,
          lap_offset,
          has_more_laps: hasMore,
          ...(hasMore ? { next_lap_offset: nextOffset } : {}),
          laps: laps.map((l) => compact({ ...l })),
          ...(lengths.length ? { swim_lengths: lengthSummary(lengths) } : {}),
        };
        return render(response_format, data, () =>
          lapsMarkdown(activity_id, summary, sessions, laps, lap_offset, allLaps.length, lengths, fileId),
        );
      };

      let laps = allLaps.slice(lap_offset);
      let result = build(laps);
      while (laps.length > 1 && (result.content[0]?.text.length ?? 0) > CHARACTER_LIMIT) {
        laps = laps.slice(0, Math.ceil(laps.length / 2));
        result = build(laps);
      }
      return result;
    },
  );

  server.registerTool(
    "garmin_get_activity_streams",
    {
      title: "Get activity time series",
      description: `Get second-by-second data from one activity's FIT file, downsampled to fit in context.

Returns per field min/avg/max over the window, plus columnar series: t (seconds from the start of the activity, or of the leg for a multisport leg) and one array per field. Units: heart_rate bpm, power W, speed m/s, cadence steps/min (running) or rpm (cycling) or strokes/min, altitude m, distance m (cumulative), temperature °C, respiration_rate breaths/min, performance_condition (Garmin's -20..+20 score), vertical_oscillation mm, stance_time ms. Cadence averages leave out zeros.

Defaults to ${DEFAULT_STREAM_FIELDS.join(", ")} (whichever the activity has) at 10 s resolution, at most 500 points; the resolution coarsens automatically for long activities. Zoom in with start_s/end_s (e.g. one interval from garmin_get_activity_laps' start offsets) and a smaller resolution_s.

"position" adds GPS latitude/longitude and reveals where the user was: only request it when the user asks for location or route analysis. Developer fields (e.g. running power from a Connect IQ app) can be requested by the name listed in available_fields, like "dev_RP_Power".`,
      inputSchema: z.strictObject({
        activity_id: activityId,
        fields: z
          .array(z.string().min(2).max(60))
          .min(1)
          .max(12)
          .optional()
          .describe(`Fields to return: ${STREAM_FIELDS.join(", ")}, or a dev_* field`),
        resolution_s: z.number().int().min(1).max(3600).default(10).describe("Seconds per point (minimum)"),
        max_points: z
          .number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Upper bound on points returned"),
        start_s: z.number().min(0).optional().describe("Window start, seconds from the start"),
        end_s: z.number().min(0).optional().describe("Window end, seconds from the start"),
        response_format: z
          .enum(["json", "markdown"])
          .default("json")
          .describe("'json' (default) for the full series, 'markdown' for stats and a short preview table"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      const parsed = await ctx.fit.getParsed(input.activity_id, extra.mcpReq.signal);
      const available = [
        ...parsed.summary.record_fields.filter((f) => !f.startsWith("position_")),
        ...(parsed.summary.record_fields.includes("position_lat") ? ["position"] : []),
      ];
      const requested = input.fields ?? DEFAULT_STREAM_FIELDS.filter((f) => available.includes(f));
      const unknown = requested.filter((f) => !available.includes(f));
      if (unknown.length) {
        throw new Error(
          `This activity has no ${unknown.join(", ")} data. Available fields: ${available.join(", ")}.`,
        );
      }
      const fields = requested.flatMap((f) => (f === "position" ? ["position_lat", "position_long"] : [f]));

      const session = parsed.sessionIndex !== null ? parsed.summary.sessions[parsed.sessionIndex] : undefined;
      const build = (resolutionS: number) => ({
        activity_id: input.activity_id,
        ...(session
          ? { multisport_parent_id: parsed.fileId, leg: `${session.sport}/${session.sub_sport}` }
          : {}),
        available_fields: available,
        ...selectStreams(parsed, {
          fields,
          resolutionS,
          maxPoints: input.max_points,
          ...(input.start_s !== undefined ? { startS: input.start_s } : {}),
          ...(input.end_s !== undefined ? { endS: input.end_s } : {}),
          sessionIndex: parsed.sessionIndex,
        }),
      });
      let data = build(input.resolution_s);
      if (input.response_format === "json") {
        // Stay under CHARACTER_LIMIT by coarsening the resolution, never by cutting the series.
        let text = JSON.stringify(data);
        while (text.length > CHARACTER_LIMIT && data.point_count > 1) {
          data = build(data.resolution_s * 2);
          text = JSON.stringify(data);
        }
        if (text.length > CHARACTER_LIMIT)
          throw new Error("Too many fields to return at once; request fewer fields.");
        const coarsened =
          data.resolution_s > Math.max(input.resolution_s, build(input.resolution_s).resolution_s);
        const output = coarsened
          ? {
              ...data,
              note: `Resolution coarsened to ${data.resolution_s} s to fit the response size; request fewer fields or a shorter window for more detail.`,
            }
          : data;
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      }
      return {
        content: [
          {
            type: "text",
            text: streamsMarkdown(
              data,
              sportFamily(session?.sport ?? parsed.summary.sessions[0]?.sport ?? undefined),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "garmin_download_activity_fit",
    {
      title: "Export activity FIT file",
      description: `Save the original FIT file of an activity to the server's exports folder and return its path, e.g. to import it into another tool (Intervals.icu, Golden Cheetah, a spreadsheet converter).

The file is exactly what the device recorded. Saved as <data dir>/exports/<activity_id>.fit; an existing export is kept, not overwritten. For a multisport leg, exports the whole multisport file.`,
      inputSchema: z.strictObject({ activity_id: activityId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ activity_id }, extra) => {
      const file = await ctx.fit.getFilePath(activity_id, extra.mcpReq.signal);
      const exportsDir = join(ctx.config.dataDir, "exports");
      const target = join(exportsDir, `${file.fileId}.fit`);
      await mkdir(exportsDir, { recursive: true, mode: 0o700 });
      const existed = await stat(target).then(
        () => true,
        () => false,
      );
      if (!existed) await copyFile(file.path, target);
      const note = file.fileId !== activity_id ? ` (the whole multisport activity ${file.fileId})` : "";
      const docker = existsSync("/.dockerenv")
        ? "\nThis path is inside the Docker container; mount a host folder on it to get the file, e.g. -v ~/garmin-exports:/data/exports."
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${existed ? "Already exported" : "Exported"}${note}: ${target}\nSize: ${(file.size / 1024).toFixed(0)} KB, SHA-256 ${file.sha256}${docker}`,
          },
        ],
      };
    },
  );
}

function lengthsInSession(summary: FitSummary, sessionIndex: number): FitLength[] {
  const s = summary.sessions[sessionIndex];
  if (!s) return [];
  const end = s.start_offset_s + (s.elapsed_s ?? Number.POSITIVE_INFINITY);
  return summary.lengths.filter((l) => l.start_offset_s >= s.start_offset_s && l.start_offset_s < end);
}

function lengthSummary(lengths: FitLength[]) {
  const active = lengths.filter((l) => l.type !== "idle");
  const strokes = active.map((l) => l.strokes).filter((v): v is number => v !== null);
  return {
    total: lengths.length,
    active: active.length,
    rest: lengths.length - active.length,
    avg_strokes_per_length: strokes.length
      ? Math.round((strokes.reduce((a, b) => a + b, 0) / strokes.length) * 10) / 10
      : null,
    strokes: [...new Set(active.map((l) => l.stroke).filter(Boolean))],
  };
}

function lapsMarkdown(
  activityId: number,
  summary: FitSummary,
  sessions: FitSession[],
  laps: Array<FitLap & { number: number }>,
  offset: number,
  total: number,
  lengths: FitLength[],
  fileId: number,
): string {
  const m = summary.metrics;
  const d = summary.device;
  const header = [
    `${d.product ?? d.manufacturer ?? "Unknown device"}${d.software_version ? ` (software ${d.software_version / 100})` : ""}`,
    `${total} ${total === 1 ? "lap" : "laps"}`,
    m.vo2max ? `VO2max ${m.vo2max.toFixed(1)}` : null,
    m.recovery_time_min ? `recovery ${Math.round(m.recovery_time_min / 60)} h` : null,
    m.lactate_threshold_hr ? `LTHR ${m.lactate_threshold_hr}` : null,
    m.lactate_threshold_power_w ? `LT power ${m.lactate_threshold_power_w} W` : null,
  ].filter(Boolean);
  const lines = [`# Laps for activity ${activityId}`, "", header.join(" · ")];
  if (fileId !== activityId && sessions[0]) {
    lines.push(
      "",
      `Multisport leg ${sessions[0].index + 1} (${sessions[0].sport}/${sessions[0].sub_sport}) of activity ${fileId}.`,
    );
  }
  if (sessions.length > 1) {
    lines.push(
      "",
      "## Sessions",
      "",
      "| # | Sport | Start | Duration | Distance | Avg HR | Power avg/NP | TE |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const s of sessions) {
      lines.push(
        `| ${s.index + 1} | ${s.sport}/${s.sub_sport} | +${formatDuration(s.start_offset_s)} | ${formatDuration(s.timer_s)} | ${formatKm(s.distance_m)} | ${s.avg_hr ?? "–"} | ${s.avg_power_w ? `${s.avg_power_w}/${s.normalized_power_w ?? "–"} W` : "–"} | ${s.aerobic_te ?? "–"} |`,
      );
    }
  }
  const hasPower = laps.some((l) => l.avg_power_w !== null);
  lines.push(
    "",
    "## Laps",
    "",
    `| # | Start | Type | Time | Distance | Pace/speed | HR avg/max |${hasPower ? " Power avg/NP |" : ""} Cadence | ↑ m |`,
    `|---|---|---|---|---|---|---|${hasPower ? "---|" : ""}---|---|`,
  );
  for (const l of laps) {
    const sport = sportFamily(sessions.find((s) => s.index === l.session_index)?.sport ?? undefined);
    lines.push(
      `| ${l.number} | +${formatDuration(l.start_offset_s)} | ${l.intensity ?? "–"} | ${formatDuration(l.timer_s)} | ${formatKm(l.distance_m)} | ${l.distance_m ? speedText(sport, l.avg_speed_mps) : "–"} | ${l.avg_hr ?? "–"}/${l.max_hr ?? "–"} |${hasPower ? ` ${l.avg_power_w ?? "–"}/${l.normalized_power_w ?? "–"} |` : ""} ${l.avg_cadence !== null ? Math.round(l.avg_cadence) : "–"} | ${l.ascent_m ?? "–"} |`,
    );
  }
  if (offset + laps.length < total)
    lines.push("", `More laps: call again with lap_offset=${offset + laps.length}.`);
  if (lengths.length) {
    const s = lengthSummary(lengths);
    lines.push(
      "",
      `Swim lengths: ${s.active} active, ${s.rest} rest; ${s.avg_strokes_per_length ?? "–"} strokes/length; ${s.strokes.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function streamsMarkdown(
  data: ReturnType<typeof selectStreams> & { activity_id: number; available_fields: string[]; leg?: string },
  sport: ReturnType<typeof sportFamily>,
): string {
  const fields = Object.keys(data.series);
  const lines = [
    `# Time series for activity ${data.activity_id}${data.leg ? ` (leg: ${data.leg})` : ""}`,
    "",
    `${formatDuration(data.start_s)}–${formatDuration(data.end_s)}, ${data.point_count} points at ${data.resolution_s} s (from ${data.source_points} samples). Available: ${data.available_fields.join(", ")}`,
    "",
    "| Field | Min | Avg | Max |",
    "|---|---|---|---|",
    ...fields.map((f) => {
      const s = data.stats[f];
      const fmt = (v: number | null | undefined) =>
        f === "speed" && v ? `${v} (${speedText(sport, v)})` : (v ?? "–");
      return `| ${f} | ${fmt(s?.min)} | ${fmt(s?.avg)} | ${fmt(s?.max)} |`;
    }),
  ];
  // A short preview; the full series is in JSON mode.
  const step = Math.max(1, Math.ceil(data.t.length / 30));
  lines.push("", `| t | ${fields.join(" | ")} |`, `|---|${fields.map(() => "---").join("|")}|`);
  for (let i = 0; i < data.t.length; i += step) {
    lines.push(
      `| ${formatDuration(data.t[i])} | ${fields.map((f) => data.series[f]?.[i] ?? "–").join(" | ")} |`,
    );
  }
  lines.push("", "Preview only; use response_format='json' for every point.");
  return lines.join("\n");
}
