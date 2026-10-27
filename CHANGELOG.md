# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org).

## 0.5.1

Documentation only; the server is unchanged.
- **README:** install with `npx -y @durely/garmin-insights-mcp` or the `ghcr.io/durely/garmin-insights-mcp` image instead of cloning and building. Building from source moved to [How it works](docs/how-it-works.md#running-from-source).
- **README:** clearer key setup: run `auth` in your own terminal; the key stays out of your client config.

## 0.5.0

First public release.
- **21 tools** for activities, laps, second-by-second streams, training load and fitness, recovery, sleep, HRV, intraday data, body composition, nutrition and women's health, plus read-only SQL over the cache.
- **Local cache:** syncs your full history into SQLite once and keeps it up to date; the last 150 days also keep intraday detail.
- **FIT files:** laps, swim lengths and time series come from each activity's original file.
- **Analysis:** time in zones, aerobic decoupling, best efforts, fitness/fatigue/form and comparisons of similar sessions.
- **`auth` command:** checks your Personal API key with Garmin and saves it (`auth --check` only checks it).
- **Docker image** for running without Node.js.
