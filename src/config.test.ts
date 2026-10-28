import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("treats empty variables as unset", () => {
    const blank = Object.fromEntries(
      [
        "GARMIN_API_KEY_EXPIRES",
        "GARMIN_MCP_REQUESTS_PER_SECOND",
        "GARMIN_MCP_DETAIL_DAYS",
        "GARMIN_MCP_AUTO_SYNC",
        "GARMIN_MCP_DATA_DIR",
        "GARMIN_PERSONAL_API_BASE_URL",
        "GARMIN_PERSONAL_API_KEY_FILE",
        "GARMIN_MCP_TIMEZONE",
      ].map((name) => [name, " "]),
    );
    expect(loadConfig(blank)).toEqual(loadConfig({}));
  });

  it("reads the time zone", () => {
    expect(loadConfig({ GARMIN_MCP_TIMEZONE: "Europe/Brussels" }).timeZone).toBe("Europe/Brussels");
  });
});
