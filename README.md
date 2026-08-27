# AnTerm

A web app for SSH in the browser — a terminal (xterm.js) talks over a WebSocket to a
Node server that opens the SSH session for you. Inspired by
[WeTTY](https://github.com/butlerx/wetty), with two additions on top of the WeTTY-style
core: **username/password login** and a **per-user connection manager** backed by a database.

```
Browser (React + xterm.js)  ──HTTPS  /api/*──▶  REST: auth, connections, history
                            ──WSS /ws/terminal▶  control JSON + binary terminal bytes
                                                    │
                                          Node / Fastify server
                                          ├─ ssh2  → remote SSH host
                                          └─ node-pty (optional) → local shell
```

## Features

- **xterm.js terminal** with fit/resize, WebGL renderer, clipboard, web-links, search addons
- **WebSocket transport** — binary frames for terminal I/O, JSON for control
- **Login** (argon2, server-side sessions, CSRF-protected mutations, login rate-limiting)
- **Connection manager** — save SSH targets per user; credentials (passwords / private keys)
  are encrypted at rest with AES-256-GCM
- **Host key verification** — trust-on-first-use prompt in the UI; stored and checked on
  every later connection; loud warning if a key changes
- **Session history** — every SSH session is audit-logged (who, where, when, bytes, reason)
- **Multiple terminal tabs**, bounded auto-reconnect on transient network drops
- **WeTTY-compatible** CLI flags / env / config file, `--base` for reverse-proxy sub-paths,
  ad-hoc SSH mode (`--ssh-host`), and an optional local shell
- **Docker** image + compose files (plain and Traefik/Let's Encrypt)

## Quick start (development)

```bash
npm install
cp .env.example .env          # then edit ANTERM_APP_SECRET / ADMIN_PASSWORD
npm run dev                    # server on :3000, Vite dev server on :5173
```

Open http://localhost:5173 and sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.

The Vite dev server proxies `/api` and `/ws` to the backend, so you only need the one URL.

## Production

```bash
npm run build                 # builds web/dist, then server/dist (SPA copied in)
ANTERM_APP_SECRET=... ADMIN_USER=admin ADMIN_PASSWORD=... node server/dist/index.js
```

The server then serves the SPA and the API/WS from the same origin on `ANTERM_PORT` (3000).
**Run it behind a reverse proxy that terminates TLS**, or pass `--ssl-key` / `--ssl-cert`.

### Docker

```bash
cd docker
echo "ANTERM_APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env
echo "ADMIN_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")" >> .env
docker compose up --build            # http://localhost:3000
```

For public deployment use `docker-compose.traefik.yml` (set `ANTERM_DOMAIN` and `ACME_EMAIL`).

## Configuration

Precedence: **CLI flag > `ANTERM_*` env var > `--conf` file > default**. Run `anterm --help`
for the full list. Common options:

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--app-secret` | `ANTERM_APP_SECRET` | — (required) | Encrypts stored credentials, signs cookies |
| `--port` / `--host` | `ANTERM_PORT` / `ANTERM_HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `--base` | `ANTERM_BASE` | `/` | Base path for sub-path hosting (build web with `VITE_BASE`) |
| `--db-url` | `ANTERM_DB_URL` | `./data/anterm.sqlite` | SQLite file (swap driver for Postgres later) |
| `--admin-user` / `--admin-password` | `ADMIN_USER` / `ADMIN_PASSWORD` | — | Creates the first admin **only when no users exist** |
| `--ssl-key` / `--ssl-cert` | `ANTERM_SSL_KEY` / `ANTERM_SSL_CERT` | — | Serve HTTPS directly |
| `--allow-hosts` | `ANTERM_ALLOW_HOSTS` | (any) | Comma-separated SSH target allowlist |
| `--ssh-idle-timeout-min` | `ANTERM_SSH_IDLE_TIMEOUT_MIN` | `0` (off) | Close idle SSH sessions |
| `--ssh-max-duration-min` | `ANTERM_SSH_MAX_DURATION_MIN` | `0` (off) | Hard cap on session length |
| `--session-ttl-hours` | `ANTERM_SESSION_TTL_HOURS` | `12` | Login session lifetime |
| `--allow-iframe` | `ANTERM_ALLOW_IFRAME` | `false` | Allow embedding in an iframe |

### WeTTY-style ad-hoc mode

Set `--ssh-host` to enable connecting without a saved DB connection (login still required):

```bash
anterm --ssh-host 10.0.0.5 --ssh-user ubuntu          # ad-hoc SSH; UI shows "Quick connect"
anterm --ssh-host localhost                           # local login shell (needs node-pty)
anterm --ssh-host localhost --force-ssh               # SSH to localhost instead
```

`--ssh-port`, `--ssh-command` (run a command instead of a shell), and `--conf <file.yaml>`
are also supported.

### Config file example (`--conf anterm.yaml`)

```yaml
port: 3000
base: /term
appSecret: ${ANTERM_APP_SECRET}   # env interpolation is NOT done — put the real value or use the env var
sshIdleTimeoutMin: 30
allowHosts:
  - 10.0.0.5
  - db.internal
ssh:
  command: /usr/bin/tmux new -A -s web
```

## Security notes

- **A browser SSH gateway is sensitive.** Always serve over TLS and restrict network exposure
  (VPN / private network / IP allowlist at the proxy).
- Stored SSH credentials are encrypted with a key derived from `ANTERM_APP_SECRET`.
  **If that secret is lost, stored credentials cannot be decrypted.** Back it up.
- Host keys are trust-on-first-use and stored per `host:port`. A changed key blocks the
  connection until a user explicitly accepts the new one.
- Change the bootstrap admin password on first login (Settings → Change password); doing so
  invalidates all other sessions for that account.

## Development

```bash
npm run dev              # server + web with hot reload
npm test                 # server unit + integration + WS e2e (vitest)
npm run build            # production build
npm -w server run db:generate   # author a new Drizzle migration after editing schema.ts
```

Tests spin up an in-process SSH server (`server/test/sshFixture.ts`) — no Docker or system
sshd needed. Runtime DB migrations live in `server/src/db/migrate.ts` and run on boot.

### Layout

```
server/   Fastify API + WebSocket terminal bridge + ssh2 / node-pty backends + Drizzle/SQLite
web/      React + Vite SPA (login, connections, terminal tabs, history, settings)
docker/   Dockerfile + compose files
```

## License

MIT
