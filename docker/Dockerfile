# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm AS build
WORKDIR /app

# Native deps: better-sqlite3 (usually prebuilt) and the optional node-pty.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .

# Build the SPA with the right base path, then the server (which copies web/dist in).
ARG ANTERM_BASE=/
ENV VITE_BASE=${ANTERM_BASE}
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    ANTERM_HOST=0.0.0.0 \
    ANTERM_PORT=3000 \
    ANTERM_DB_URL=/data/anterm.sqlite

RUN useradd --system --uid 10001 --home /app anterm \
  && mkdir /data && chown anterm:anterm /data

COPY --from=build --chown=anterm:anterm /app/node_modules ./node_modules
COPY --from=build --chown=anterm:anterm /app/server/dist ./server/dist
COPY --from=build --chown=anterm:anterm /app/package.json ./package.json

USER anterm
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ANTERM_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
