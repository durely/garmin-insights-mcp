# How it works

The details behind the [README](../README.md): how the server runs, what it keeps on your machine, and how it calculates its numbers.

## A local stdio server

This is a **local stdio MCP server**. Your AI client (Claude Code, Claude Desktop, Cursor, …) starts it as a child process and talks to it over stdin/stdout. There's no port, no web server and no account. It runs on your machine with your API key, and only calls Garmin's API (`personal.connectapi.garmin.com`).

Because it's local, it works in desktop and CLI clients, but not in claude.ai on the web or mobile. A remote mode for those is planned.

The server exchanges your key for a 24-hour token and caches that token in the data directory (`0600`). A key added or rotated while the server runs is picked up on the next call.

## Local cache and sync

The server keeps your Garmin data in a local SQLite database (`~/.garmin-insights-mcp/garmin.db`), so questions about months or years of data are answered instantly, without hitting Garmin for every question.
- **First use:** the first tool call starts a sync. Activities come first (a few seconds), so you get an answer right away; the rest continues in the background. A first sync of several years of history takes a few minutes.
- **Afterwards:** when the cache is more than an hour old, tools refresh it automatically (a few seconds). Set `GARMIN_MCP_AUTO_SYNC=false` to only sync on request.
- **What's synced:**
  - All history: activities (including multisport legs), daily summaries (steps, calories, resting HR, stress, Body Battery, intensity minutes, respiration), sleep, nightly HRV, weight.
  - Last 150 days (`GARMIN_MCP_DETAIL_DAYS`): HRV readings through the night, intraday heart rate, SpO2, Body Battery curve. Older days are fetched when you ask about them.
- **Interrupted?** Progress is kept; the next sync continues where it stopped. Only one sync runs at a time, even with several sessions open.
- **Throttling:** Garmin publishes no rate limits. The server sends at most 4 requests per second (`GARMIN_MCP_REQUESTS_PER_SECOND`) and backs off on errors.

**Garmin deletes intraday detail after about 4–5 months.** That covers heart rate through the day and overnight HRV readings; Body Battery curves are kept longer. Daily summaries, sleep and HRV summaries are kept indefinitely. The default detail window (150 days) roughly matches what Garmin keeps, and the cache keeps whatever it has stored, so syncing at least every few months preserves that detail for good.

To start over, delete the data directory (or the `garmin-mcp-data` Docker volume).

### Syncing from the terminal

You can run the first (or a full) sync without an AI client. The examples use `garmin-insights`, the command you get with `npm install -g @durely/garmin-insights-mcp`. Without installing, write `npx -y @durely/garmin-insights-mcp` instead; from source, `node dist/index.js`.

```bash
garmin-insights sync
garmin-insights sync --from 2019-01-01 --domains activities,sleep
garmin-insights sync --fit        # also download every activity's FIT file
garmin-insights status            # what's cached
garmin-insights auth              # ask for the key (hidden), check it with Garmin, save it (0600)
garmin-insights auth --check      # check the configured key with Garmin; exits 1 if it's missing or rejected

# Docker:
docker run -i --rm -v ~/.config/garmin/connect-personal-api-key:/run/secrets/garmin_api_key:ro \
  -v garmin-mcp-data:/data -e GARMIN_MCP_TIMEZONE=Europe/Brussels ghcr.io/durely/garmin-insights-mcp sync
```

## FIT files

Laps and time series come from each activity's original FIT file, which is exactly what your watch, bike computer or app recorded. Files are downloaded the first time you ask about an activity (one request, about half a second), kept in `<data dir>/fit/`, and parsed in milliseconds after that.
- **Multisport:** Garmin stores a whole triathlon in one file, so legs are served from their parent's file.
- **Metrics vary by device:** Garmin devices add VO2max, recovery time and lactate threshold; older watches and third-party apps (Zwift, Rouvy) may not.

To download every FIT file up front, run `garmin-insights sync --fit`, or call `garmin_sync` with `domains: ["fit_files"]`. It downloads about 2.4 files per second; files are typically 13–730 KB (~170 KB on average), so 1,000 activities take about 7 minutes and ~170 MB. You can interrupt it; it continues where it stopped.

## About the numbers

- **Training load** is Garmin's own load per activity. Activities without it (older devices, some third-party uploads) get an estimate from average heart rate (Banister TRIMP), scaled to Garmin's load using your own activities. Responses say what share is estimated.
- **Fitness, fatigue and form** use the usual 42- and 7-day weighting (CTL/ATL/TSB).
- **Power metrics:** normalized power and intensity factor matched Garmin's own values in testing.
- **FTP** comes from the activity's Garmin FTP, or Garmin's lactate threshold power, unless you give one.
- **Attribution:** following Garmin's API brand guidelines, analysis results end with "Insights derived in part from Garmin device-sourced data" (`data_source` in JSON), and the server's instructions ask the AI client to credit Garmin ("Garmin <device model>") when it presents the data.
- **SQL:** queries run read-only in a separate worker with a 10-second timeout and a row limit; only one `SELECT`/`WITH` statement is accepted. The `garmin://schema` resource describes the views (`activities`, `daily`, `sleep`, `hrv`, `weight`).

## What writes where

The Personal API is read-only, so nothing can change your Garmin account. Only `garmin_sync` and `garmin_download_activity_fit` write, and only to the local data directory. (The `auth` command writes just your key file.)

| Path (in the data directory) | Contents                                               |
| ---------------------------- | ------------------------------------------------------ |
| `garmin.db`                  | The cache: activities, health data, sync progress      |
| `fit/`                       | Downloaded FIT files                                   |
| `exports/`                   | FIT files exported with `garmin_download_activity_fit` |
| token cache                  | The 24-hour access token (`0600`)                      |

## Docker details

- `-i` is required: the client talks to the server over stdin.
- The key file is mounted read-only at `/run/secrets/garmin_api_key`. The named volume `garmin-mcp-data` keeps the cache and token between runs.
- **Set `GARMIN_MCP_TIMEZONE`** to your time zone. Containers run in UTC, and Garmin addresses days by your local date.
- To get exported FIT files onto your machine, also mount a host folder: `-v ~/garmin-exports:/data/exports`.
- On Linux, if the container can't read your `chmod 600` key file, add `--user "$(id -u):$(id -g)"`. The server still works if it can't write its token cache; it just requests a new token after each restart.
- In JSON configs, use the full path instead of `~` (e.g. `/Users/you/.config/...`), because `~` isn't expanded there.

## Running from source

To run your own build instead of the published package or image:

```bash
git clone https://github.com/durely/garmin-insights-mcp.git
cd garmin-insights-mcp
npm install && npm run build                # Node.js: server command is node /absolute/path/to/garmin-insights-mcp/dist/index.js
docker build -t garmin-insights-mcp .       # or Docker: use garmin-insights-mcp as the image name in the docker run command
```

To update, run `git pull` and build again. Your synced data is kept.

## Development

```bash
npm run dev          # run from source (Node 24 runs TypeScript directly)
npm test             # unit tests (no network)
npm run lint         # Biome
npm run typecheck
npm run build && npm run smoke   # live end-to-end test against your account
npm run smoke -- docker run -i --rm -v ~/.config/garmin/connect-personal-api-key:/run/secrets/garmin_api_key:ro garmin-insights-mcp   # same test against the Docker image
npx @modelcontextprotocol/inspector node dist/index.js   # interactive tool explorer
npm run openapi      # re-extract Garmin's OpenAPI spec and regenerate src/garmin/generated (descriptions go to a local openapi.local.md)
```

Releasing: set the new version in `package.json` and `SERVER_VERSION` in `src/config.ts`, commit, then push a tag (`git tag v0.6.0 && git push origin v0.6.0`). The release workflow checks that the tag and both versions match, runs the checks, publishes to npm with provenance and pushes the image to `ghcr.io/durely/garmin-insights-mcp` (amd64 and arm64, tagged with the version and `latest`).

Layout:

```
src/garmin/    Garmin API client: auth, throttled HTTP, typed endpoints. No MCP dependency.
src/store/     SQLite cache and SQL views
src/sync/      Background sync engine
src/fit/       FIT download and parsing
src/analysis/  Training and recovery analysis (pure functions)
src/query/     Sandboxed read-only SQL
src/mcp/       MCP server: tools, prompts, formatting
src/cli/       Command-line commands besides serve and sync (auth)
docs/          This document
```
