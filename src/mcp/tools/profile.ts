import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type HeartRateZones, today } from "../../garmin/index.ts";
import type { AppContext } from "../context.ts";
import { compact, render, responseFormatSchema } from "../format.ts";

export function registerProfileTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "garmin_get_profile",
    {
      title: "Get Garmin profile and zones",
      description: `Get the user's Garmin profile settings, heart rate zones per sport, and fitness age.

Returns: units and locale, time zone, preferred training days, HR zone floors per sport (with the max HR / LTHR / resting HR used to compute them), and the latest fitness age.

Use this before interpreting heart rate data (to know the user's zones), or when the user asks about their zones, max HR, lactate threshold or fitness age.`,
      inputSchema: z.strictObject({ response_format: responseFormatSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }, extra) => {
      const signal = extra.mcpReq.signal;
      const { client, config } = ctx;
      const settings = await client.getUserProfileSettings(signal);
      const zones = await client.getHeartRateZones(signal);
      const fitnessAge = await client.getFitnessAge(
        today(config.timeZone),
        { fullHistoryScan: true },
        signal,
      );

      const data = {
        settings: compact({
          locale: settings?.preferredLocale,
          measurement_system: settings?.measurementSystem,
          time_zone: settings?.timeZone,
          first_day_of_week: settings?.firstDayOfWeek?.dayName,
          available_training_days: settings?.availableTrainingDays,
          preferred_long_training_days: settings?.preferredLongTrainingDays,
        }),
        heart_rate_zones: zones.map(zoneView),
        fitness_age: fitnessAge
          ? compact({
              fitness_age: fitnessAge.fitnessAge,
              chronological_age: fitnessAge.chronologicalAge,
              achievable_fitness_age: fitnessAge.achievableFitnessAge,
              previous_fitness_age: fitnessAge.previousFitnessAge,
              last_updated: fitnessAge.lastUpdated,
            })
          : null,
      };

      return render(response_format, data, () => {
        const lines = ["# Garmin profile", ""];
        const s = data.settings;
        lines.push(
          `- Units: ${s.measurement_system ?? "?"}, locale ${s.locale ?? "?"}, time zone ${s.time_zone ?? "?"}`,
        );
        if (s.available_training_days) lines.push(`- Training days: ${s.available_training_days.join(", ")}`);
        if (data.fitness_age?.fitness_age != null) {
          lines.push(
            `- Fitness age: ${round1(data.fitness_age.fitness_age)} (chronological ${data.fitness_age.chronological_age ?? "?"}, achievable ${round1(data.fitness_age.achievable_fitness_age)})`,
          );
        }
        lines.push("", "## Heart rate zones (floor bpm)", "");
        lines.push(
          "| Sport | Method | Z1 | Z2 | Z3 | Z4 | Z5 | Max | LTHR | Rest |",
          "|---|---|---|---|---|---|---|---|---|---|",
        );
        for (const z of data.heart_rate_zones) {
          lines.push(
            `| ${z.sport} | ${z.method} | ${z.floors.join(" | ")} | ${z.max_hr ?? "–"} | ${z.lthr ?? "–"} | ${z.resting_hr ?? "–"} |`,
          );
        }
        return lines.join("\n");
      });
    },
  );
}

function zoneView(z: HeartRateZones) {
  return {
    sport: z.sport ?? "DEFAULT",
    method: z.trainingMethod ?? "?",
    floors: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor].map((v) => v ?? null),
    max_hr: z.maxHeartRateUsed ?? null,
    lthr: z.lactateThresholdHeartRateUsed ?? null,
    resting_hr: z.restingHeartRateUsed ?? null,
  };
}

function round1(v: number | undefined): string {
  return v == null ? "?" : v.toFixed(1);
}
