# twitter-archive-viewer

English | [日本語](README.ja.md)

A self-hosted viewer for the official Twitter/X data archive (the ZIP you get from Settings → Download an archive). Browse and search your tweets, likes and DMs on your own server, from your phone or PC.

- Zero runtime npm dependencies. Node.js >= 22.18 (the Docker image uses `node:24-bookworm-slim`); TypeScript runs through Node's type stripping.
- SQLite via `node:sqlite` with FTS5 trigram full-text search. Partial matching works for Japanese/CJK text; queries of 1-2 characters fall back to `LIKE`.
- Vanilla TypeScript single-page app (hash routing), mobile-friendly, light/dark theme.

Your archive (especially DMs) is sensitive. All data stays on your own host, and the app has **no built-in authentication**. See [Exposing it safely](#exposing-it-safely).

## Features

- Timeline with infinite scroll
- Full-text search with highlighting
- Filters: type (original / reply / retweet), media only, date range, month jump, sort order, removed tweets
- Tweet detail with reply context, image lightbox, video playback (HTTP Range)
- Likes, and DMs (1:1 and group)
- Admin screen (`#/admin`): pick a ZIP placed in the archive folder, import it with progress display, view import history, reset the DB
- Merge-style imports that keep history (see [Importing and updating archives](#importing-and-updating-archives))

## Quick start (Docker)

Requirements: Docker with Compose, and the archive ZIP from X.

```sh
git clone https://github.com/yykuso/twitter-archive-viewer.git
cd twitter-archive-viewer
cp .env.example .env            # adjust if needed
mkdir -p data/archive data/db data/media
cp /path/to/twitter-archive-*.zip data/archive/
docker compose up -d --build
```

Then open `http://<host>:8080/#/admin`, select the ZIP and start the import. When it finishes, the timeline is available at `http://<host>:8080/`.

Create the `archive/`, `db/` and `media/` folders under `DATA_DIR` yourself before starting. On a Synology NAS (Container Manager) and some other hosts, bind-mount folders are not created automatically.

To also start the Cloudflare Tunnel connector, use the `tunnel` profile (see below):

```sh
docker compose --profile tunnel up -d --build
```

## Configuration

Set these in `.env` (see `.env.example`) or the environment.

| Variable | Default | Description |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Host folder holding `archive/` (ZIPs, mounted read-only), `db/` (SQLite) and `media/` (extracted images/videos) |
| `VIEWER_PORT` | `8080` | Host port that publishes the viewer. It has no authentication: keep it LAN-only |
| `TIMEZONE` | `UTC` | IANA time zone used for date display, date filters and the monthly calendar |
| `TUNNEL_TOKEN` | - | Cloudflare Tunnel token. Only needed with `--profile tunnel` |

Inside the container the server also reads `DB_PATH`, `MEDIA_ROOT`, `ARCHIVE_DIR`, `PORT` and `WEB_ROOT`. Their defaults point under `/data` and `/app`, so you normally do not change them.

## Importing and updating archives

Each X archive is a snapshot of your account at download time. Imports **merge** snapshots into one database:

- Each row records the first and last archive it appeared in.
- Tweets, likes and DMs that are missing from the newest imported archive are **kept** and flagged as removed, with the date they disappeared.
- Newer archives overwrite counts and text.
- Archives can be imported in any order, and re-importing the same ZIP is idempotent.
- The import builds a temporary copy of the DB and swaps it in atomically, so browsing keeps working while it runs.
- Media is extracted with `unzip -n`, so existing files are never overwritten.

As a rough guide, about 160k tweets import in around 10 seconds with about 1 GB of peak RAM. Extracting ~15 GB of media takes longer.

To update, copy the new ZIP into `DATA_DIR/archive/` and import it from `#/admin`.

CLI alternative (do not run it while the server is importing):

```sh
docker compose run --rm viewer import [zip] [--skip-media]
```

## Exposing it safely

The viewer has no login. Do not publish it to the internet directly. A reference setup is Cloudflare Tunnel plus Cloudflare Access, which needs no inbound ports on your router. The details of the Cloudflare dashboard change over time, so this is only an outline:

1. Put your domain's DNS on Cloudflare.
2. In Zero Trust, create a remotely-managed Tunnel and copy its token into `TUNNEL_TOKEN` in `.env`.
3. Add a Public Hostname such as `viewer.example.com` pointing to `http://viewer:8080`.
4. Create a self-hosted Access application for `viewer.example.com` (team domain `<your-team>.cloudflareaccess.com`) with a policy that allows only your own email.
5. Start with `docker compose --profile tunnel up -d --build`.
   On hosts where you cannot pass `--profile` (e.g. Synology Container Manager), set `COMPOSE_PROFILES=tunnel` in `.env` instead.

Cloudflare's free plan limits request bodies to 100 MB, which is why ZIPs are not uploaded through the browser: place them in `DATA_DIR/archive/` and pick them in the admin screen.

The directly published `VIEWER_PORT` bypasses Access. Keep it on your LAN (or bind it to localhost) and never forward it from your router.

## Development

Requires Node.js >= 22.18 and `unzip`.

```sh
npm install                      # dev dependencies only (typescript, @types/node)
npm run build:web
DB_PATH=./data/db/tweets.sqlite MEDIA_ROOT=./data/media ARCHIVE_DIR=./data/archive npm start
npm run typecheck
```

Layout:

- `src/import/` - ZIP parsing and merge
- `src/server/` - HTTP, API, media serving, admin job runner
- `src/db/` - schema, opening, atomic swap
- `src/shared/types.ts` - API contract shared with the web app
- `web/` - single-page app
- `docs/architecture/` - architecture docs

## Architecture

See [docs/architecture/twitter-archive-viewer/spec.md](docs/architecture/twitter-archive-viewer/spec.md) (Japanese) and the accompanying `diagram.drawio`.

## License

[MIT](LICENSE)

## Disclaimer

This is an unofficial tool and is not affiliated with, endorsed by, or sponsored by X Corp. "Twitter" and "X" are trademarks of their respective owners.
