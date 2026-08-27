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

- **xterm.js terminal** with fit/resize, clipboard, web-links, search addons
- **WebSocket transport** — binary frames for terminal I/O, JSON for control
- **Login** (argon2, server-side sessions, CSRF-protected mutations, login rate-limiting)
- **Connection manager** — save SSH targets per user, organised by **group / tags / colour
  label** with search; credentials encrypted at rest with AES-256-GCM
- **Credential vault** — define a login profile (SSH auth + login automation) once and attach
  it to many connections; rotate a password in one place
- **Login automation** for network gear — after SSH connects, AnTerm answers the device's
  in-terminal `Username:` / `Password:` prompts, enters `enable` mode, runs setup commands
  (`terminal length 0` …), then permanently disengages so interactive apps are untouched
- **Colour labels** — mark a connection red/"production"; its tab and a banner above the
  terminal turn red so you know which box you're typing on
- **Import / export** the inventory as JSON or CSV (no secrets; credentials referenced by name)
- **Host key verification** — trust-on-first-use prompt in the UI; stored and checked on
  every later connection; loud warning if a key changes
- **Session recording & audit** — every session recorded to asciinema `.cast` (secrets
  masked), replayed in the browser with a scrubber, exportable as `.cast` / `.txt`; every
  typed command indexed into a searchable **command log**
- **Command snippets** — save commands, click-send them into a session from the terminal
- **Paste guard** — confirm before pasting multi-line text into a device
- **Anti-idle keepalive** — per-connection: send a null byte every N seconds of silence so
  the device doesn't drop the session
- **Light UI** with colour-coded status pills — **UP** / **DOWN** / connection state, test
  results, auth types — so state is readable at a glance
- **Keyword highlight** toggle in the terminal — colours `up` / `down` / `vlan N` / `trunk` /
  `err-disabled` … in plain output (skips interactive apps; off by default, remembered per browser)
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

In dev the login form is prefilled with `admin` / `changeme` for convenience
(never in a production build). Override with `VITE_DEV_USER` / `VITE_DEV_PASSWORD`
in `web/.env.local`.

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
| `--record` / `--no-record` | `ANTERM_RECORD` | `true` | Record session I/O + command log |
| `--record-dir` | `ANTERM_RECORD_DIR` | `<db dir>/recordings` | Where `.cast` files are stored |
| `--record-retention-days` | `ANTERM_RECORD_RETENTION_DAYS` | `30` | Delete recordings + old sessions after N days (0 = keep) |

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

### Login automation (network devices)

When editing a connection, open **Login automation**. After SSH transport auth, AnTerm
watches the first ~20 s of session output and:

1. sends **Login username** on a `Username:` / `login:` prompt,
2. sends **Login password** on the next `Password:` prompt,
3. if **Enter enable mode** is checked: sends `enable`, then the **Enable password**,
4. runs each **Setup command** (one per line, e.g. `terminal length 0`) once a prompt appears,
5. then **disengages permanently** — it never reads or writes the stream again, so `vim`,
   `less`, `tmux` and progress bars are unaffected.

Passwords are encrypted at rest and never sent to the browser. Leave the login fields blank
for hosts where SSH drops you straight into a shell (setup commands still run).

Test locally without real gear: `npx tsx server/test/dev-target.ts 2223 --device`
(SSH `svc`/`svc`, device login `netadmin`/`l0gin`, enable `en4ble`).

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
