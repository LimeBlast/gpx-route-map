# Route Progress Map

A small static web app for showing running and cycling progress from GPX and FIT files. It converts activity files into one `public/routes.json` file, then renders a grey Leaflet map where 1km squares fill with colour as activities complete them chronologically.

## Quick Start

```sh
npm install
npm run build:routes
npm run dev
```

Then open the local URL printed by Vite.

## Add Your Activity Files

1. Export GPX or FIT files from Strava, Garmin, Komoot, Apple Health, or another tracker.
2. Put them in `gpx/`.
3. Name files with activity words when possible, for example:
   - `2024-01-12-run.gpx`
   - `2024-01-20-ride.fit`
4. Run `npm run build:routes`.

The script writes `public/routes.json`, sorted by each route’s first track-point timestamp.

If route traces look like they jump across the map, rebuild the route data. The builder splits line drawing at large GPS gaps so the coloured squares can remain accurate without drawing misleading straight lines.

```sh
npm run build:routes
```

You can tune the split threshold if your device records sparse points:

```sh
MAX_LINE_GAP_METERS=5000 npm run build:routes
```

## How the Map Works

- The map starts as a grey basemap with a 1km grid over every square touched by your files.
- As you move the timeline or press play, completed squares fill with activity colour.
- Runs are green, rides are blue, and mixed run/ride squares are purple.
- Squares become more intense as more activities pass through them.
- The current route trace draws over time in a darker colour, following the activity path after the camera pan.
- Cinematic pan mode moves and zooms the camera to each upcoming activity before its squares are revealed.
- If the next activity is already in view, playback reveals it immediately instead of waiting for a camera move.
- Playback waits for the current route trace to finish before moving the camera to the next activity.
- Playback starts from an empty completed map, then pans/zooms to the first activity before revealing it.
- At the end, playback frames the densest completed activity area rather than zooming out to every outlier.

## Instagram Video Export

Render a portrait `.mp4` for Instagram Stories/Reels with:

```sh
npm run render:instagram
```

The renderer:

- rebuilds `public/routes.json` and the Vite app
- opens the export view in headless Google Chrome at `1080 × 1920`
- records PNG frames while the cinematic playback runs
- converts those frames to `exports/instagram-route-map.mp4` using `ffmpeg`
- includes a small stats box at the bottom with squares, distance, and date

Optional settings:

```sh
OUTPUT=exports/my-video.mp4 FPS=30 END_HOLD_SECONDS=3 EXPORT_SPEED=6500 MAX_RENDER_MINUTES=90 npm run render:instagram
```

Higher `EXPORT_SPEED` values make the animation slower. The default export speed is `5200`.
The default render timeout is `60` minutes.

If Chrome is somewhere else:

```sh
CHROME_PATH="/path/to/chrome" npm run render:instagram
```

For a manual screen-recorded Instagram Story/Reel export:

1. Run `npm run dev`.
2. Open the app in a browser.
3. Use your browser’s responsive/device toolbar and set the viewport to a vertical size, such as `1080 × 1920`.
4. Turn on `Cinematic pan while playing`.
5. Start a screen recording.
6. Press `Reset`, then `Play`.
7. Stop recording when the timeline finishes, then trim the beginning/end in your video editor.

## Privacy Trimming

GPX and FIT files can reveal home, work, or other sensitive locations. To remove the start and end of every route before generating the public data file:

```sh
TRIM_METERS=300 npm run build:routes
```

That trims roughly the first and last 300 meters from each activity.

## Activity Types

The build script only includes activities classified as:

- `run` when the filename or activity name contains words like `run` or `running`
- `ride` when it contains words like `ride`, `bike`, or `cycling`

Anything else is skipped. For FIT files, the script also reads the FIT sport metadata when available.

If an activity is misclassified, copy `activity-overrides.example.json` to `activity-overrides.json` and map exact filenames to `run` or `ride`.

## Deploy

This app can be deployed as a static site:

```sh
npm run build
```

Upload the generated `dist/` folder to Netlify, Vercel, GitHub Pages, Railway, or any static host.
