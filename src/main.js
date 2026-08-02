import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
const minimumTraceDurationMs = 800;
const maximumTraceDurationMs = 2000;
const postTraceHoldMs = 500;
const preRevealAfterPanMs = 200;
const panDurationSeconds = 1.0;
const finalOverviewDelayMs = 1400;
const finalClusterRadiusCells = 14;
const exportTitleDurationMs = Number(urlParams.get("titleMs") || 2800);
const speedMs = Number(urlParams.get("speed") || 5200);
const minimumSwimDurationMs = 1600;
const maximumSwimDurationMs = 3200;
const swimFadeMs = 450;

const state = {
  routes: [],
  gridCells: new Map(),
  cellLayers: new Map(),
  completedCells: new Map(),
  gridRefreshFrame: null,
  cameraTargetKey: "",
  index: -1,
  isPlaying: false,
  routeAnimationFrame: null,
  routeAnimationToken: 0,
  timer: null,
  routeHeadMarker: null,
  swimMetresTotal: 0
};

updatePreviewScale();

const map = L.map("map", {
  zoomControl: false,
  scrollWheelZoom: false
}).setView([54.5, -3], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  className: "greyscale-tiles",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

map.createPane("gridPane");
map.getPane("gridPane").style.zIndex = 410;
map.getPane("gridPane").style.pointerEvents = "none";

map.createPane("routePane");
map.getPane("routePane").style.zIndex = 430;

map.createPane("headPane");
map.getPane("headPane").style.zIndex = 440;
map.getPane("headPane").style.pointerEvents = "none";

const gridRenderer = L.canvas({ pane: "gridPane", padding: 1 });
const gridLayerGroup = L.layerGroup().addTo(map);
const routeLayerGroup = L.layerGroup().addTo(map);

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

    await waitForMapLayout();
    bindMapEvents();
    applyCardText();
    elements.emptyState.hidden = state.routes.length > 0;
    elements.swimMeter.hidden = state.swimMetresTotal === 0;
    setSwimMeter(0);
    buildGrid();
    render();
    fitAllRoutes();
    exposeAppControls();

    // ponytail: dev preview autoplays and shows the Instagram chrome mockup;
    // the renderer drives play() itself and captures a clean frame
    if (import.meta.env.DEV) {
      document.body.classList.add("dev-chrome");
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
    map.invalidateSize();
    refreshGridStyles();
  });

  map.on("movestart move zoomstart zoom zoomend moveend", refreshGridStyles);
  map.on("zoomend moveend", () => {
    window.setTimeout(refreshGridStyles, 60);
  });
}

function updatePreviewScale() {
  const scale = Math.min(window.innerWidth / reelWidth, window.innerHeight / reelHeight, 1);
  document.documentElement.style.setProperty("--reel-scale", String(scale));
}

function routesMonthLabel(routes) {
  if (routes.length === 0) return null;
  return new Date(routes[0].date).toLocaleString("en-GB", { month: "long", year: "numeric" });
}

function applyCardText() {
  const monthLabel = routesMonthLabel(state.routes);

  elements.exportTitle.textContent = urlParams.get("title") || "My Month in Fitness";
  elements.exportSubtitle.textContent = urlParams.get("subtitle") || "Every square unlocked, one activity at a time.";
  elements.exportKicker.textContent = urlParams.get("kicker") || monthLabel || "Route Progress";
}

function exposeAppControls() {
  window.routeProgressApp = {
    play,
    pause,
    showEndCard() {
      updateExportEndCard();
      document.body.classList.add("export-ended");
    },
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
  const followUpDelayMs = traceDurationMs() + Math.max(speedMs * 0.2, postTraceHoldMs);

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
      state.timer = window.setTimeout(revealRoute, preRevealAfterPanMs);
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
  elements.swimMeterFill.style.height = `${(fraction * 100).toFixed(2)}%`;
  elements.swimMeterLabel.textContent = `${Math.round(metres).toLocaleString()} m`;
}

function swimMetresBefore(index) {
  return state.routes
    .slice(0, index)
    .reduce((sum, route) => (route.type === "swim" ? sum + route.swim.meters : sum), 0);
}

function swimDurationMs() {
  return Math.min(Math.max(Math.round(speedMs * 0.9), minimumSwimDurationMs), maximumSwimDurationMs);
}

function revealSwim(route, done) {
  const { swim } = route;
  const metresBefore = swimMetresBefore(state.index);
  const token = state.routeAnimationToken;
  const durationMs = swimDurationMs();
  const holdMs = Math.max(speedMs * 0.2, postTraceHoldMs);
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
  elements.swimCard.hidden = false;
  document.body.classList.add("swim-showing");
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
      document.body.classList.remove("swim-showing");
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

function showFinalOverview() {
  const bounds = densestClusterBounds();

  if (bounds.isValid()) {
    moveToBounds(bounds, { key: "final-overview", maxZoom: 12, force: true, padding: [96, 96] });
  }
}

function pause() {
  state.isPlaying = false;
  window.clearTimeout(state.timer);
}

function hideSwimCard() {
  document.body.classList.remove("swim-showing");
  elements.swimCard.classList.remove("visible");
  elements.swimCard.hidden = true;
}

function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function waitForMapLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        map.invalidateSize();
        resolve();
      });
    });
  });
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
  state.timer = window.setTimeout(finish, panDurationSeconds * 1000 + 800);
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

  elements.exportEndTitle.textContent = urlParams.get("endTitle") || routesMonthLabel(state.routes) || "Progress unlocked";
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

  if (!latestBounds.isValid()) return false;

  return moveToBounds(latestBounds, { key: `route:${latestRoute.id}`, maxZoom: 14 });
}

function moveToBounds(bounds, options = {}) {
  if (options.key && state.cameraTargetKey === options.key) return false;

  state.cameraTargetKey = options.key || "";
  map.stop();

  const padding = options.padding || { topLeft: [72, 240], bottomRight: [72, 420] };
  const paddingTopLeft = Array.isArray(padding) ? padding : padding.topLeft;
  const paddingBottomRight = Array.isArray(padding) ? padding : padding.bottomRight;
  const zoomPadding = [
    (paddingTopLeft[0] + paddingBottomRight[0]) / 2,
    (paddingTopLeft[1] + paddingBottomRight[1]) / 2
  ];

  const targetZoom = map.getBoundsZoom(bounds, false, zoomPadding);
  const cappedTargetZoom = Math.min(targetZoom, options.maxZoom || 14);

  if (!options.force && map.getBounds().pad(-0.15).contains(bounds) && map.getZoom() >= cappedTargetZoom) {
    refreshGridStyles();
    return false;
  }

  map.flyToBounds(bounds, {
    animate: true,
    duration: panDurationSeconds,
    easeLinearity: 0.1,
    maxZoom: options.maxZoom || 14,
    paddingTopLeft,
    paddingBottomRight
  });

  return true;
}

function clearRouteLayers() {
  if (state.routeAnimationFrame) {
    cancelAnimationFrame(state.routeAnimationFrame);
  }

  state.routeAnimationFrame = null;
  state.routeAnimationToken += 1;
  routeLayerGroup.clearLayers();
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
  routeLayerGroup.clearLayers();

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
    removeRouteHeadMarker();
    return;
  }

  // Place / move the sport icon at the leading tip of the route trace
  const lastSeg = visibleSegments.at(-1);
  const headLatLng = lastSeg.at(-1);
  if (headLatLng) {
    if (state.routeHeadMarker) {
      state.routeHeadMarker.setLatLng(headLatLng);
    } else {
      const dotColor = traceColors[route.type] || traceColors.other;
      const divIcon = L.divIcon({
        className: "",
        html: `<div class="route-head-icon" style="--head-color:${dotColor}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
      state.routeHeadMarker = L.marker(headLatLng, { icon: divIcon, pane: "headPane" }).addTo(map);
    }
  }

  L.polyline(visibleSegments, {
    color,
    opacity: 1,
    pane: "routePane",
    weight: 4,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(routeLayerGroup);
}

function removeRouteHeadMarker() {
  if (state.routeHeadMarker) {
    state.routeHeadMarker.remove();
    state.routeHeadMarker = null;
  }
}

function traceDurationMs() {
  return Math.min(Math.max(Math.round(speedMs * 0.72), minimumTraceDurationMs), maximumTraceDurationMs);
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

  if (bounds.isValid()) {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function cellKeysBounds(cellKeys) {
  const bounds = L.latLngBounds([]);

  cellKeys.forEach((key) => {
    const cell = state.gridCells.get(key) || parseCellKey(key);
    bounds.extend(cellBounds(cell));
  });

  return bounds;
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
  gridLayerGroup.clearLayers();
  state.gridCells = allCellMap(state.routes);
  state.cellLayers = new Map();

  for (const [key, cell] of state.gridCells) {
    const layer = L.rectangle(cellBounds(cell), {
      className: "grid-cell",
      renderer: gridRenderer,
      pane: "gridPane",
      color: "#cbd5e1",
      fillColor: "#94a3b8",
      fillOpacity: 0.12,
      opacity: 0.35,
      weight: 1,
      interactive: false
    }).addTo(gridLayerGroup);

    state.cellLayers.set(key, layer);
  }
}

function renderGrid(completedCells) {
  for (const [key, layer] of state.cellLayers) {
    const completedCell = completedCells.get(key);

    if (completedCell) {
      const color = cellColor(completedCell);
      const intensity = cellIntensity(completedCell.visitCount);

      layer.setStyle({
        color,
        fillColor: color,
        fillOpacity: intensity,
        opacity: Math.min(intensity + 0.24, 0.95),
        weight: completedCell.visitCount > 1 ? 1.5 : 1.1
      });
    } else {
      layer.setStyle({
        color: "#cbd5e1",
        fillColor: "#94a3b8",
        fillOpacity: 0.12,
        opacity: 0.35,
        weight: 1
      });
    }
  }
}

function refreshGridStyles() {
  if (!state.completedCells) return;
  if (state.gridRefreshFrame) return;

  state.gridRefreshFrame = requestAnimationFrame(() => {
    state.gridRefreshFrame = null;
    renderGrid(state.completedCells);
  });
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

function cellKeyForPoint(point) {
  const projected = map.options.crs.project(L.latLng(point.latitude, point.longitude));
  const x = Math.floor(projected.x / gridCellMeters);
  const y = Math.floor(projected.y / gridCellMeters);

  return `${x}:${y}`;
}

function parseCellKey(key) {
  const [x, y] = key.split(":").map(Number);
  return { x, y };
}

function cellBounds(cell) {
  const southWest = map.options.crs.unproject(
    L.point(cell.x * gridCellMeters, cell.y * gridCellMeters)
  );
  const northEast = map.options.crs.unproject(
    L.point((cell.x + 1) * gridCellMeters, (cell.y + 1) * gridCellMeters)
  );

  return L.latLngBounds(southWest, northEast);
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
  walk: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-1.12 1.03-2.12 1-4.62-.03-2.72-1.49-6-4.5-6C14.63 7 14 8.8 14 10.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`
};

function showActivityCallout(route) {
  elements.calloutIcon.className = `callout-icon ${route.type} visible`;
  elements.calloutIcon.innerHTML = activityIcons[route.type] || "";
}

function hideActivityCallout() {
  elements.calloutIcon.classList.remove("visible");
}

boot();
