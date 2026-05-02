import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const outputPath = path.resolve(process.env.OUTPUT || path.join(rootDir, "exports", "instagram-route-map.mp4"));
const fps = Number(process.env.FPS || 30);
const width = Number(process.env.WIDTH || 1080);
const height = Number(process.env.HEIGHT || 1920);
const endHoldSeconds = Number(process.env.END_HOLD_SECONDS || 2);
const frameLimit = Number(process.env.FRAME_LIMIT || 0);
const progressIntervalMs = Number(process.env.PROGRESS_INTERVAL_MS || 2000);
const exportSpeed = Number(process.env.EXPORT_SPEED || 5200);
const maxRenderMinutes = Number(process.env.MAX_RENDER_MINUTES || 60);
const cdpCommandTimeoutMs = Number(process.env.CDP_COMMAND_TIMEOUT_MS || 20_000);
const chromeDebugPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

await run("npm", ["run", "build"]);
await mkdir(path.dirname(outputPath), { recursive: true });

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

  await client.send("Page.navigate", { url: `${server.url}/?export=1&speed=${exportSpeed}` });
  await client.waitFor("Page.loadEventFired");
  await evaluate(client, "new Promise((resolve) => window.routeProgressApp ? resolve() : window.addEventListener('route-progress-ready', resolve, { once: true }))");
  await evaluate(client, "window.routeProgressApp.reset()");
  await sleep(700);

  let frame = 0;
  let finishedAt = null;
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

  while (true) {
    currentStep = "capturing screenshot";
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false
    });
    frame += 1;
    currentStep = "writing frame";
    await writeFile(path.join(frameDir, `frame-${String(frame).padStart(6, "0")}.png`), screenshot.data, "base64");

    currentStep = "reading app state";
    const appState = await evaluate(client, "window.routeProgressApp.state()");
    lastRouteIndex = appState.index;
    windowRouteCount = appState.routeCount;

    if (appState.isComplete && !appState.isPlaying && finishedAt == null) {
      finishedAt = Date.now();
    }

    if (finishedAt && Date.now() - finishedAt >= endHoldSeconds * 1000) {
      break;
    }

    if (frameLimit > 0 && frame >= frameLimit) {
      break;
    }

    if (Date.now() - startedAt > maxRenderMinutes * 60 * 1000) {
      throw new Error(`Timed out after ${maxRenderMinutes} minutes while rendering video`);
    }

    currentStep = "waiting";
    await sleep(1000 / fps);
  }

  clearInterval(heartbeat);
  console.log(`Encoding ${frame} frames with ffmpeg...`);
  await run("ffmpeg", [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(frameDir, "frame-%06d.png"),
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit"
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
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
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
