# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome. For a larger change, open an issue first so we can agree on the approach.

## Setup

You need Node.js 24.

```bash
npm install
npm test
```

[How it works](docs/how-it-works.md) explains the cache, the sync and the project layout. [AGENTS.md](AGENTS.md) has the full set of rules; the ones below matter most.

## Done means green

A change is ready when these all pass. CI runs exactly these, plus a Docker build:

```bash
npm run lint        # npm run format fixes most of it
npm run typecheck
npm test
npm run build
```

Tests live next to the code they cover (`foo.ts` + `foo.test.ts`) and never touch the network.

## Rules

- **Test data is invented.** Use the fakes in `src/testing/`. Never commit real API responses, FIT files, exports or your API key.
- **stdout is the MCP channel.** Log through `src/log.ts`, which writes to stderr. A stray `console.log` breaks the protocol.
- **Dates are local calendar dates.** Build them with the helpers in `src/garmin/dates.ts`, not from UTC timestamps.
- **Database migrations are append-only.** Add a new one in `src/store/db.ts`; don't edit released ones.
- **No `@garmin/fitsdk`.** Its license forbids redistribution, which the Docker image would do. FIT parsing uses `fit-file-parser` (MIT).
- **Tool output omits identity and location.** No owner name, profile images or account ID; GPS only when the caller asks for it.
- **New or renamed tool:** update the tool list in `src/mcp/server.test.ts` and the tools table in `README.md`.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), like the rest of the project.
