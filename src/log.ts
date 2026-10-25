// Minimal stderr logger. stdout carries the MCP protocol over stdio, so nothing may be written there.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.GARMIN_MCP_LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
