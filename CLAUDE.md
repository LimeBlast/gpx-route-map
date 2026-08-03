# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This tool produces monthly Instagram Reel videos of running, cycling, walking and swimming activities. The primary workflow is:

1. Drop last month's GPX/FIT files into `gpx/`
2. Run `npm run render:monthly` → writes `exports/monthly-YYYY-MM.mp4`

The basemap must exist first: `npm run build:routes && npm run build:basemap` (needs `brew install pmtiles`). Only needed again when activities appear in a new area.

## Commands

```sh
npm run render:monthly          # primary command — renders last month's reel
npm run dev                     # browser preview at localhost
npm run build:routes            # parse gpx/ → public/routes.json only
npm run build:basemap           # pull .pmtiles extracts for those routes → basemap/
npm run build:app               # vite build only (no route parsing)
npm run build                   # build:routes + build:app

MONTH=2026-04 npm run render:instagram   # target a specific month
npm run render:draft            # 15fps quick preview
```

Key env vars for `render:monthly` / `render:instagram`:

| Var | Default | Effect |
|---|---|---|
| `EXPORT_SPEED` | `2000` | Animation pace — higher is slower |
| `FINAL_HOLD_SECONDS` | `2` | Seconds of video held on final map |
| `END_HOLD_SECONDS` | `1.5` | Seconds of video held on stats card |
| `TRIM_METERS` | `0` | Trim route start/end for privacy |
| `CHROME_PATH` | `/Applications/Google Chrome.app/...` | Override Chrome location |

## Architecture

### Data flow

```
gpx/*.fit / *.gpx
    ↓ scripts/build-routes.mjs  (MONTH env var filters by calendar month)
public/routes.json
    ↓ vite build → dist/
    ↓ scripts/render-instagram.mjs  (headless Chrome + CDP)
exports/monthly-YYYY-MM.mp4
```

### scripts/build-routes.mjs

Pure Node.js. Reads all `.fit` and `.gpx` files from `gpx/`, classifies each as `run`, `ride` or `walk` (by filename, activity name, or FIT sport metadata), optionally filters to a single month (`MONTH=YYYY-MM`), trims start/end for privacy (`TRIM_METERS`), and writes `public/routes.json`. Contains a hand-rolled FIT binary parser — no external FIT library.

### src/main.js

Single-file vanilla JS app (no framework). Boots by fetching `routes.json`, then:

- Builds a 1km grid over all route coordinates in spherical Mercator metres (`projectMeters`), drawn as a single GeoJSON source restyled per frame
- Plays back routes one by one in `tick()` → `revealRoute()` loop driven by `setTimeout`
- On each reveal: pans camera (`focusPlaybackView`), waits for pan (`waitForCameraMove`), reveals grid cells, draws animated route trace via `requestAnimationFrame`
- Camera moves scale with distance (`moveToBounds`): under 60km is a quick 0.6s fit, a regional hop flies for 1.9s on a wider arc, and anything over 1000km flies for 3.6s with a forced apex at zoom 3.4 so an ocean crossing reads as one
- The page is always the 1080×1920 reel frame (scaled to fit smaller viewports); title/end cards are CSS overlays toggled by body classes (`export-started`, `export-ended`)
- Exposes `window.routeProgressApp` with `play()`, `pause()`, `reset()`, `showEndCard()`, `state()` for the render script to drive

Key timing constants (all in ms, all in `main.js` top-level scope):
- `panDurationSeconds` — short-hop camera duration; longer hops use `regionalPanMs` / `longHaulPanMs`
- `minimumTraceDurationMs` / `maximumTraceDurationMs` — route trace draw bounds
- `postTraceHoldMs` — hold after trace before next route
- `preRevealAfterPanMs` — pause between camera settling and route appearing
- `finalOverviewDelayMs` — wait after last route before final overview pan

### Map tiles

The basemap is Protomaps vector tiles read from local `.pmtiles` archives (`basemap/`, gitignored), rendered by MapLibre with the `grayscale` theme. `node scripts/fetch-basemap.mjs` clusters the routes in `routes.json` and pulls one extract per area, plus a coarse z0-5 whole-world layer underneath so zoomed-out views and the flights between areas show real land. `minZoom: 2` keeps the map filling the 1080×1920 frame — below that the world is narrower than the video.

Only visited grid cells are drawn; an unvisited grid showing through gave away where the routes were heading.

### Attribution

MapLibre's attribution control is hidden in the reel, so `.map-attribution` prints `Map data © OpenStreetMap contributors` into the frame itself, positioned above where Instagram's caption block lands. Protomaps basemaps are built from OpenStreetMap data, so the credit is required.

### Activity type detection

Three types are kept — `run`, `ride`, `walk` — matched against filename, activity name, and FIT sport metadata:

- `run` — `\b(run|running|jog|jogging)\b`
- `ride` — `\b(ride|riding|bike|biking|cycle|cycling|cyclist|bicycle)\b`
- `walk` — `\b(walk|walking|hike|hiking|ramble|rambling|trek|trekking)\b` (hikes are treated as walks)
- `swim` — `\b(swim|swimming)\b`

FIT sport enums map `1 → run`, `2 → ride`, `11`/`17 → walk`, `5 → swim`. Anything else is skipped. Override per-file via `activity-overrides.json` (copy from `activity-overrides.example.json`).

### Swims

Pool swims have no GPS, so they are built from FIT `session` (18) and `length` (101) messages instead of track points: total distance, elapsed time, stroke count, pool length, and a per-length list of `{ seconds, strokes }`. They are stored in `routes.json` with `type: "swim"` and a `swim` object, and no `coordinates`/`segments`.

A horizontal water meter (`#swim-meter`) sits under the stats bar for the whole reel, starting empty and filling toward the month's total swim distance as each swim plays, with a swimmer badge riding the leading edge. It sits above the swim card so it can be seen advancing.

During playback a swim takes over the frame (`#swim-card`) in date order rather than touching the map: one bar per length fills in proportion to how long each length actually took, with the metre count rising alongside. Swims contribute nothing to the square count or the map distance total — `landDistanceKm()` excludes them — and appear on the stats card in metres.

### Browser preview

`npm run dev` serves the same reel the renderer captures, scaled to fit the window, autoplaying (autoplay is gated on `import.meta.env.DEV`). Month label and title card text come from the loaded `routes.json` — no URL params needed. There are no interactive controls; the browser view exists only to see what the video will look like. Playback runs the full sequence including the final stats card — the renderer calls `showEndCard()` itself, so in dev a timer stands in for it.
