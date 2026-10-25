// Extracts Garmin's Personal API OpenAPI spec from the Swagger docs page.
// Garmin doesn't publish the spec as a standalone file; the Swagger page embeds it in a
// JS bundle as `JSON.parse('{"openapi":"3.0.1",...}')`. We fetch it rather than commit it,
// because the document itself is Garmin's (generate-openapi-types.ts keeps its text out of the repo too).
//
// Usage: node scripts/fetch-openapi.ts   → writes openapi/garmin-personal-api.json

import { mkdir, writeFile } from "node:fs/promises";

const ORIGIN = "https://developer.garmin.com";
const PAGE = `${ORIGIN}/gc-developer-program/personal/swagger-docs/`;
const OUT_DIR = "openapi";
const OUT_FILE = `${OUT_DIR}/garmin-personal-api.json`;
const MARKER = '{"openapi":"';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  return res.text();
}

// Decodes the body of a single-quoted JS string literal without eval.
function decodeJsString(literal: string): string {
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };
  return literal.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    if (esc.length > 1 && (esc[0] === "u" || esc[0] === "x")) {
      return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
    }
    return simple[esc] ?? esc;
  });
}

function extractSpec(bundle: string): unknown {
  const markerAt = bundle.indexOf(MARKER);
  if (markerAt < 0) return undefined;
  const opener = "JSON.parse('";
  const start = bundle.lastIndexOf(opener, markerAt) + opener.length;
  let end = start;
  for (; end < bundle.length; end++) {
    if (bundle[end] === "\\") {
      end++;
      continue;
    }
    if (bundle[end] === "'") break;
  }
  return JSON.parse(decodeJsString(bundle.slice(start, end)));
}

const html = await fetchText(PAGE);
const scripts = [...html.matchAll(/src="(\/[^"]+\.js)"/g)].map((m) => m[1] as string);
// The page-specific chunk is the most likely holder; try it first, then the rest.
scripts.sort((a, b) => Number(b.includes("swagger")) - Number(a.includes("swagger")));

for (const src of scripts) {
  const spec = extractSpec(await fetchText(ORIGIN + src)) as
    | { info?: { title?: string; version?: string }; paths?: object }
    | undefined;
  if (!spec?.paths) continue;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(spec, null, 2)}\n`);
  console.error(
    `Wrote ${OUT_FILE}: ${spec.info?.title} ${spec.info?.version}, ${Object.keys(spec.paths).length} paths (from ${src})`,
  );
  process.exit(0);
}
console.error(`Could not find an embedded OpenAPI spec in ${PAGE}. Garmin may have changed the page.`);
process.exit(1);
