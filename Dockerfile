# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled output only ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    GARMIN_MCP_DATA_DIR=/data \
    GARMIN_PERSONAL_API_KEY_FILE=/run/secrets/garmin_api_key
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

LABEL org.opencontainers.image.title="garmin-insights-mcp" \
      org.opencontainers.image.description="durely insights: MCP server for your own Garmin data (Garmin Connect Personal API)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="durely" \
      org.opencontainers.image.source="https://github.com/durely/garmin-insights-mcp" \
      io.modelcontextprotocol.server.name="app.durely/garmin-insights-mcp"

# stdio MCP server: run with `docker run -i` so the client can talk over stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
