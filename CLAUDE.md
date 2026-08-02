# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This tool produces monthly Instagram Reel videos of running and cycling activities. The primary workflow is:

1. Drop last month's GPX/FIT files into `gpx/`
2. Run `npm run render:monthly` → writes `exports/monthly-YYYY-MM.mp4`

## Commands

```sh
npm run render:monthly          # primary command — renders last month's reel
npm run dev                     # browser preview at localhost
npm run build:routes            # parse gpx/ → public/routes.json only
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

- Builds a 1km grid of `L.rectangle` cells over all route coordinates using Leaflet's Mercator projection
- Plays back routes one by one in `tick()` → `revealRoute()` loop driven by `setTimeout`
- On each reveal: pans camera (`focusPlaybackView`), waits for pan (`waitForCameraMove`), reveals grid cells, draws animated route trace via `requestAnimationFrame`
- The page is always the 1080×1920 reel frame (scaled to fit smaller viewports); title/end cards are CSS overlays toggled by body classes (`export-started`, `export-ended`)
- Exposes `window.routeProgressApp` with `play()`, `pause()`, `reset()`, `showEndCard()`, `state()` for the render script to drive

Key timing constants (all in ms, all in `main.js` top-level scope):
- `panDurationSeconds` — Leaflet flyToBounds duration
- `minimumTraceDurationMs` / `maximumTraceDurationMs` — route trace draw bounds
- `postTraceHoldMs` — hold after trace before next route
- `preRevealAfterPanMs` — pause between camera settling and route appearing
- `finalOverviewDelayMs` — wait after last route before final overview pan

### scripts/render-instagram.mjs

Node.js script. Builds the app, starts a local static server for `dist/`, launches headless Chrome via spawn, connects via CDP WebSocket (`createCdpClient`), navigates to the export URL, calls `routeProgressApp.play()`, then captures frames using `Page.startScreencast` (JPEG, ~24fps). 

Frame capture loop: receives `Page.screencastFrame` events, writes `.jpg` files, sends `Page.screencastFrameAck` for backpressure. Once `routeProgressApp.state()` reports `isComplete && !isPlaying`, switches to Node.js timers (not frame counts) for the hold and end card — Chrome stops sending screencast frames when the page is visually static, so timers are required here. After capture, encodes frames to H.264 mp4 with ffmpeg at `fps` input framerate.

### Activity type detection

Three types are kept — `run`, `ride`, `walk` — matched against filename, activity name, and FIT sport metadata:

- `run` — `\b(run|running|jog|jogging)\b`
- `ride` — `\b(ride|riding|bike|biking|cycle|cycling|cyclist|bicycle)\b`
- `walk` — `\b(walk|walking|hike|hiking|ramble|rambling|trek|trekking)\b` (hikes are treated as walks)

FIT sport enums map `1 → run`, `2 → ride`, `11`/`17 → walk`. Anything else is skipped. Override per-file via `activity-overrides.json` (copy from `activity-overrides.example.json`).

### Browser preview

`npm run dev` serves the same reel the renderer captures, scaled to fit the window, autoplaying (autoplay is gated on `import.meta.env.DEV`). Month label and title card text come from the loaded `routes.json` — no URL params needed. There are no interactive controls; the browser view exists only to see what the video will look like.
