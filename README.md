# revcut

Turn hand-picked videos and photos from any period (a month, several months, whatever) into a beat-synced, vertical 9:16, 20–25 second IG Reel. The AI drafts a first cut, you fine-tune it in the browser, and rendering only starts when you click Export.

> Status: spec under review ([docs/SPEC.md](docs/SPEC.md)). There is no code yet; the project commands below will be created in Phase 0.

## Features

- Upload videos, photos, and Live Photos. Capture time is read automatically, and HDR video is converted to SDR.
- AI (Anthropic or OpenAI) picks the best moments in each video and suggests where to crop for the vertical frame.
- Each clip is 0.5–2 seconds long, and every cut lands on a music beat.
- The bottom-left corner shows the capture date. Each clip's original sound plays quietly under the music.
- In the web editor you can swap clips, change lengths and in-points, drag to re-crop, and edit text. The preview matches the exported video.
- Everything runs locally. The only exception is AI analysis, which sends downscaled frames to the selected AI provider.

## Architecture

```
Browser (React + Remotion Player)
  └─ /api → Node server (Fastify + in-process job queue)
              ├ ffmpeg / exiftool / heic-decode: transcoding, metadata
              ├ Python analyzer: beat_this beat detection
              ├ Anthropic / OpenAI: frame analysis
              ├ planner: builds the timeline
              └ Remotion: renders the MP4
  Postgres (docker) + local disk (DATA_DIR)
```

See [docs/SPEC.md](docs/SPEC.md) for the full design.

## Layout

```
apps/web              frontend
apps/server           API + background jobs
packages/shared       timeline schema, timing math, validation rules, planner (shared by web and server)
packages/composition  Remotion video component (shared by preview and render)
analyzer/             Python CLI (beat detection)
fixtures/metadata/    sanitized exiftool / ffprobe JSON used by tests (committed)
fixtures/private/     your real media samples (gitignored)
docs/SPEC.md          spec
```

## Prerequisites

Development happens on WSL2 (Ubuntu).

| Tool | Version / source | Used for |
|---|---|---|
| Node.js | 24 LTS | frontend, server |
| pnpm | via corepack | package manager (monorepo) |
| Docker | Docker Desktop with WSL integration, or Docker Engine inside WSL | Postgres |
| ffmpeg | must include the `zscale` filter | transcoding, HDR→SDR, clip extraction |
| exiftool | `libimage-exiftool-perl` | capture time, GPS, Live Photo pairing ID |
| uv | astral.sh | Python environment for the analyzer |
| Chrome libraries | apt packages listed below | Headless Chrome that Remotion downloads for rendering |

Install on Ubuntu 22.04 / WSL (Ubuntu 22.04's `ffmpeg` 4.4.2 already includes `zscale`):

```bash
sudo apt update
sudo apt install -y ffmpeg libimage-exiftool-perl

# Libraries for Remotion's headless Chrome (on Ubuntu 24.04, use libasound2t64 instead of libasound2)
sudo apt install -y libnss3 libdbus-1-3 libatk1.0-0 libasound2 libxrandr2 libxkbcommon-dev \
	libxfixes3 libxcomposite1 libxdamage1 libgbm1 libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0

curl -LsSf https://astral.sh/uv/install.sh | sh

# Node 24 via nvm (or fnm)
nvm install 24 && nvm use 24
corepack enable                               # enables pnpm

# Make sure ffmpeg has zscale (needed for HDR → SDR)
ffmpeg -hide_banner -filters | grep zscale
```

## First-time setup

```bash
pnpm install
uv sync --project analyzer      # downloads CPU-only PyTorch on first run; takes a while
cp .env.example .env            # fill in API keys, see "Environment variables"
docker compose up -d            # start Postgres
pnpm db:migrate                 # create tables
pnpm dev                        # open http://localhost:5173
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Starts web (http://localhost:5173) and server (:3000) together |
| `pnpm test` | Runs all TypeScript tests (vitest) |
| `pnpm test:watch` | Watch mode |
| `pnpm --filter @revcut/shared test` | Runs tests for a single package |
| `pnpm typecheck` | Type-checks all packages |
| `pnpm db:generate` | Generates a migration after you change the Drizzle schema |
| `pnpm db:migrate` | Applies migrations |
| `uv run --project analyzer pytest` | Runs Python tests |
| `docker compose up -d` | Starts Postgres |
| `docker compose down` | Stops Postgres (data stays in the docker volume) |

### Debugging

```bash
curl -s localhost:3000/api/health | jq                          # check every dependency
docker compose exec db psql -U revcut revcut                    # open a DB shell
docker compose exec db pg_dump -U revcut revcut > backup.sql    # back up the DB (all your edits live here)

exiftool -G -n IMG_1234.MOV                                     # inspect media metadata
ffprobe -hide_banner IMG_1234.MOV                               # codec, frame rate, HDR or not

uv run --project analyzer python -m analyzer beats --input song.wav      # run beat detection alone
```

## Environment variables

`.env.example` has the full list. These are the ones you fill in yourself:

| Variable | Description |
|---|---|
| `AI_PROVIDER` | Default AI provider: `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | Anthropic API key, from the Claude Console (billed separately from a Claude subscription) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI API key and model |
| `DATA_DIR` | Where all media and renders are stored. Leave empty for `~/.revcut/data`. To change it, write an absolute path, because `.env` does not expand `~` |
| `HOST_DRIVE` | The Windows drive that holds the WSL virtual disk, default `/mnt/c`. Used to check real free space |

## Notes

- The first beat analysis downloads the beat_this model weights (about 80 MB) into `~/.cache/torch/hub/checkpoints/`.
- `DATA_DIR` must live inside the WSL filesystem. Putting it under `/mnt/c` or on the NAS makes disk access very slow.
- The server listens on `127.0.0.1` only and has no login. Don't expose it to the network.
- Inside WSL, `df` reports the virtual disk's maximum size, not the free space left on the Windows drive. The server checks both `DATA_DIR` and `HOST_DRIVE` and uses the smaller number.
- Disk space used by the WSL virtual disk isn't returned to Windows automatically. Delete finished projects from the web UI.
