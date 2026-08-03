# Monthly Activity Reel

A tool for producing monthly Instagram Reel videos of running, cycling, walking and swimming. It converts GPX and FIT files into an animated route-progress map, then renders a portrait `.mp4` ready to post.

## Quick Start

```sh
npm install
brew install pmtiles     # once, for building the basemap
```

`ffmpeg` and Google Chrome are also required for rendering.

Add last month's GPX/FIT files to `gpx/`, then build the basemap for the areas you have been
active in (see [The Basemap](#the-basemap)) and render:

```sh
npm run build:routes
npm run build:basemap    # first run only, or when you move to a new area
npm run render:monthly
```

The video is written to `exports/monthly-YYYY-MM.mp4`, roughly 90 seconds long, with a title card reading "My Month in Fitness" above the month name.

## Add Your Activity Files

1. Export GPX or FIT files from Strava, Garmin, Komoot, Apple Health, or another tracker.
2. Put them in `gpx/`.
3. Name files with activity words when possible, for example:
   - `2024-01-12-run.gpx`
   - `2024-01-20-ride.fit`

The build script writes `public/routes.json`, sorted by each route's first track-point timestamp.

## Rendering a Monthly Reel

```sh
npm run render:monthly
```

This automatically targets the previous calendar month, so run it any time in the first few days of a new month. To target a specific month instead:

```sh
MONTH=2025-04 npm run render:instagram
```

### What the video contains

1. **Title card** — month name, subtitle, and a run/ride/mixed legend
2. **Route playback** — the camera pans to each activity, then its squares fill in with a route trace
3. **Swim cards** — pool swims have no GPS, so each one takes over the frame in date order, filling one bar per length. A water meter under the stats bar fills toward the month's total swim distance, with a swimmer crossing the screen as it goes
4. **Final overview** — the camera flies to the densest activity area and holds
5. **Stats card** — month name as heading, with activity count, squares filled, separate running, cycling, walking and swimming totals, and the places visited

### Tuning the render

| Variable | Default | Effect |
|---|---|---|
| `EXPORT_SPEED` | `2000` | Animation pace — higher is slower |
| `FPS` | `30` | Output frame rate. Capture rate is measured separately — frames are encoded at the speed they were actually captured, so the video runs in real time |
| `FINAL_HOLD_SECONDS` | `2` | How long to hold on the final map before the stats card |
| `END_HOLD_SECONDS` | `1.5` | How long to hold on the stats card |
| `OUTPUT` | `exports/monthly-YYYY-MM-<label>.mp4` | Output file path — the month comes from `MONTH`, or from the first activity in the built `routes.json` |
| `RENDER_LABEL` | none | Suffix on the output filename, e.g. `RENDER_LABEL=draft` gives `monthly-2026-07-draft.mp4` |
| `VIDEO_TITLE` | `My Month in Fitness` | Title card heading |
| `VIDEO_SUBTITLE` | `Every square unlocked, one activity at a time.` | Title card subheading |
| `VIDEO_KICKER` | Month name | Title card eyebrow label |

Example:

```sh
EXPORT_SPEED=15000 FINAL_HOLD_SECONDS=3 END_HOLD_SECONDS=2 npm run render:monthly
```

### Quick draft

```sh
npm run render:draft    # 15fps quick preview, saves to exports/draft-route-map.mp4
```

### Custom Chrome path

```sh
CHROME_PATH="/path/to/chrome" npm run render:monthly
```

## The Basemap

Maps are [Protomaps](https://protomaps.com/) vector tiles rendered by MapLibre, using the
`grayscale` theme. The tiles live in local `.pmtiles` archives under `basemap/`, so a render
makes no network requests at all and the map looks identical every time.

Building the basemap needs the pmtiles CLI once:

```sh
brew install pmtiles
npm run build:routes      # so the fetcher knows where you have been
npm run build:basemap     # extracts + label glyphs into basemap/
```

`build:basemap` groups your routes into areas of activity and pulls one extract per area
straight out of the Protomaps planet build over HTTP range requests — a 137GB file is never
downloaded. It also fetches a coarse whole-world layer so zoomed-out views and the flights
between areas show real land. A month spanning the UK and Canada came to about 200MB.

Re-run it when you start rendering activities from a new area. `basemap/` is gitignored.

Every render credits `Map data © OpenStreetMap contributors` in the frame itself — Protomaps
basemaps are built from OpenStreetMap data.

## How the Map Works

- The map starts as a grey basemap with a 1km grid over every square touched by the month's activities.
- Completed squares fill with colour as activities play back chronologically.
- Runs are green, rides are blue, walks are amber, and mixed squares are purple.
- Squares become more intense as more activities pass through them.
- The camera pans cinematically to each activity before its squares are revealed.
- After the camera settles, the current route trace draws across the map.
- After all routes, the camera flies to the densest cluster of activity and holds.
- The stats card fades in showing the month, total activities, squares filled, and separate run, cycling, walking and swimming totals.

## Activity Types

The build script only includes activities classified as:

- `run` — filename or activity name contains words like `run` or `running`
- `ride` — filename or activity name contains words like `ride`, `bike`, or `cycling`
- `walk` — filename or activity name contains words like `walk`, `hike`, or `trek` (hikes are treated as walks)
- `swim` — filename or activity name contains `swim` or `swimming`

Anything else is skipped. For FIT files, the script also reads the FIT sport metadata when available.

If an activity is misclassified, copy `activity-overrides.example.json` to `activity-overrides.json` and map exact filenames to `run`, `ride` or `walk`.

## Privacy Trimming

GPX and FIT files can reveal home, work, or other sensitive locations. To trim the start and end of every route before building:

```sh
TRIM_METERS=300 npm run render:monthly
```

## Browser Preview

To preview the map in a browser before rendering:

```sh
npm run dev
```

Open the local URL printed by Vite. The page renders exactly what the video will
show — a 1080×1920 reel frame, scaled to fit the window — and plays automatically
through to the final stats card.

## Building Routes Only

```sh
npm run build:routes                    # all activities in gpx/
MONTH=2026-05 npm run build:routes      # one month only
```
