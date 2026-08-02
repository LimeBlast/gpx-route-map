import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

function lastMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const month = process.env.MONTH || (process.env.MONTHLY === "1" ? lastMonth() : "");

function monthLabel(m) {
  if (!m) return null;
  const [year, monthNum] = m.split("-").map(Number);
  return new Date(year, monthNum - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
}

const monthDisplay = monthLabel(month);
const fps = Number(process.env.FPS || 30);
const width = 1080;
const height = 1920;
const endHoldSeconds = Number(process.env.END_HOLD_SECONDS || 1.5);
const frameLimit = Number(process.env.FRAME_LIMIT || 0);
const progressIntervalMs = Number(process.env.PROGRESS_INTERVAL_MS || 2000);
const exportSpeed = Number(process.env.EXPORT_SPEED || 2000);
const finalOverviewHoldFrames = fps * Number(process.env.FINAL_HOLD_SECONDS || 2);
const endHoldFrames = fps * endHoldSeconds;
const maxRenderMinutes = Number(process.env.MAX_RENDER_MINUTES || 60);
const cdpCommandTimeoutMs = Number(process.env.CDP_COMMAND_TIMEOUT_MS || 20_000);
const exportParams = new URLSearchParams({
  speed: String(exportSpeed),
  // No VIDEO_TITLE: the app falls back to its own default heading
  ...(process.env.VIDEO_TITLE ? { title: process.env.VIDEO_TITLE } : {}),
  subtitle: process.env.VIDEO_SUBTITLE || "Every square unlocked, one activity at a time.",
  kicker: process.env.VIDEO_KICKER || (monthDisplay || "Route Progress"),
  endTitle: process.env.VIDEO_END_TITLE || monthDisplay || "Progress unlocked",
  titleMs: process.env.TITLE_MS || "2800"
});
const tileCacheDir = path.join(rootDir, ".tile-cache");
const tileUserAgent = "gpx-route-map/1.0 (personal monthly activity reel; https://github.com/limeblast)";
const tileFetchConcurrency = 4; // polite against OSM's usage policy
const tileWarmMargin = 1; // one ring past the settled view covers Leaflet's edges
const minWarmZoom = 2; // a transatlantic flight zooms out this far
const gridCellDegrees = 0.02; // ~1km grid cell, plus slack for the camera padding
const clusterJoinDegrees = 0.35; // routes within ~35km count as one area
const overviewZoomCap = 12; // matches showFinalOverview
const maxWarmZoom = 14; // matches the app's camera cap
let tileCacheHits = 0;
let tileCacheMisses = 0;
let tilesPrewarmed = 0;
const warmedTileKeys = new Set();
const chromeDebugPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

await run("npm", ["run", "build:routes"], month ? { MONTH: month } : {});
await run("npm", ["run", "build:app"]);

// Without MONTH the filename comes from the data itself, so an unfiltered
// render of one month's files still lands on monthly-YYYY-MM.mp4.
// RENDER_LABEL suffixes the name so alternative basemaps can be rendered
// side by side without overwriting each other.
const renderLabel = process.env.RENDER_LABEL ?? "protomaps";
const outputPath = path.resolve(
  process.env.OUTPUT ||
    path.join(
      rootDir,
      "exports",
      `monthly-${month || (await renderedMonth())}${renderLabel ? `-${renderLabel}` : ""}.mp4`
    )
);
await mkdir(path.dirname(outputPath), { recursive: true });
await warmTileCache();

const frameDir = await mkdtemp(path.join(tmpdir(), "route-progress-frames-"));
const server = await startStaticServer(distDir);
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--force-device-scale-factor=1",
  `--window-size=${width},${height}`,
  `--remote-debugging-port=${chromeDebugPort}`,
  "about:blank"
]);

try {
  const client = await connectToChrome();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: width,
    screenHeight: height
  });

  exportParams.set("tiles", `${server.url}/tiles/{z}/{x}/{y}.png`);
  await client.send("Page.navigate", { url: `${server.url}/?${exportParams}` });
  await client.waitFor("Page.loadEventFired");
  await evaluate(client, "new Promise((resolve) => window.routeProgressApp ? resolve() : window.addEventListener('route-progress-ready', resolve, { once: true }))");
  await evaluate(client, "window.routeProgressApp.reset()");
  await sleep(700);

  let frame = 0;
  let finishedAt = null;
  let finishedAtFrame = null;
  let lastRouteIndex = -1;
  let currentStep = "starting";
  const startedAt = Date.now();
  const logProgress = () => {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    console.log(
      `Still capturing... ${frame} frames in ${elapsedSeconds.toFixed(0)}s · route ${Math.max(
        lastRouteIndex + 1,
        0
      )}/${windowRouteCount} · ${currentStep}`
    );
  };
  let windowRouteCount = "?";

  console.log(`Capturing ${width}×${height} frames at ${fps} fps...`);
  await evaluate(client, "window.routeProgressApp.play()");
  const heartbeat = setInterval(logProgress, progressIntervalMs);

  await client.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });

  await new Promise((resolve, reject) => {
    let done = false;
    let completionTriggered = false;
    let statePoller; // hoisted so finish() can always clearInterval safely
    const holdMs = Math.round((finalOverviewHoldFrames / fps) * 1000);
    const endCardMs = Math.round((endHoldFrames / fps) * 1000);

    const finish = async () => {
      if (done) return;
      done = true;
      clearInterval(statePoller);
      await client.send("Page.stopScreencast").catch(() => {});
      unsubscribe();
      resolve();
    };

    const handleCompletion = (atFrame) => {
      if (completionTriggered) return;
      completionTriggered = true;
      finishedAt = Date.now();
      finishedAtFrame = atFrame;
      console.log(`→ animation complete at frame ${atFrame} (${((finishedAt - startedAt) / 1000).toFixed(1)}s), hold ${holdMs}ms then end card for ${endCardMs}ms`);

      // Use timers rather than frame counts — Chrome stops sending frames
      // when the page is static, so we can't rely on frame events arriving.
      setTimeout(async () => {
        if (done) return;
        console.log(`→ showing end card`);
        await evaluate(client, "window.routeProgressApp.showEndCard()").catch(() => {});
        // CSS fade-in triggers new frames; stop after end card hold
        setTimeout(finish, endCardMs);
      }, holdMs);
    };

    // Poll app state independently of frame events — Chrome stops sending
    // screencast frames when the page is visually static, so we can't rely
    // solely on the frame handler to detect completion.
    statePoller = setInterval(async () => {
      if (done || finishedAt != null) return;
      try {
        const appState = await evaluate(client, "window.routeProgressApp.state()");
        lastRouteIndex = appState.index;
        windowRouteCount = appState.routeCount;
        if (appState.isComplete && !appState.isPlaying) {
          handleCompletion(frame);
        }
      } catch {
        // ignore — page may be mid-navigation
      }
    }, 1000);

    const unsubscribe = client.on("Page.screencastFrame", async (params) => {
      try {
        frame += 1;
        currentStep = "writing frame";
        await writeFile(path.join(frameDir, `frame-${String(frame).padStart(6, "0")}.jpg`), params.data, "base64");
        await client.send("Page.screencastFrameAck", { sessionId: params.sessionId });

        if (frameLimit > 0 && frame >= frameLimit) return finish();

        if (Date.now() - startedAt > maxRenderMinutes * 60 * 1000) {
          done = true;
          clearInterval(statePoller);
          clearInterval(heartbeat);
          await client.send("Page.stopScreencast").catch(() => {});
          unsubscribe();
          return reject(new Error(`Timed out after ${maxRenderMinutes} minutes while rendering video`));
        }

        if (finishedAt == null && frame % 10 === 0) {
          currentStep = "reading app state";
          const appState = await evaluate(client, "window.routeProgressApp.state()");
          lastRouteIndex = appState.index;
          windowRouteCount = appState.routeCount;

          if (appState.isComplete && !appState.isPlaying) {
            handleCompletion(frame);
          }
        }
      } catch (error) {
        done = true;
        clearInterval(statePoller);
        await client.send("Page.stopScreencast").catch(() => {});
        unsubscribe();
        reject(error);
      }
    });
  });

  clearInterval(heartbeat);
  console.log(`Encoding ${frame} frames with ffmpeg...`);
  await run("ffmpeg", [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(frameDir, "frame-%06d.jpg"),
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    outputPath
  ]);

  console.log(`Rendered ${frame} frames to ${outputPath}`);
  console.log(
    `Tiles: ${tileCacheHits} served from cache, ${tileCacheMisses} fetched during capture` +
      ` (${tilesPrewarmed} pre-fetched before capture)`
  );
} finally {
  chrome.kill("SIGTERM");
  server.close();
  await rm(frameDir, { recursive: true, force: true });
}

async function renderedMonth() {
  try {
    const { routes } = JSON.parse(await readFile(path.join(rootDir, "public", "routes.json"), "utf8"));
    return routes[0].date.slice(0, 7);
  } catch {
    return lastMonth();
  }
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...env }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function startStaticServer(directory) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/tiles/")) {
      await serveTile(url.pathname, response);
      return;
    }

    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.join(directory, requestedPath);

    if (!filePath.startsWith(directory)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    createReadStream(filePath)
      .on("error", () => {
        response.writeHead(404);
        response.end("Not found");
      })
      .on("open", () => {
        response.setHeader("Content-Type", contentType(filePath));
      })
      .pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        close: () => server.close(),
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

// Pull every tile the reel will need before capture starts, so no frame ever
// waits on the network and pacing is identical cold or warm.
async function warmTileCache() {
  const { routes } = JSON.parse(await readFile(path.join(rootDir, "public", "routes.json"), "utf8"));
  const located = routes.filter((route) => route.coordinates?.length > 1);

  if (located.length === 0) return;

  const wanted = warmedTileKeys;

  const add = (bounds, zoom) => {
    for (const tile of tilesCovering(bounds, zoom)) {
      wanted.add(`${tile.z}/${tile.x}/${tile.y}`);
    }
  };

  for (const route of located) {
    // The app frames the 1km grid cells a route touches, not the track itself
    const bounds = padBounds(coordinateBounds(route.coordinates), gridCellDegrees);
    const zoom = fitZoom(bounds);

    // Only the settled view is warmed. Tiles that stream in mid-flight are
    // transient and moving; warming every intermediate zoom multiplied the
    // number of tiles pulled from OSM several times over for little gain.
    add(bounds, zoom);
  }

  // flyToBounds between distant routes (UK to Canada) pulls the camera right
  // out, so warm the whole-world view — cheap, only a handful of tiles
  const routeBounds = located.map((route) => coordinateBounds(route.coordinates));
  const allBounds = mergeBounds(routeBounds);

  for (let z = minWarmZoom; z <= fitZoom(allBounds) + 2; z += 1) {
    add(allBounds, z);
  }

  // The opening view and the closing overview frame a whole area of activity.
  // Warming those per cluster avoids pulling a mid-zoom band across the ocean.
  for (const cluster of clusterBounds(routeBounds)) {
    const zoom = Math.min(fitZoom(cluster), overviewZoomCap);

    // Down a few levels too: that band is what the camera flies through on its
    // way into an area, and each step down costs a quarter of the tiles
    for (let z = Math.max(zoom - 3, minWarmZoom); z <= zoom; z += 1) {
      add(cluster, z);
    }
  }

  const missing = [];
  for (const key of wanted) {
    const [z, x, y] = key.split("/");
    try {
      await stat(path.join(tileCacheDir, z, x, `${y}.png`));
    } catch {
      missing.push({ z, x, y });
    }
  }

  if (missing.length === 0) {
    console.log(`Tile cache warm: all ${wanted.size} tiles already on disk`);
    return;
  }

  console.log(`Warming tile cache: ${missing.length} of ${wanted.size} tiles to fetch...`);
  let done = 0;
  const workers = Array.from({ length: tileFetchConcurrency }, async () => {
    for (let tile = missing.pop(); tile; tile = missing.pop()) {
      await fetchTile(tile.z, tile.x, tile.y).catch(() => {});
      done += 1;

      if (done % 100 === 0) console.log(`  ...${done} tiles`);
    }
  });

  await Promise.all(workers);
  tilesPrewarmed = done;
  console.log(`Tile cache warm: ${done} tiles fetched, ${wanted.size} total`);
}

// Looped rather than Math.min(...coords) — a month of track points overflows
// the call stack when spread
function mergeBounds(list) {
  return list.reduce((merged, bounds) => ({
    west: Math.min(merged.west, bounds.west),
    east: Math.max(merged.east, bounds.east),
    south: Math.min(merged.south, bounds.south),
    north: Math.max(merged.north, bounds.north)
  }));
}

function boundsOverlap(left, right) {
  return (
    left.west <= right.east &&
    right.west <= left.east &&
    left.south <= right.north &&
    right.south <= left.north
  );
}

// Merge routes into areas of activity — a month in one city collapses to one
// cluster, a month either side of an ocean stays two
function clusterBounds(routeBounds) {
  const clusters = [];

  for (const bounds of routeBounds) {
    const padded = padBounds(bounds, clusterJoinDegrees);
    const overlapping = clusters.filter((cluster) => boundsOverlap(cluster, padded));

    for (const cluster of overlapping) {
      clusters.splice(clusters.indexOf(cluster), 1);
    }

    clusters.push(mergeBounds([padded, ...overlapping]));
  }

  return clusters;
}

function padBounds(bounds, degrees) {
  return {
    west: bounds.west - degrees,
    east: bounds.east + degrees,
    south: bounds.south - degrees,
    north: bounds.north + degrees
  };
}

function coordinateBounds(coordinates) {
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };

  for (const [longitude, latitude] of coordinates) {
    if (longitude < bounds.west) bounds.west = longitude;
    if (longitude > bounds.east) bounds.east = longitude;
    if (latitude < bounds.south) bounds.south = latitude;
    if (latitude > bounds.north) bounds.north = latitude;
  }

  return bounds;
}

// Mirrors Leaflet's getBoundsZoom for the app's export padding, capped like
// moveToBounds does
function fitZoom(bounds) {
  const availableWidth = width - 72;
  const availableHeight = height - 330;

  for (let zoom = maxWarmZoom; zoom > minWarmZoom; zoom -= 1) {
    const worldSize = 256 * 2 ** zoom;
    const spanX = (mercatorX(bounds.east) - mercatorX(bounds.west)) * worldSize;
    const spanY = (mercatorY(bounds.south) - mercatorY(bounds.north)) * worldSize;

    if (spanX <= availableWidth && spanY <= availableHeight) return zoom;
  }

  return minWarmZoom;
}

function tilesCovering(bounds, zoom) {
  const scale = 2 ** zoom;
  const left = Math.floor(mercatorX(bounds.west) * scale) - tileWarmMargin;
  const right = Math.floor(mercatorX(bounds.east) * scale) + tileWarmMargin;
  const top = Math.floor(mercatorY(bounds.north) * scale) - tileWarmMargin;
  const bottom = Math.floor(mercatorY(bounds.south) * scale) + tileWarmMargin;
  const tiles = [];

  for (let x = Math.max(left, 0); x <= Math.min(right, scale - 1); x += 1) {
    for (let y = Math.max(top, 0); y <= Math.min(bottom, scale - 1); y += 1) {
      tiles.push({ z: zoom, x, y });
    }
  }

  return tiles;
}

function mercatorX(longitude) {
  return (longitude + 180) / 360;
}

function mercatorY(latitude) {
  const radians = (latitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

async function fetchTile(z, x, y) {
  const upstream = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers: { "User-Agent": tileUserAgent }
  });

  if (!upstream.ok) {
    throw new Error(`tile ${z}/${x}/${y} responded ${upstream.status}`);
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  const cachePath = path.join(tileCacheDir, String(z), String(x), `${y}.png`);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, body);

  return body;
}

// OSM sends cache-control: no-cache, so Chrome re-requests every tile on every
// render. Cache them ourselves instead: one fetch per tile, ever.
async function serveTile(pathname, response) {
  const match = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);

  if (!match) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const [, z, x, y] = match;

  const cachePath = path.join(tileCacheDir, z, x, `${y}.png`);

  try {
    const cached = await readFile(cachePath);
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(cached);
    tileCacheHits += 1;
    return;
  } catch {
    // not cached yet
  }

  try {
    const body = await fetchTile(z, x, y);
    tileCacheMisses += 1;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(body);
  } catch (error) {
    console.warn(`Tile ${z}/${x}/${y} failed: ${error.message}`);
    response.writeHead(502);
    response.end();
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  return {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

async function connectToChrome() {
  const version = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/version`);
    return response.json();
  });
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const client = createCdpClient(socket);

  await client.open;
  const target = await client.send("Target.createTarget", { url: "about:blank" });
  const page = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${chromeDebugPort}/json/list`)).json();
    const nextPage =
      targets.find((item) => item.id === target.targetId) ||
      targets.find((item) => item.type === "page");

    if (!nextPage) {
      throw new Error("Chrome page target not ready");
    }

    return nextPage;
  });

  if (!page?.webSocketDebuggerUrl) {
    throw new Error("Could not find Chrome page target");
  }

  client.close();
  const pageSocket = new WebSocket(page.webSocketDebuggerUrl);
  const pageClient = createCdpClient(pageSocket);
  await pageClient.open;
  return pageClient;
}

function createCdpClient(socket) {
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const open = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }

      return;
    }

    const eventListeners = listeners.get(message.method) || [];
    eventListeners.forEach((listener) => listener(message.params));
  });

  return {
    open,
    close: () => socket.close(),
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${cdpCommandTimeoutMs}ms`));
        }, cdpCommandTimeoutMs);

        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
    },
    waitFor(method) {
      return new Promise((resolve) => {
        const eventListeners = listeners.get(method) || [];
        eventListeners.push(resolve);
        listeners.set(method, eventListeners);
      });
    },
    on(method, callback) {
      const eventListeners = listeners.get(method) || [];
      eventListeners.push(callback);
      listeners.set(method, eventListeners);
      return () => {
        const filtered = (listeners.get(method) || []).filter((l) => l !== callback);
        listeners.set(method, filtered);
      };
    }
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }

  return result.result.value;
}

async function retry(callback, attempts = 60) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  throw lastError;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
