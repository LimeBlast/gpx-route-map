import { LngLatBounds, Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { layersWithCustomTheme, namedTheme } from "protomaps-themes-base";
import { mergeBounds } from "../scripts/lib/bounds.mjs";
import "./styles.css";

const urlParams = new URLSearchParams(window.location.search);

const reelWidth = 1080;
const reelHeight = 1920;

const colors = {
  run: "#22c55e",
  ride: "#38bdf8",
  walk: "#f59e0b",
  other: "#f97316",
  mixed: "#a855f7"
};

const traceColors = {
  run: "#14532d",
  ride: "#075985",
  walk: "#78350f",
  other: "#7c2d12"
};

const gridCellMeters = 1000;
const minimumTraceDurationMs = 500;
const maximumTraceDurationMs = 1400;
const postTraceHoldMs = 250;
const preRevealAfterPanMs = 100;
const panDurationSeconds = 0.6;
// Hops between areas of activity are worth playing as a flight rather than a
// rushed jump. Regional hops (Toronto to Niagara) get a longer arc; crossing an
// ocean pulls right out so the distance reads.
const regionalHopKm = 60;
const longHaulKm = 1000;
const regionalPanMs = 1900;
const longHaulPanMs = 3600;
const longHaulApexZoom = 3.4;
const finalOverviewDelayMs = 900;
const finalClusterRadiusCells = 14;
const exportTitleDurationMs = Number(urlParams.get("titleMs") || 2000);
const speedMs = Number(urlParams.get("speed") || 5200);
const minimumSwimDurationMs = 1100;
const maximumSwimDurationMs = 1900;
const swimFadeMs = 300;
const maxEndCardLocations = 10;
const devEndCardDelayMs = 2000; // mirrors the renderer's FINAL_HOLD_SECONDS
const tileWaitTimeoutMs = 8000;
const tileSettleGraceMs = 150; // let MapLibre start work for the new view first
const basemapTheme = namedTheme("grayscale");

const state = {
  routes: [],
  gridCells: new Map(),
  completedCells: new Map(),
  gridSignature: "",
  cameraTargetKey: "",
  index: -1,
  isPlaying: false,
  routeAnimationFrame: null,
  routeAnimationToken: 0,
  timer: null,
  routeHeadMarker: null,
  swimMetresTotal: 0,
  panDurationMs: panDurationSeconds * 1000
};

updatePreviewScale();

const map = new MapLibreMap({
  container: "map",
  style: await basemapStyle(),
  center: [-3, 54.5],
  zoom: 5,
  // Below this the world is narrower than the frame and the map stops filling
  // the video — 512px tiles put the whole world at 2048px at zoom 2
  minZoom: 2,
  interactive: false,
  attributionControl: false,
  fadeDuration: 0, // labels must not cross-fade — every frame is captured
  maxZoom: 16
});

// One basemap extract per area of activity, each contributing its own copy of
// the theme's layers. Tiles outside an extract simply draw nothing.
async function basemapStyle() {
  const response = await fetch("/basemap/basemap.json");

  if (!response.ok) {
    throw new Error("No basemap found — run: npm run build:routes && npm run build:basemap");
  }

  const manifest = await response.json();
  const sources = {};
  const layers = [];

  manifest.extracts.forEach((extract, index) => {
    const sourceId = `basemap-${index}`;

    sources[sourceId] = {
      type: "vector",
      tiles: [`/basemap/tiles/${extract.name}/{z}/{x}/{y}.mvt`],
      minzoom: 0,
      maxzoom: extract.maxZoom ?? 14,
      // Bounds keep MapLibre from asking each extract for tiles it cannot have
      bounds: [extract.bounds.west, extract.bounds.south, extract.bounds.east, extract.bounds.north],
      attribution: "© OpenStreetMap contributors"
    };

    for (const layer of layersWithCustomTheme(sourceId, basemapTheme, "en")) {
      // A single background layer is enough, and ids must be unique per source
      if (layer.id === "background" && index > 0) continue;

      layers.push({ ...layer, id: `${layer.id}--${index}` });
    }
  });

  return {
    version: 8,
    glyphs: "/basemap/fonts/{fontstack}/{range}.pbf",
    sources,
    layers
  };
}

const elements = {
  emptyState: document.querySelector("#empty-state"),
  exportCurrentDate: document.querySelector("#export-current-date"),
  exportLocation: document.querySelector("#export-location"),
  calloutIcon: document.querySelector("#callout-icon"),
  exportEndActivities: document.querySelector("#export-end-activities"),
  exportEndRunDistance: document.querySelector("#export-end-run-distance"),
  exportEndRunCount: document.querySelector("#export-end-run-count"),
  exportEndRideDistance: document.querySelector("#export-end-ride-distance"),
  exportEndRideCount: document.querySelector("#export-end-ride-count"),
  exportEndWalkDistance: document.querySelector("#export-end-walk-distance"),
  exportEndWalkCount: document.querySelector("#export-end-walk-count"),
  exportEndSwimDistance: document.querySelector("#export-end-swim-distance"),
  exportEndSwimCount: document.querySelector("#export-end-swim-count"),
  exportEndTiles: document.querySelectorAll("[data-activity-tile]"),
  exportEndLocations: document.querySelector("#export-end-locations"),
  exportEndSquares: document.querySelector("#export-end-squares"),
  exportEndTitle: document.querySelector("#export-end-title"),
  exportKicker: document.querySelector("#export-kicker"),
  exportRouteCount: document.querySelector("#export-route-count"),
  exportSubtitle: document.querySelector("#export-subtitle"),
  exportTitle: document.querySelector("#export-title"),
  exportTotalDistance: document.querySelector("#export-total-distance"),
  swimCard: document.querySelector("#swim-card"),
  swimMeter: document.querySelector("#swim-meter"),
  swimMeterFill: document.querySelector("#swim-meter-fill"),
  swimMeterLabel: document.querySelector("#swim-meter-label"),
  swimMeterSwimmer: document.querySelector("#swim-meter-swimmer"),
  swimDate: document.querySelector("#swim-date"),
  swimLanes: document.querySelector("#swim-lanes"),
  swimLengths: document.querySelector("#swim-lengths"),
  swimMetres: document.querySelector("#swim-metres"),
  swimPool: document.querySelector("#swim-pool"),
  swimStrokes: document.querySelector("#swim-strokes"),
  swimTime: document.querySelector("#swim-time")
};

async function boot() {
  try {
    const response = await fetch("/routes.json");

    if (!response.ok) {
      throw new Error(`Could not load routes.json: ${response.status}`);
    }

    const data = await response.json();
    state.routes = Array.isArray(data.routes) ? data.routes : [];
    state.routes.sort((left, right) => new Date(left.date) - new Date(right.date));
    state.routes.forEach((route) => {
      // Swims have no GPS, so they contribute nothing to the map
      route.segments = route.type === "swim" ? [] : normalizedRouteSegments(route);
      route.cells = route.type === "swim" ? [] : routeCellKeys(route);
    });

    state.swimMetresTotal = state.routes.reduce(
      (sum, route) => (route.type === "swim" ? sum + route.swim.meters : sum),
      0
    );

    await waitForMapReady();
    addOverlayLayers();
    bindMapEvents();
    const monthLabel = routesPeriodLabel(state.routes);
    applyCardText();
    elements.emptyState.hidden = state.routes.length > 0;
    setSwimMeter(0);
    buildGrid();
    render();
    fitAllRoutes();
    exposeAppControls();

    // ponytail: dev preview autoplays and shows the Instagram chrome mockup;
    // the renderer drives play() itself and captures a clean frame
    if (import.meta.env.DEV) {
      document.body.classList.add("dev-chrome");
      const caption = document.querySelector("#ig-caption");
      if (caption && monthLabel) caption.textContent = `${monthLabel} in running, cycling, walking and swimming`;
      window.setTimeout(play, 150);
    }
  } catch (error) {
    console.error(error);
    elements.emptyState.hidden = false;
  }
}

function bindMapEvents() {
  window.addEventListener("resize", () => {
    updatePreviewScale();
    map.resize();
  });
}

// The grid and the route trace are GeoJSON sources restyled per frame, in place
// of Leaflet's one-layer-per-cell rectangles
function addOverlayLayers() {
  map.addSource("grid", { type: "geojson", data: emptyCollection() });
  map.addSource("route", { type: "geojson", data: emptyCollection() });

  map.addLayer({
    id: "grid-fill",
    type: "fill",
    source: "grid",
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": ["get", "fillOpacity"],
      "fill-antialias": false
    }
  });

  map.addLayer({
    id: "grid-outline",
    type: "line",
    source: "grid",
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": ["get", "lineOpacity"],
      "line-width": ["get", "weight"]
    }
  });

  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 4 }
  });
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

// The load event fires while routes.json is still being crunched, so record it
// rather than relying on attaching a listener in time
// Exposed in production too: when a headless render stalls, this is the only
// way to see what the map is doing
window.__map = map;
window.__state = state;
map.on("error", (event) => console.error("maplibre:", event.error?.message || event.error));

let mapHasLoaded = false;
map.once("load", () => {
  mapHasLoaded = true;
});

function waitForMapReady() {
  return mapHasLoaded ? Promise.resolve() : new Promise((resolve) => map.once("load", resolve));
}

function updatePreviewScale() {
  const scale = Math.min(window.innerWidth / reelWidth, window.innerHeight / reelHeight, 1);
  document.documentElement.style.setProperty("--reel-scale", String(scale));
}

// "August 2026" for a single month, "July 2025 to August 2026" for a render
// spanning several — an all-months reel is not "my month" in anything
function routesPeriodLabel(routes) {
  if (routes.length === 0) return null;

  const months = routes.map((route) => route.date.slice(0, 7)).sort();
  const first = monthName(months[0]);
  const last = monthName(months.at(-1));

  return first === last ? first : `${first} to ${last}`;
}

function monthName(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleString("en-GB", {
    month: "long",
    year: "numeric"
  });
}

function spansOneMonth(routes) {
  return new Set(routes.map((route) => route.date.slice(0, 7))).size <= 1;
}

function applyCardText() {
  const periodLabel = routesPeriodLabel(state.routes);

  elements.exportTitle.textContent =
    urlParams.get("title") || (spansOneMonth(state.routes) ? "My Month in Fitness" : "My Fitness");
  elements.exportSubtitle.textContent = urlParams.get("subtitle") || "Every square unlocked, one activity at a time.";
  elements.exportKicker.textContent = urlParams.get("kicker") || periodLabel || "Route Progress";
}

function exposeAppControls() {
  window.routeProgressApp = {
    play,
    pause,
    showEndCard,
    reset() {
      pause();
      hideSwimCard();
      setSwimMeter(0);
      state.index = -1;
      state.cameraTargetKey = "";
      render();
      fitAllRoutes();
    },
    state() {
      return {
        index: state.index,
        isEnded: document.body.classList.contains("export-ended"),
        isComplete: state.index >= state.routes.length - 1,
        isPlaying: state.isPlaying,
        routeCount: state.routes.length
      };
    }
  };

  window.dispatchEvent(new CustomEvent("route-progress-ready"));
}

function play() {
  if (state.routes.length === 0) return;

  state.isPlaying = true;
  document.body.classList.remove("export-ended");

  if (state.index >= state.routes.length - 1) {
    state.index = -1;
    render();
    fitAllRoutes();
  }

  if (state.index === -1 && !document.body.classList.contains("export-started")) {
    document.body.classList.add("export-started");
    state.timer = window.setTimeout(tick, exportTitleDurationMs);
  } else {
    document.body.classList.add("export-started");
    tick();
  }
}

function tick() {
  if (!state.isPlaying) return;

  hideActivityCallout();

  if (state.index >= state.routes.length - 1) {
    state.timer = window.setTimeout(() => {
      if (!state.isPlaying) return;

      clearRouteLayers();
      showFinalOverview();
      pause();

      // The renderer calls showEndCard() itself; in the preview nothing would
      // otherwise drive it, so the final card never appeared
      if (import.meta.env.DEV) window.setTimeout(showEndCard, devEndCardDelayMs);
    }, finalOverviewDelayMs);
    return;
  }

  const nextIndex = state.index + 1;

  if (state.routes[nextIndex].type === "swim") {
    clearRouteLayers();
    state.index = nextIndex;
    render();
    revealSwim(state.routes[nextIndex], tick);
    return;
  }

  clearRouteLayers();
  const cameraMoved = focusPlaybackView(nextIndex);
  const followUpDelayMs = traceDurationMs() + Math.max(speedMs * 0.12, postTraceHoldMs);

  const revealRoute = () => {
    if (!state.isPlaying) return;

    state.index = nextIndex;
    render();
    showActivityCallout(state.routes[nextIndex]);

    state.timer = window.setTimeout(tick, followUpDelayMs);
  };

  if (cameraMoved) {
    waitForCameraMove(() => {
      if (!state.isPlaying) return;
      // Don't reveal onto half-drawn tiles — most obvious on a long jump
      waitForTiles(() => {
        state.timer = window.setTimeout(revealRoute, preRevealAfterPanMs);
      });
    });
  } else {
    revealRoute();
  }
}

// The map total covers ground covered on land; swims are shown on their own card
function landDistanceKm(routes) {
  return routes.reduce((sum, route) => (route.type === "swim" ? sum : sum + route.distanceKm), 0);
}

function setSwimMeter(metres) {
  const fraction = state.swimMetresTotal > 0 ? metres / state.swimMetresTotal : 0;
  const percent = `${(fraction * 100).toFixed(2)}%`;
  elements.swimMeterFill.style.width = percent;
  // Keep the badge inside the track at both ends
  elements.swimMeterSwimmer.style.left = `clamp(29px, ${percent}, calc(100% - 29px))`;
  elements.swimMeterLabel.textContent = `${Math.round(metres).toLocaleString()} m`;
}

function swimMetresBefore(index) {
  return state.routes
    .slice(0, index)
    .reduce((sum, route) => (route.type === "swim" ? sum + route.swim.meters : sum), 0);
}

function swimDurationMs() {
  return Math.min(Math.max(Math.round(speedMs * 0.7), minimumSwimDurationMs), maximumSwimDurationMs);
}

function revealSwim(route, done) {
  const { swim } = route;
  const metresBefore = swimMetresBefore(state.index);
  const token = state.routeAnimationToken;
  const durationMs = swimDurationMs();
  const holdMs = Math.max(speedMs * 0.12, postTraceHoldMs);
  const totalSeconds = swim.lengths.reduce((sum, length) => sum + length.seconds, 0);

  elements.swimDate.textContent = formatDate(route.date);
  elements.swimPool.textContent = `${swim.poolLengthMeters} m`;
  elements.swimStrokes.textContent = String(swim.strokes);
  elements.swimTime.textContent = formatDuration(swim.seconds);
  elements.swimLanes.replaceChildren(
    ...swim.lengths.map(() => {
      const lane = document.createElement("i");
      lane.className = "swim-lane";
      return lane;
    })
  );

  const lanes = Array.from(elements.swimLanes.children);
  const showFilled = (count) => {
    lanes.forEach((lane, index) => lane.classList.toggle("filled", index < count));
    const metres = Math.round(count * swim.poolLengthMeters);
    elements.swimMetres.textContent = String(metres);
    elements.swimLengths.textContent = String(count);
    setSwimMeter(metresBefore + metres);
  };

  showFilled(0);
  showActivityCallout(route);
  elements.swimCard.hidden = false;
  elements.swimMeter.hidden = false; // stays up for the rest of the reel
  requestAnimationFrame(() => elements.swimCard.classList.add("visible"));

  // Lengths fill in proportion to how long each one actually took
  const draw = (startedAt, timestamp) => {
    if (token !== state.routeAnimationToken || !state.isPlaying) return;

    const progress = Math.min((timestamp - startedAt) / durationMs, 1);
    const targetSeconds = totalSeconds * progress;
    let elapsed = 0;
    let filled = 0;

    for (const length of swim.lengths) {
      if (elapsed + length.seconds > targetSeconds) break;
      elapsed += length.seconds;
      filled += 1;
    }

    showFilled(filled);

    if (progress < 1) {
      state.routeAnimationFrame = requestAnimationFrame((next) => draw(startedAt, next));
      return;
    }

    showFilled(swim.lengths.length);
    state.timer = window.setTimeout(() => {
      if (token !== state.routeAnimationToken || !state.isPlaying) return;

      elements.swimCard.classList.remove("visible");
      state.timer = window.setTimeout(() => {
        elements.swimCard.hidden = true;
        done();
      }, swimFadeMs);
    }, holdMs);
  };

  state.routeAnimationFrame = requestAnimationFrame((timestamp) => {
    state.timer = window.setTimeout(() => draw(timestamp, performance.now()), swimFadeMs);
  });
}

function showEndCard() {
  updateExportEndCard();
  document.body.classList.add("export-ended");
}

function showFinalOverview() {
  const bounds = densestClusterBounds();

  if (boundsAreValid(bounds)) {
    moveToBounds(bounds, { key: "final-overview", maxZoom: 12, force: true, padding: [96, 96] });
  }
}

function pause() {
  state.isPlaying = false;
  window.clearTimeout(state.timer);
}

function hideSwimCard() {
  elements.swimCard.classList.remove("visible");
  elements.swimCard.hidden = true;
  elements.swimMeter.hidden = true;
}

function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function waitForCameraMove(callback) {
  let isDone = false;

  const finish = () => {
    if (isDone) return;

    isDone = true;
    map.off("moveend", finish);
    window.clearTimeout(state.timer);
    callback();
  };

  map.once("moveend", finish);
  state.timer = window.setTimeout(finish, (state.panDurationMs || panDurationSeconds * 1000) + 1200);
}

function cameraPadding(padding) {
  return Array.isArray(padding)
    ? { top: padding[0], bottom: padding[0], left: padding[1], right: padding[1] }
    : padding;
}

// Tiles come off local disk, but MapLibre still parses and lays out labels
// asynchronously, so wait for the map to go quiet before revealing a route.
function waitForTiles(callback) {
  const startedAt = performance.now();

  const poll = () => {
    if (!state.isPlaying) return;

    if (map.loaded() || performance.now() - startedAt > tileWaitTimeoutMs) {
      callback();
      return;
    }

    state.timer = window.setTimeout(poll, 60);
  };

  state.timer = window.setTimeout(poll, tileSettleGraceMs);
}

function render() {
  clearRouteLayers();

  const visibleRoutes = state.routes.slice(0, state.index + 1);
  const latestRoute = visibleRoutes.at(-1);
  const previousRoutes = latestRoute ? visibleRoutes.slice(0, -1) : visibleRoutes;
  const visibleDistance = landDistanceKm(visibleRoutes);
  const completedCells = completedCellMap(previousRoutes);

  state.completedCells = completedCells;
  renderGrid(completedCells);

  if (latestRoute) {
    renderAnimatedRouteTrace(latestRoute, completedCells);
  }

  elements.exportRouteCount.textContent = String(completedCells.size);
  elements.exportTotalDistance.textContent = `${visibleDistance.toFixed(1)} km`;
  elements.exportCurrentDate.textContent = latestRoute ? formatDate(latestRoute.date) : "—";
  elements.exportLocation.textContent = latestRoute?.location || "—";
  updateExportEndCard();
}

function updateExportEndCard() {
  const visibleRoutes = state.routes.slice(0, Math.max(state.index + 1, 0));
  const routeSource = visibleRoutes.length > 0 ? visibleRoutes : state.routes;
  const completedCells = visibleRoutes.length > 0 ? state.completedCells : allCellMap(state.routes);
  const runs = routeSource.filter((route) => route.type === "run");
  const rides = routeSource.filter((route) => route.type === "ride");
  const walks = routeSource.filter((route) => route.type === "walk");
  const swims = routeSource.filter((route) => route.type === "swim");
  const runDistance = runs.reduce((sum, route) => sum + route.distanceKm, 0);
  const rideDistance = rides.reduce((sum, route) => sum + route.distanceKm, 0);
  const walkDistance = walks.reduce((sum, route) => sum + route.distanceKm, 0);
  const swimMetres = swims.reduce((sum, route) => sum + route.swim.meters, 0);

  elements.exportEndTitle.textContent = urlParams.get("endTitle") || routesPeriodLabel(state.routes) || "Progress unlocked";
  elements.exportEndActivities.textContent = String(routeSource.length);
  elements.exportEndSquares.textContent = String(completedCells.size);
  elements.exportEndRunDistance.textContent = `${runDistance.toFixed(1)} km`;
  elements.exportEndRunCount.textContent = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
  elements.exportEndRideDistance.textContent = `${rideDistance.toFixed(1)} km`;
  elements.exportEndRideCount.textContent = `${rides.length} ${rides.length === 1 ? "ride" : "rides"}`;
  elements.exportEndWalkDistance.textContent = `${walkDistance.toFixed(1)} km`;
  elements.exportEndWalkCount.textContent = `${walks.length} ${walks.length === 1 ? "walk" : "walks"}`;

  // Months without a given activity shouldn't show an empty 0 km tile
  elements.exportEndSwimDistance.textContent = `${swimMetres.toLocaleString()} m`;
  elements.exportEndSwimCount.textContent = `${swims.length} ${swims.length === 1 ? "swim" : "swims"}`;

  const counts = { run: runs.length, ride: rides.length, walk: walks.length, swim: swims.length };
  elements.exportEndTiles.forEach((tile) => {
    tile.hidden = counts[tile.dataset.activityTile] === 0;
  });

  elements.exportEndLocations.textContent = visitedLocations(routeSource).join(" · ");
}

// Places visited, in the order they first appear, so the card reads as a
// journey rather than an alphabetical list
function visitedLocations(routes) {
  const seen = [];

  for (const route of routes) {
    if (route.location && !seen.includes(route.location)) seen.push(route.location);
  }

  if (seen.length <= maxEndCardLocations) return seen;

  return [...seen.slice(0, maxEndCardLocations), `+${seen.length - maxEndCardLocations} more`];
}

function updateVisibleSquareCounts(completedCells) {
  elements.exportRouteCount.textContent = String(completedCells.size);
  updateExportEndCard();
}

function updateVisibleDistance(distanceKm) {
  elements.exportTotalDistance.textContent = `${distanceKm.toFixed(1)} km`;
}

function focusPlaybackView(targetIndex = state.index) {
  const latestRoute = state.routes[targetIndex];

  if (!latestRoute) return false;

  const latestBounds = cellKeysBounds(latestRoute.cells);

  if (!boundsAreValid(latestBounds)) return false;

  return moveToBounds(latestBounds, { key: `route:${latestRoute.id}`, maxZoom: 14 });
}

function moveToBounds(bounds, options = {}) {
  if (options.key && state.cameraTargetKey === options.key) return false;

  state.cameraTargetKey = options.key || "";
  map.stop();

  // Clears the stats bar (ends ~371px) and the swim meter (~430px); without
  // this a route could be drawn underneath them
  const padding = cameraPadding(options.padding || { top: 470, bottom: 430, left: 72, right: 72 });
  const maxZoom = options.maxZoom || 14;
  const lngLatBounds = toLngLatBounds(bounds);
  const camera = map.cameraForBounds(lngLatBounds, { padding, maxZoom });

  // Already framed comfortably? Stay put rather than nudge the camera
  if (!options.force && camera && boundsWithinView(bounds) && map.getZoom() >= Math.min(camera.zoom, maxZoom)) {
    return false;
  }

  const hopKm = camera ? centreDistanceKm(map.getCenter(), camera.center) : 0;

  if (camera && hopKm > regionalHopKm) {
    const isLongHaul = hopKm > longHaulKm;
    state.panDurationMs = isLongHaul ? longHaulPanMs : regionalPanMs;

    map.flyTo({
      center: camera.center,
      zoom: Math.min(camera.zoom, maxZoom),
      duration: state.panDurationMs,
      // Forcing the apex only makes sense for the big crossings; shorter hops
      // read better with flyTo's own arc
      ...(isLongHaul ? { minZoom: longHaulApexZoom } : { curve: 1.7 }),
      essential: true
    });

    return true;
  }

  state.panDurationMs = panDurationSeconds * 1000;
  map.fitBounds(lngLatBounds, {
    padding,
    maxZoom,
    duration: state.panDurationMs,
    essential: true
  });

  return true;
}

function centreDistanceKm(from, to) {
  return (
    haversineMeters(
      { latitude: from.lat, longitude: from.lng },
      { latitude: to.lat, longitude: to.lng }
    ) / 1000
  );
}

// Leaflet had bounds.pad(); this is the same idea — is the target well inside
// what is already on screen?
function boundsWithinView(bounds) {
  const view = map.getBounds();
  const insetX = (view.getEast() - view.getWest()) * 0.15;
  const insetY = (view.getNorth() - view.getSouth()) * 0.15;

  return (
    bounds.west >= view.getWest() + insetX &&
    bounds.east <= view.getEast() - insetX &&
    bounds.south >= view.getSouth() + insetY &&
    bounds.north <= view.getNorth() - insetY
  );
}

function toLngLatBounds(bounds) {
  return new LngLatBounds([bounds.west, bounds.south], [bounds.east, bounds.north]);
}

function boundsAreValid(bounds) {
  return Boolean(bounds) && Number.isFinite(bounds.west) && Number.isFinite(bounds.south);
}

function clearRouteLayers() {
  if (state.routeAnimationFrame) {
    cancelAnimationFrame(state.routeAnimationFrame);
  }

  state.routeAnimationFrame = null;
  state.routeAnimationToken += 1;
  map.getSource("route")?.setData(emptyCollection());
  removeRouteHeadMarker();
}

function renderAnimatedRouteTrace(route, baseCompletedCells = state.completedCells) {
  const color = traceColors[route.type] || traceColors.other;
  const token = state.routeAnimationToken;
  const totalDistance = route.segments.reduce((sum, segment) => sum + segmentDistanceMeters(segment), 0);
  const durationMs = traceDurationMs();

  if (totalDistance <= 0) return;

  const draw = (startedAt, timestamp) => {
    if (token !== state.routeAnimationToken) return;

    const progress = Math.min((timestamp - startedAt) / durationMs, 1);
    drawRouteProgress(route, color, totalDistance * progress, baseCompletedCells);

    if (progress < 1) {
      state.routeAnimationFrame = requestAnimationFrame((nextTimestamp) => {
        draw(startedAt, nextTimestamp);
      });
    }
  };

  state.routeAnimationFrame = requestAnimationFrame((timestamp) => {
    draw(timestamp, timestamp);
  });
}

function drawRouteProgress(route, color, targetDistanceMeters, baseCompletedCells) {
  let remainingDistance = targetDistanceMeters;
  const visibleSegments = [];

  for (const segment of route.segments) {
    if (remainingDistance <= 0) break;

    const segmentDistance = segmentDistanceMeters(segment);

    if (remainingDistance >= segmentDistance) {
      visibleSegments.push(segment);
      remainingDistance -= segmentDistance;
    } else {
      const partialSegment = segmentSliceByDistance(segment, remainingDistance);

      if (partialSegment.length > 1) {
        visibleSegments.push(partialSegment);
      }

      remainingDistance = 0;
    }
  }

  const completedCells = completedCellMapWithRouteCells(
    baseCompletedCells,
    route,
    cellKeysForLatLngSegments(visibleSegments)
  );

  state.completedCells = completedCells;
  renderGrid(completedCells);
  updateVisibleSquareCounts(completedCells);
  updateVisibleDistance(landDistanceKm(state.routes.slice(0, state.index)) + targetDistanceMeters / 1000);

  if (visibleSegments.length === 0) {
    map.getSource("route")?.setData(emptyCollection());
    removeRouteHeadMarker();
    return;
  }

  map.getSource("route")?.setData({
    type: "FeatureCollection",
    features: visibleSegments.map((segment) => ({
      type: "Feature",
      properties: { color },
      // Route segments are stored [lat, lng]; GeoJSON wants the reverse
      geometry: { type: "LineString", coordinates: segment.map(([lat, lng]) => [lng, lat]) }
    }))
  });

  // Place / move the sport icon at the leading tip of the route trace
  const headLatLng = visibleSegments.at(-1).at(-1);

  if (headLatLng) {
    const position = [headLatLng[1], headLatLng[0]];

    if (state.routeHeadMarker) {
      state.routeHeadMarker.setLngLat(position);
    } else {
      const element = document.createElement("div");
      element.className = "route-head-icon";
      element.style.setProperty("--head-color", traceColors[route.type] || traceColors.other);
      state.routeHeadMarker = new Marker({ element }).setLngLat(position).addTo(map);
    }
  }
}

function removeRouteHeadMarker() {
  if (state.routeHeadMarker) {
    state.routeHeadMarker.remove();
    state.routeHeadMarker = null;
  }
}

function traceDurationMs() {
  return Math.min(Math.max(Math.round(speedMs * 0.5), minimumTraceDurationMs), maximumTraceDurationMs);
}

function segmentDistanceMeters(segment) {
  let distance = 0;

  for (let index = 1; index < segment.length; index += 1) {
    distance += latLngDistanceMeters(segment[index - 1], segment[index]);
  }

  return distance;
}

function segmentSliceByDistance(segment, targetDistanceMeters) {
  const points = [segment[0]];
  let travelled = 0;

  for (let index = 1; index < segment.length; index += 1) {
    const previousPoint = segment[index - 1];
    const point = segment[index];
    const distance = latLngDistanceMeters(previousPoint, point);

    if (travelled + distance <= targetDistanceMeters) {
      points.push(point);
      travelled += distance;
      continue;
    }

    const remaining = targetDistanceMeters - travelled;
    const progress = distance > 0 ? remaining / distance : 0;

    points.push([
      previousPoint[0] + (point[0] - previousPoint[0]) * progress,
      previousPoint[1] + (point[1] - previousPoint[1]) * progress
    ]);
    break;
  }

  return points;
}

function latLngDistanceMeters(left, right) {
  return haversineMeters(
    { latitude: left[0], longitude: left[1] },
    { latitude: right[0], longitude: right[1] }
  );
}

function fitAllRoutes() {
  const bounds = cellKeysBounds(Array.from(state.gridCells.keys()));

  if (boundsAreValid(bounds)) {
    map.fitBounds(toLngLatBounds(bounds), { padding: 40, duration: 0, maxZoom: 14 });
  }
}

function cellKeysBounds(cellKeys) {
  if (cellKeys.length === 0) return null;

  return mergeBounds(cellKeys.map((key) => cellBounds(state.gridCells.get(key) || parseCellKey(key))));
}

function densestClusterBounds() {
  const cells = Array.from(state.completedCells.entries()).map(([key, cell]) => ({
    key,
    visitCount: cell.visitCount,
    ...parseCellKey(key)
  }));

  if (cells.length === 0) {
    return cellKeysBounds(Array.from(state.gridCells.keys()));
  }


  let bestCell = cells[0];
  let bestScore = -Infinity;
  const radiusSquared = finalClusterRadiusCells ** 2;

  for (const candidate of cells) {
    let score = 0;

    for (const cell of cells) {
      const distanceSquared = (cell.x - candidate.x) ** 2 + (cell.y - candidate.y) ** 2;

      if (distanceSquared <= radiusSquared) {
        score += cell.visitCount / Math.max(Math.sqrt(distanceSquared), 1);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCell = candidate;
    }
  }

  const clusterKeys = cells
    .filter((cell) => (cell.x - bestCell.x) ** 2 + (cell.y - bestCell.y) ** 2 <= radiusSquared)
    .map((cell) => cell.key);

  return cellKeysBounds(clusterKeys);
}

function buildGrid() {
  state.gridCells = allCellMap(state.routes);
  state.gridSignature = "";
}

// One GeoJSON feature per cell, styled by its own properties. Rebuilding the
// collection is only worth it when the completed set actually changed — the
// trace animation calls this on every frame.
function renderGrid(completedCells) {
  const signature = `${completedCells.size}:${[...completedCells.values()].reduce((sum, cell) => sum + cell.visitCount, 0)}`;

  if (signature === state.gridSignature) return;

  state.gridSignature = signature;
  const features = [];

  // Only visited cells are drawn — an unvisited grid showing through gave away
  // where the routes were going
  for (const [key, completedCell] of completedCells) {
    const cell = state.gridCells.get(key) || parseCellKey(key);
    const intensity = cellIntensity(completedCell.visitCount);

    features.push({
      type: "Feature",
      properties: {
        color: cellColor(completedCell),
        fillOpacity: intensity,
        lineOpacity: Math.min(intensity + 0.24, 0.95),
        weight: completedCell.visitCount > 1 ? 1.5 : 1.1
      },
      geometry: { type: "Polygon", coordinates: [cellRing(cell)] }
    });
  }

  map.getSource("grid")?.setData({ type: "FeatureCollection", features });
}

function allCellMap(routes) {
  const cells = new Map();

  routes.forEach((route) => {
    route.cells.forEach((key) => {
      if (!cells.has(key)) {
        cells.set(key, parseCellKey(key));
      }
    });
  });

  return cells;
}

function completedCellMap(routes) {
  const cells = new Map();

  routes.forEach((route) => {
    route.cells.forEach((key) => {
      const cell = cells.get(key) || {
        route,
        visitCount: 0,
        types: new Set()
      };

      cell.route = route;
      cell.visitCount += 1;
      cell.types.add(route.type);
      cells.set(key, cell);
    });
  });

  return cells;
}

function completedCellMapWithRouteCells(baseCells, route, routeCellKeys) {
  const cells = cloneCompletedCellMap(baseCells);

  routeCellKeys.forEach((key) => {
    const cell = cells.get(key) || {
      ...parseCellKey(key),
      route,
      visitCount: 0,
      types: new Set()
    };

    cell.route = route;
    cell.visitCount += 1;
    cell.types.add(route.type);
    cells.set(key, cell);
  });

  return cells;
}

function cloneCompletedCellMap(cells) {
  return new Map(
    Array.from(cells.entries()).map(([key, cell]) => [
      key,
      {
        ...cell,
        types: new Set(cell.types)
      }
    ])
  );
}

function cellKeysForLatLngSegments(segments) {
  const keys = new Set();

  segments.forEach((segment) => {
    const points = segment.map(([latitude, longitude]) => ({ latitude, longitude }));

    points.forEach((point) => keys.add(cellKeyForPoint(point)));

    for (let index = 1; index < points.length; index += 1) {
      interpolatedPoints(points[index - 1], points[index], gridCellMeters / 3).forEach((point) => {
        keys.add(cellKeyForPoint(point));
      });
    }
  });

  return Array.from(keys);
}

function cellColor(cell) {
  if (cell.types.has("run") && cell.types.has("ride")) {
    return colors.mixed;
  }

  if (cell.types.size > 1) {
    return colors.mixed;
  }

  return colors[cell.types.values().next().value] || colors.other;
}

function cellIntensity(visitCount) {
  return Math.min(0.07 + Math.log2(visitCount + 1) * 0.23, 0.82);
}

function routeCellKeys(route) {
  const keys = new Set();
  const points = route.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));

  points.forEach((point) => keys.add(cellKeyForPoint(point)));

  for (let index = 1; index < points.length; index += 1) {
    interpolatedPoints(points[index - 1], points[index], gridCellMeters / 3).forEach((point) => {
      keys.add(cellKeyForPoint(point));
    });
  }

  return Array.from(keys);
}

function normalizedRouteSegments(route) {
  const sourceSegments = Array.isArray(route.segments) && route.segments.length > 0
    ? route.segments
    : [route.coordinates || []];

  return sourceSegments
    .map((segment) =>
      segment
        .map(([longitude, latitude]) => [latitude, longitude])
        .filter(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude))
    )
    .filter((segment) => segment.length > 1);
}

function interpolatedPoints(start, end, maxStepMeters) {
  const distance = haversineMeters(start, end);
  const steps = Math.max(Math.ceil(distance / maxStepMeters), 1);
  const points = [];

  for (let step = 1; step < steps; step += 1) {
    const progress = step / steps;
    points.push({
      latitude: start.latitude + (end.latitude - start.latitude) * progress,
      longitude: start.longitude + (end.longitude - start.longitude) * progress
    });
  }

  return points;
}

// Spherical Mercator metres — the same projection Leaflet's EPSG3857 CRS used,
// so cell keys are unchanged
const earthRadiusMeters = 6378137;

function projectMeters(latitude, longitude) {
  return {
    x: earthRadiusMeters * toRadians(longitude),
    y: earthRadiusMeters * Math.log(Math.tan(Math.PI / 4 + toRadians(latitude) / 2))
  };
}

function unprojectMeters(x, y) {
  return {
    longitude: (x / earthRadiusMeters) * (180 / Math.PI),
    latitude: (2 * Math.atan(Math.exp(y / earthRadiusMeters)) - Math.PI / 2) * (180 / Math.PI)
  };
}

function cellKeyForPoint(point) {
  const projected = projectMeters(point.latitude, point.longitude);
  const x = Math.floor(projected.x / gridCellMeters);
  const y = Math.floor(projected.y / gridCellMeters);

  return `${x}:${y}`;
}

function parseCellKey(key) {
  const [x, y] = key.split(":").map(Number);
  return { x, y };
}

function cellBounds(cell) {
  const southWest = unprojectMeters(cell.x * gridCellMeters, cell.y * gridCellMeters);
  const northEast = unprojectMeters((cell.x + 1) * gridCellMeters, (cell.y + 1) * gridCellMeters);

  return {
    west: southWest.longitude,
    south: southWest.latitude,
    east: northEast.longitude,
    north: northEast.latitude
  };
}

function cellRing(cell) {
  const bounds = cellBounds(cell);

  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
    [bounds.west, bounds.south]
  ];
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function haversineMeters(left, right) {
  const earthRadiusMeters = 6_371_000;
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

const activityIcons = {
  run: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 10.42 4.8-5.07"/><path d="M19 18h3"/><path d="M9.5 22 21.414 9.415A2 2 0 0 0 21.2 6.4l-5.61-4.208A1 1 0 0 0 14 3v2a2 2 0 0 1-1.394 1.906L8.677 8.053A1 1 0 0 0 8 9c-.155 6.393-2.082 9-4 9a2 2 0 0 0 0 4h14"/></svg>`,
  ride: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`,
  walk: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-1.12 1.03-2.12 1-4.62-.03-2.72-1.49-6-4.5-6C14.63 7 14 8.8 14 10.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`,
  swim: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="16.5" cy="6.5" r="1.5"/><path d="m7 15 2.5-2.5L6 9l3.5-3.5L13 9l-2 2 3 3"/><path d="M2 18.5c1.2 0 1.2 1 2.4 1s1.2-1 2.4-1 1.2 1 2.4 1 1.2-1 2.4-1 1.2 1 2.4 1 1.2-1 2.4-1 1.2 1 2.4 1"/></svg>`
};

function showActivityCallout(route) {
  elements.calloutIcon.className = `callout-icon ${route.type} visible`;
  elements.calloutIcon.innerHTML = activityIcons[route.type] || "";
}

function hideActivityCallout() {
  elements.calloutIcon.classList.remove("visible");
}

boot();
