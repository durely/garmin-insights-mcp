# durely insights

[![npm](https://img.shields.io/npm/v/@durely/garmin-insights-mcp)](https://www.npmjs.com/package/@durely/garmin-insights-mcp)
[![Node](https://img.shields.io/node/v/@durely/garmin-insights-mcp)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/durely/garmin-insights-mcp/pkgs/container/garmin-insights-mcp)
[![CI](https://github.com/durely/garmin-insights-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/durely/garmin-insights-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@durely/garmin-insights-mcp)](LICENSE)

**Ask your AI assistant about your own Garmin data: your full training history, health and recovery, analysed.**

durely insights is an [MCP](https://modelcontextprotocol.io) server that connects your Garmin Connect account to your AI assistant (Claude, Cursor, GitHub Copilot, Gemini CLI, Codex or any other MCP client) through Garmin's official **Personal API**. It keeps a copy of your history on your own machine, so you can ask about a single run or about years of training and get an answer right away.

> **Early development.** Everything below works, but tools and options can still change before version 1.0.

Unofficial project: not affiliated with or endorsed by Garmin.

## What you can ask

**Activities**
- "What did I do this week?" / "Show my last 10 runs"
- "Tell me about yesterday's run": splits, heart rate, training effect, load
- "How did my power and heart rate evolve over the intervals of Tuesday's ride?"
- "Compare the bike legs of my last two triathlons lap by lap"
- "Am I getting fitter on my regular Tuesday run?"

**Training**
- "How has my training load and fitness developed over the last 3 months?"
- "Analyse Saturday's ride: time in zones, decoupling, best efforts"
- "How many kilometres did I run, ride and swim per year?"

**Health and recovery**
- "How did I sleep this week, and how was my HRV?"
- "Does a hard training day affect my HRV the next morning?"
- "Compare my resting heart rate and sleep score per month this year"
- "Show my heart rate and Body Battery through yesterday"

## What makes it different

- **Official API, no password.** It uses a Personal API key that you create in Garmin Connect and can revoke at any time. No scraping, nothing that breaks when Garmin changes its login.
- **Your whole history, instantly.** Everything is synced once to a local database and kept up to date, so trend questions over months or years don't wait on Garmin.
- **Second-by-second detail.** Laps, swim lengths, heart rate, power, cadence and more come from each activity's original FIT file, including VO2max, recovery time and lactate threshold when your device records them.
- **Analysis built in.** Time in zones, training load and fitness/fatigue/form, aerobic decoupling, best efforts, recovery trends and comparisons of similar sessions. For anything else, your assistant can run read-only SQL over your data.
- **Private by default.** Your data stays on your machine. Your name, account ID and GPS positions are kept out of answers unless you ask for a route.
- **Read-only.** It can't change anything in your Garmin account.

## Quick start

You need Garmin Connect, an MCP client (Claude Code, Claude Desktop, Cursor, …) and either **Node.js 24+** or **Docker**.

### 1. Create your Personal API key

1. In Garmin Connect on the web, open [Settings → Personal API Token](https://connect.garmin.com/app/settings/personalApiToken).
2. Create a key and pick how long it stays valid (30 days to 1 year). **Garmin shows it only once**, so copy it.
3. Save it with Node.js:

   ```bash
   npx -y @durely/garmin-insights-mcp auth
   ```

   It asks for the key (your input stays hidden), checks it with Garmin and saves it to `~/.config/garmin/connect-personal-api-key`, readable only by you.

   **Without Node.js** (Docker), save it to that file yourself:

   ```bash
   mkdir -p ~/.config/garmin && chmod 700 ~/.config/garmin
   pbpaste > ~/.config/garmin/connect-personal-api-key    # macOS; elsewhere, paste it into this file with an editor
   chmod 600 ~/.config/garmin/connect-personal-api-key
   ```

Don't paste the key into a chat with your AI assistant.

### 2. Choose how to run it

**With Node.js (npx):** nothing to install. Your server command is:

```bash
npx -y @durely/garmin-insights-mcp
```

npx downloads the [npm package](https://www.npmjs.com/package/@durely/garmin-insights-mcp) on first use and picks up new releases by itself. Check your key with `npx -y @durely/garmin-insights-mcp auth --check`. Prefer a fixed install? `npm install -g @durely/garmin-insights-mcp` gives you the `garmin-insights` command.

**Or with Docker** (no Node.js needed; Docker must be running). Your server command is:

```bash
docker run -i --rm \
  -v ~/.config/garmin/connect-personal-api-key:/run/secrets/garmin_api_key:ro \
  -v garmin-mcp-data:/data \
  -e GARMIN_MCP_TIMEZONE=Europe/Brussels \
  ghcr.io/durely/garmin-insights-mcp
```

Replace `Europe/Brussels` with your own time zone. To check your key, run the same command with `auth --check` at the end. The image runs on Intel and ARM (Apple silicon, Raspberry Pi). More Docker tips are in [How it works](docs/how-it-works.md#docker-details).

**Or from source:** clone the repo and build it with npm or Docker. See [How it works](docs/how-it-works.md#running-from-source).

**Updating:** with npx, restart your client. With Docker, run `docker pull ghcr.io/durely/garmin-insights-mcp`. Your synced data is kept.

### 3. Add it to your AI client

**Claude Code:**

```bash
claude mcp add garmin --scope user -- npx -y @durely/garmin-insights-mcp
```

With Docker:

```bash
claude mcp add garmin --scope user -- docker run -i --rm \
  -v ~/.config/garmin/connect-personal-api-key:/run/secrets/garmin_api_key:ro \
  -v garmin-mcp-data:/data \
  -e GARMIN_MCP_TIMEZONE=Europe/Brussels \
  ghcr.io/durely/garmin-insights-mcp
```

`--scope user` makes it available in all your projects.

**Claude Desktop:** open Settings → Developer → Edit Config, add this, and restart Claude Desktop:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "@durely/garmin-insights-mcp"]
    }
  }
}
```

Desktop apps don't see your shell's `PATH`, so use the full path to `npx` (find it with `which npx`). If the log then says `node` isn't found, add `"env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }`, with the folder from `which node` first.

<details>
<summary><b>Claude Desktop with Docker, Cursor, VS Code, Gemini CLI, Codex CLI</b></summary>

**Claude Desktop with Docker:**

```json
{
  "mcpServers": {
    "garmin": {
      "command": "/usr/local/bin/docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/Users/you/.config/garmin/connect-personal-api-key:/run/secrets/garmin_api_key:ro",
        "-v",
        "garmin-mcp-data:/data",
        "-e",
        "GARMIN_MCP_TIMEZONE=Europe/Brussels",
        "ghcr.io/durely/garmin-insights-mcp"
      ]
    }
  }
}
```

Use full paths here; `~` isn't expanded in JSON configs.

**Cursor:** the same JSON as Claude Desktop, in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

**VS Code (GitHub Copilot agent mode):** in `.vscode/mcp.json`, or via the command palette → _MCP: Add Server_:

```json
{
  "servers": {
    "garmin": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@durely/garmin-insights-mcp"]
    }
  }
}
```

**Gemini CLI:**

```bash
gemini mcp add garmin npx -- -y @durely/garmin-insights-mcp
```

**OpenAI Codex CLI:**

```bash
codex mcp add garmin -- npx -y @durely/garmin-insights-mcp
```

**Others** (Windsurf, Cline, Zed, …): look for "MCP servers" in their settings. Any client that supports **stdio** servers works.

</details>

### 4. Try it

Start a new session and ask: _"Check my Garmin connection."_ It should report **connected**.

The first question starts a sync in the background. Your activities are there within seconds; the rest of your history follows in a few minutes. After that, the data refreshes automatically when it's more than an hour old.

## Good to know

- **Keep your key's expiry date in mind.** Garmin's API doesn't tell the server when your key expires. Set `GARMIN_API_KEY_EXPIRES` (e.g. `2027-10-24`) in your client config and `garmin_status` reminds you in time. With Docker, pass it to the container instead: add `-e GARMIN_API_KEY_EXPIRES=2027-10-24` to the `docker run` arguments. Replacing the key file is enough; no restart is needed.
- **Sync at least every few months.** Garmin deletes intraday detail (heart rate through the day, overnight HRV readings) after about 4–5 months. Whatever the server has synced stays in your local copy.
- **Desktop and CLI clients only, for now.** The server runs on your own machine, so it doesn't work in claude.ai on the web or mobile yet.
- **Your data goes to your AI client.** The server only talks to Garmin, but the answers it gives go to the MCP client and model you use.

## Troubleshooting

| Problem                                                | Fix                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Tools don't show up                                    | Start a new session or restart the client. In Claude Code, check `/mcp`.                                               |
| `spawn npx ENOENT` / server won't start (desktop apps) | Use the full path to `npx` or `docker` in the config.                                                                  |
| "No Garmin Personal API key configured"                | The key file is missing or not mounted. Check the path (and the `-v` mount for Docker).                                |
| "Garmin rejected the Personal API key"                 | The key expired or was revoked. Create a new one and replace the file (or run `auth` again). `auth --check` tests it.  |
| Dates are off by a day                                 | Set `GARMIN_MCP_TIMEZONE` to your time zone (especially in Docker). `garmin_status` warns when it differs from Garmin. |
| Want to see the tools without an AI client             | `npx @modelcontextprotocol/inspector npx -y @durely/garmin-insights-mcp`                                               |

## Tools

You don't need to call these yourself; your assistant picks them. For reference:

| Tool                           | What it does                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `garmin_status`                | Connection check: key, token, time zone, key expiry                                             |
| `garmin_get_profile`           | Profile settings, heart rate zones per sport, fitness age                                       |
| `garmin_list_activities`       | Search your activities by date, sport, name, distance or duration                               |
| `garmin_get_activity`          | One activity in full: summary metrics, splits, structured workout                               |
| `garmin_get_activity_laps`     | Laps from the FIT file: pace, HR, power, cadence, swim lengths, VO2max, recovery time           |
| `garmin_get_activity_streams`  | Second-by-second HR, power, speed, cadence, altitude, …; zoom into any part                     |
| `garmin_analyze_activity`      | Time in zones, NP/IF/TSS, aerobic decoupling, best efforts, intervals                           |
| `garmin_compare_activities`    | 2–6 activities side by side                                                                     |
| `garmin_training_summary`      | Per week or month: volume per sport, load, intensity, fitness/fatigue/form                      |
| `garmin_recovery_trends`       | Sleep, HRV, resting HR, Body Battery and stress against your baseline, and their link with load |
| `garmin_get_daily_health`      | Per day, week or month: steps, resting HR, stress, Body Battery, calories, sleep, HRV           |
| `garmin_get_sleep`             | Nightly sleep stages, times and sleep score                                                     |
| `garmin_get_hrv`               | Nightly HRV, 7-day average, baseline and status                                                 |
| `garmin_get_intraday`          | One day hour by hour: heart rate, Body Battery, overnight HRV, SpO2                             |
| `garmin_get_body_composition`  | Weigh-ins, body composition, weight goal                                                        |
| `garmin_get_nutrition`         | Food and hydration logged in Garmin Connect or a linked app                                     |
| `garmin_get_womens_health`     | Menstrual cycle tracking                                                                        |
| `garmin_query`                 | Read-only SQL over your synced data                                                             |
| `garmin_download_activity_fit` | Save an activity's original FIT file, e.g. to import elsewhere                                  |
| `garmin_sync`                  | Sync now, go further back in time, or download all FIT files                                    |
| `garmin_sync_status`           | What's synced, and sync progress                                                                |

In clients that support prompts (often as slash commands), `weekly_review`, `activity_deep_dive` and `recovery_check` start a guided analysis.

## Configuration

All optional; set them as environment variables in your client config.

| Variable                         | Default                                     | Purpose                                                          |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `GARMIN_API_KEY_EXPIRES`         |                                             | Your key's expiry date (`yyyy-MM-dd`), for reminders             |
| `GARMIN_MCP_TIMEZONE`            | system time zone                            | Your time zone (IANA name, e.g. `Europe/Brussels`)               |
| `GARMIN_PERSONAL_API_KEY`        |                                             | The key itself, instead of the key file                          |
| `GARMIN_PERSONAL_API_KEY_FILE`   | `~/.config/garmin/connect-personal-api-key` | Where the key file is                                            |
| `GARMIN_MCP_DATA_DIR`            | `~/.garmin-insights-mcp`                    | Where your synced data is kept                                   |
| `GARMIN_MCP_AUTO_SYNC`           | `true`                                      | Refresh automatically when the data is over an hour old          |
| `GARMIN_MCP_DETAIL_DAYS`         | `150`                                       | Days of intraday detail (HR, overnight HRV, SpO2) to keep synced |
| `GARMIN_MCP_REQUESTS_PER_SECOND` | `4`                                         | Request throttle; Garmin publishes no limits                     |
| `GARMIN_MCP_LOG_LEVEL`           | `info`                                      | `debug`, `info`, `warn` or `error` (logs go to stderr)           |

In Docker, the key file and data directory are `/run/secrets/garmin_api_key` and `/data`.

## Privacy and security

- **Your key stays on your machine.** It's exchanged for a 24-hour token, cached with owner-only permissions. The server never writes the key itself. To revoke access, delete the key in Garmin Connect.
- **No telemetry.** The server only talks to Garmin's Personal API.
- **Your synced data is sensitive.** The local database and FIT files hold your health and activity history, including GPS tracks. The data directory is readable only by you (in Docker it lives in the `garmin-mcp-data` volume).
- **Identity and location stay out of answers.** Your name, profile picture and account ID are removed before anything is stored. GPS positions are only returned when you ask for route or location analysis (or query an activity's start and end point with SQL).

## More

- [How it works](docs/how-it-works.md): the local cache and sync, FIT files, how the numbers are calculated, Docker details, development

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Data provided by Garmin devices via Garmin Connect; the analyses are insights derived in part from Garmin device-sourced data. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries. This project is not affiliated with or endorsed by Garmin.
