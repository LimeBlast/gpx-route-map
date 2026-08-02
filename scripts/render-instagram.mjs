import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTileRequest, serveTile } from "./lib/pmtiles-server.mjs";
import { serveFile } from "./lib/serve-file.mjs";

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

const frameDir = await mkdtemp(path.join(tmpdir(), "route-progress-frames-"));
const server = await startStaticServer(distDir);
const chrome = spawn(chromePath, [
  "--headless=new",
  // MapLibre needs WebGL; --disable-gpu leaves headless Chrome without a
  // context, so render through SwiftShader instead
  // MapLibre needs WebGL. Headless Chrome falls back to SwiftShader, which
  // renders a reel roughly 30x slower than the platform backend — on macOS
  // that is Metal. Override with CHROME_ANGLE on other platforms.
  "--use-gl=angle",
  `--use-angle=${process.env.CHROME_ANGLE || (process.platform === "darwin" ? "metal" : "gl")}`,
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

  // DEBUG_PAGE=1 forwards the page's console into the render output — the only
  // practical way to see why a headless render is stuck
  if (process.env.DEBUG_PAGE === "1") {
    await client.send("Log.enable");
    client.on("Runtime.consoleAPICalled", ({ type, args }) => {
      console.log(`page.${type}:`, args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    });
    client.on("Log.entryAdded", ({ entry }) => {
      console.log(`page.${entry.level}:`, entry.text, entry.url ? `@ ${entry.url}` : "");
    });
  }
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: width,
    screenHeight: height
  });

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
  const basemapDir = path.join(rootDir, "basemap");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    // Basemap tiles come out of the local .pmtiles archives; fonts and the
    // manifest are plain files alongside them
    if (isTileRequest(pathname)) {
      await serveTile(basemapDir, pathname, response);
      return;
    }

    if (pathname.startsWith("/basemap/")) {
      await serveFile(path.join(basemapDir, pathname.replace("/basemap/", "")), request, response);
      return;
    }

    const filePath = path.join(directory, pathname === "/" ? "/index.html" : pathname);

    if (!filePath.startsWith(directory)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    await serveFile(filePath, request, response);
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
