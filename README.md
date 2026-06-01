# Monthly Activity Reel

A tool for producing monthly Instagram Reel videos of running and cycling activities. It converts GPX and FIT files into an animated route-progress map, then renders a portrait `.mp4` ready to post.

## Quick Start

```sh
npm install
```

Add last month's GPX/FIT files to `gpx/`, then:

```sh
npm run render:monthly
```

The video is written to `exports/monthly-YYYY-MM.mp4` with a title card reading e.g. "May 2026 · Running & Cycling".

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
3. **Final overview** — the camera flies to the densest activity area and holds
4. **Stats card** — month name as heading, with activity count, squares filled, and separate running and cycling distances

### Tuning the render

| Variable | Default | Effect |
|---|---|---|
| `EXPORT_SPEED` | `20800` | Animation pace — higher is slower |
| `FPS` | `30` | Output frame rate |
| `FINAL_HOLD_SECONDS` | `2` | How long to hold on the final map before the stats card |
| `END_HOLD_SECONDS` | `1.5` | How long to hold on the stats card |
| `WIDTH` / `HEIGHT` | `1080` / `1920` | Output dimensions |
| `OUTPUT` | `exports/monthly-YYYY-MM.mp4` | Output file path |
| `VIDEO_TITLE` | `Month YYYY · Running & Cycling` | Title card heading |
| `VIDEO_SUBTITLE` | `Every square unlocked, one activity at a time.` | Title card subheading |
| `VIDEO_KICKER` | Month name | Title card eyebrow label |

Example:

```sh
EXPORT_SPEED=15000 FINAL_HOLD_SECONDS=3 END_HOLD_SECONDS=2 npm run render:monthly
```

### Preset formats

```sh
npm run render:draft    # 15fps quick preview, saves to exports/draft-route-map.mp4
npm run render:feed     # 4:5 feed format (1080×1350)
npm run render:square   # square format (1080×1080)
```

### Custom Chrome path

```sh
CHROME_PATH="/path/to/chrome" npm run render:monthly
```

## How the Map Works

- The map starts as a grey basemap with a 1km grid over every square touched by the month's activities.
- Completed squares fill with colour as activities play back chronologically.
- Runs are green, rides are blue, and mixed squares are purple.
- Squares become more intense as more activities pass through them.
- The camera pans cinematically to each activity before its squares are revealed.
- After the camera settles, the current route trace draws across the map.
- After all routes, the camera flies to the densest cluster of activity and holds.
- The stats card fades in showing the month, total activities, squares filled, and separate run and cycling distances.

## Activity Types

The build script only includes activities classified as:

- `run` — filename or activity name contains words like `run` or `running`
- `ride` — filename or activity name contains words like `ride`, `bike`, or `cycling`

Anything else is skipped. For FIT files, the script also reads the FIT sport metadata when available.

If an activity is misclassified, copy `activity-overrides.example.json` to `activity-overrides.json` and map exact filenames to `run` or `ride`.

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

Open the local URL printed by Vite. Set your browser viewport to portrait (e.g. 1080×1920), enable Cinematic pan, and press Play.

## Building Routes Only

```sh
npm run build:routes                    # all activities in gpx/
MONTH=2026-05 npm run build:routes      # one month only
```
