import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

const urlParams = new URLSearchParams(window.location.search);
const isExportMode = urlParams.has("export");
const isPreviewMode = urlParams.has("preview");
const exportWidth = Number(urlParams.get("width") || 1080);
const exportHeight = Number(urlParams.get("height") || 1920);

if (isExportMode) {
  applyExportDimensions();
}

if (isExportMode) {
  document.body.classList.add("export-mode");
}

if (isPreviewMode) {
  document.body.classList.add("export-preview");
  updateExportPreviewScale();
}

const colors = {
  run: "#22c55e",
  ride: "#38bdf8",
  other: "#f97316",
  mixed: "#a855f7"
};

const traceColors = {
  run: "#14532d",
  ride: "#075985",
  other: "#7c2d12"
};

const gridCellMeters = 1000;
const minimumRevealDelayMs = 350;
const minimumTraceDurationMs = 800;
const maximumTraceDurationMs = 2000;
const postTraceHoldMs = 500;
const preRevealAfterPanMs = 200;
const panDurationSeconds = 1.0;
const finalOverviewDelayMs = 1400;
const finalClusterRadiusCells = 14;
const exportTitleDurationMs = Number(urlParams.get("titleMs") || 2800);
const defaultExportSpeedMs = 5200;
const defaultPreviewSpeedMs = 3600;

const state = {
  allRoutes: [],
  filteredRoutes: [],
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
  routeLayers: [],
  routeHeadMarker: null
};

const map = L.map("map", {
  zoomControl: false,
  scrollWheelZoom: true
}).setView([54.5, -3], 6);

L.control.zoom({ position: "bottomright" }).addTo(map);

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

const gridRenderer = isExportMode
  ? L.canvas({ pane: "gridPane", padding: 1 })
  : L.svg({ pane: "gridPane", padding: 1 });
const gridLayerGroup = L.layerGroup().addTo(map);
const routeLayerGroup = L.layerGroup().addTo(map);

const elements = {
  activityFilter: document.querySelector("#activity-filter"),
  cinematicPan: document.querySelector("#cinematic-pan"),
  currentDate: document.querySelector("#current-date"),
  emptyState: document.querySelector("#empty-state"),
  exportCurrentDate: document.querySelector("#export-current-date"),
  activityCallout: document.querySelector("#export-activity-callout"),
  calloutIcon: document.querySelector("#callout-icon"),
  exportEndActivities: document.querySelector("#export-end-activities"),
  exportEndCard: document.querySelector("#export-end-card"),
  exportEndRunDistance: document.querySelector("#export-end-run-distance"),
  exportEndRunCount: document.querySelector("#export-end-run-count"),
  exportEndRideDistance: document.querySelector("#export-end-ride-distance"),
  exportEndRideCount: document.querySelector("#export-end-ride-count"),
  exportEndSquares: document.querySelector("#export-end-squares"),
  exportEndTitle: document.querySelector("#export-end-title"),
  exportKicker: document.querySelector("#export-kicker"),
  exportRouteCount: document.querySelector("#export-route-count"),
  exportSubtitle: document.querySelector("#export-subtitle"),
  exportTitle: document.querySelector("#export-title"),
  exportTitleCard: document.querySelector("#export-title-card"),
  exportTotalDistance: document.querySelector("#export-total-distance"),
  instagramPreviewButtons: document.querySelectorAll(".instagram-preview-button"),
  instagramCurrentSpeedButton: document.querySelector("#instagram-current-speed-button"),
  playButton: document.querySelector("#play-button"),
  resetButton: document.querySelector("#reset-button"),
  routeCount: document.querySelector("#route-count"),
  routeList: document.querySelector("#route-list"),
  showRouteTrace: document.querySelector("#show-route-trace"),
  speed: document.querySelector("#speed"),
  timeline: document.querySelector("#timeline"),
  totalDistance: document.querySelector("#total-distance")
};

async function boot() {
  try {
    const response = await fetch("/routes.json");

    if (!response.ok) {
      throw new Error(`Could not load routes.json: ${response.status}`);
    }

    const data = await response.json();
    state.allRoutes = Array.isArray(data.routes) ? data.routes : [];
    state.allRoutes.sort((left, right) => new Date(left.date) - new Date(right.date));
    state.allRoutes.forEach((route) => {
      route.segments = normalizedRouteSegments(route);
      route.cells = routeCellKeys(route);
    });

    await waitForMapLayout();
    bindControls();
    applyExportDefaults();
    applyFilter();
    const monthLabel = routesMonthLabel(state.allRoutes);
    if (monthLabel) {
      const sidebarTitle = document.querySelector("#sidebar-title");
      if (sidebarTitle) sidebarTitle.textContent = `${monthLabel} · Running & Cycling`;
    }
    exposeAppControls();
    applyAutoplay();
  } catch (error) {
    console.error(error);
    elements.emptyState.hidden = false;
  }
}

function bindControls() {
  window.addEventListener("resize", () => {
    updateExportPreviewScale();
    map.invalidateSize();
    refreshGridStyles();
  });

  map.on("movestart move zoomstart zoom zoomend moveend", refreshGridStyles);
  map.on("zoomend moveend", () => {
    window.setTimeout(refreshGridStyles, 60);
  });

  elements.activityFilter.addEventListener("change", () => {
    pause();
    applyFilter();
  });

  elements.timeline.addEventListener("input", () => {
    pause();
    state.index = Number(elements.timeline.value);
    render();
  });

  elements.playButton.addEventListener("click", () => {
    state.isPlaying ? pause() : play();
  });

  elements.resetButton.addEventListener("click", () => {
    pause();
    state.index = -1;
    render();
    fitAllRoutes();
  });

  elements.instagramPreviewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      openInstagramPreview({
        height: Number(button.dataset.height),
        speed: defaultPreviewSpeedMs,
        width: Number(button.dataset.width)
      });
    });
  });

  elements.instagramCurrentSpeedButton.addEventListener("click", () => {
    openInstagramPreview({
      height: exportHeight,
      speed: Number(elements.speed.value),
      width: exportWidth
    });
  });

  elements.showRouteTrace.addEventListener("change", render);
}

function openInstagramPreview({ height, speed, width }) {
  const previewUrl = new URL(window.location.href);
  previewUrl.searchParams.set("export", "1");
  previewUrl.searchParams.set("preview", "1");
  previewUrl.searchParams.set("autoplay", "1");
  previewUrl.searchParams.set("speed", String(speed));
  previewUrl.searchParams.set("width", String(width));
  previewUrl.searchParams.set("height", String(height));
  previewUrl.searchParams.delete("activity");

  window.open(previewUrl.toString(), "_blank", "noopener,noreferrer");
}

function applyExportDimensions() {
  document.documentElement.style.setProperty("--export-width", `${exportWidth}px`);
  document.documentElement.style.setProperty("--export-height", `${exportHeight}px`);
}

function updateExportPreviewScale() {
  if (!isPreviewMode) return;

  const scale = Math.min(window.innerWidth / exportWidth, window.innerHeight / exportHeight);
  document.documentElement.style.setProperty("--export-preview-scale", String(scale));
}

function routesMonthLabel(routes) {
  if (routes.length === 0) return null;
  return new Date(routes[0].date).toLocaleString("en-GB", { month: "long", year: "numeric" });
}

function applyExportDefaults() {
  if (!isExportMode) return;

  const monthLabel = routesMonthLabel(state.allRoutes);
  const speedValue = Number(urlParams.get("speed") || (isPreviewMode ? defaultPreviewSpeedMs : defaultExportSpeedMs));
  elements.speed.max = String(Math.max(speedValue, Number(elements.speed.max)));
  elements.speed.value = String(speedValue);
  elements.exportTitle.textContent = urlParams.get("title") || "Running & Cycling";
  elements.exportSubtitle.textContent = urlParams.get("subtitle") || "Every square unlocked, one activity at a time.";
  elements.exportKicker.textContent = urlParams.get("kicker") || monthLabel || "Route Progress";
}

function applyAutoplay() {
  if (!urlParams.has("autoplay")) return;

  window.setTimeout(play, 150);
}

function applyFilter() {
  const activity = elements.activityFilter.value;

  state.filteredRoutes = activity === "all"
    ? state.allRoutes
    : state.allRoutes.filter((route) => route.type === activity);

  state.index = clampTimelineIndex(state.index);
  state.cameraTargetKey = "";
  elements.timeline.min = "-1";
  elements.timeline.max = Math.max(state.filteredRoutes.length - 1, 0);
  elements.timeline.disabled = state.filteredRoutes.length === 0;
  elements.emptyState.hidden = state.filteredRoutes.length > 0;

  buildGrid();
  render();
  fitAllRoutes();
}

function exposeAppControls() {
  window.routeProgressApp = {
    play,
    pause,
    showEndCard() {
      showExportEndCard();
    },
    reset() {
      pause();
      state.index = -1;
      state.cameraTargetKey = "";
      render();
      fitAllRoutes();
    },
    state() {
      return {
        index: state.index,
        isEnded: document.body.classList.contains("export-ended"),
        isComplete: state.index >= state.filteredRoutes.length - 1,
        isPlaying: state.isPlaying,
        routeCount: state.filteredRoutes.length
      };
    }
  };

  window.dispatchEvent(new CustomEvent("route-progress-ready"));
}

function play() {
  if (state.filteredRoutes.length === 0) return;

  state.isPlaying = true;
  document.body.classList.remove("export-ended");
  elements.playButton.textContent = "Pause";

  if (state.index >= state.filteredRoutes.length - 1) {
    state.index = -1;
    render();
    fitAllRoutes();
  }

  if (isExportMode && state.index === -1 && !document.body.classList.contains("export-started")) {
    document.body.classList.add("export-started");
    state.timer = window.setTimeout(tick, exportTitleDurationMs);
  } else {
    document.body.classList.add("export-started");
    tick();
  }
}

function clampTimelineIndex(index) {
  return Math.min(Math.max(index, -1), Math.max(state.filteredRoutes.length - 1, -1));
}

function tick() {
  if (!state.isPlaying) return;

  hideActivityCallout();

  if (state.index >= state.filteredRoutes.length - 1) {
    state.timer = window.setTimeout(() => {
      if (!state.isPlaying) return;

      clearRouteLayers();
      showFinalOverview();
      pause();
    }, finalOverviewDelayMs);
    return;
  }

  const nextIndex = state.index + 1;
  clearRouteLayers();
  const cameraMoved = focusPlaybackView(nextIndex);
  const followUpDelayMs = postRevealDelayMs();

  const revealRoute = () => {
    if (!state.isPlaying) return;

    state.index = nextIndex;
    render();
    showActivityCallout(state.filteredRoutes[nextIndex]);

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

function showFinalOverview() {
  const bounds = densestClusterBounds();

  if (bounds.isValid()) {
    moveToBounds(bounds, { key: "final-overview", maxZoom: 12, force: true, padding: [96, 96] });
  }
}

function pause() {
  state.isPlaying = false;
  elements.playButton.textContent = "Play";
  window.clearTimeout(state.timer);
}

function showExportEndCard() {
  if (!isExportMode) return;

  updateExportEndCard();
  document.body.classList.add("export-ended");
}

function postRevealDelayMs() {
  if (elements.showRouteTrace.checked) {
    return traceDurationMs() + Math.max(Number(elements.speed.value) * 0.2, postTraceHoldMs);
  }

  return Math.max(Number(elements.speed.value) * 0.45, minimumRevealDelayMs);
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

  const visibleRoutes = state.filteredRoutes.slice(0, state.index + 1);
  const latestRoute = visibleRoutes.at(-1);
  const previousRoutes = latestRoute ? visibleRoutes.slice(0, -1) : visibleRoutes;
  const visibleDistance = visibleRoutes.reduce((sum, route) => sum + route.distanceKm, 0);
  const completedCells = latestRoute && elements.showRouteTrace.checked
    ? completedCellMap(previousRoutes)
    : completedCellMap(visibleRoutes);

  state.completedCells = completedCells;
  renderGrid(completedCells);
  if (latestRoute && elements.showRouteTrace.checked) {
    renderAnimatedRouteTrace(latestRoute, completedCells);
  }

  elements.routeCount.textContent = String(completedCells.size);
  elements.totalDistance.textContent = `${visibleDistance.toFixed(1)} km`;
  elements.currentDate.textContent = latestRoute ? formatDate(latestRoute.date) : "—";
  elements.exportRouteCount.textContent = String(completedCells.size);
  elements.exportTotalDistance.textContent = `${visibleDistance.toFixed(1)} km`;
  elements.exportCurrentDate.textContent = latestRoute ? formatDate(latestRoute.date) : "—";
  updateExportEndCard();
  elements.timeline.value = String(state.index);
  renderRouteList(visibleRoutes, latestRoute);
}

function updateExportEndCard() {
  const visibleRoutes = state.filteredRoutes.slice(0, Math.max(state.index + 1, 0));
  const routeSource = visibleRoutes.length > 0 ? visibleRoutes : state.filteredRoutes;
  const completedCells = visibleRoutes.length > 0 ? state.completedCells : allCellMap(state.filteredRoutes);
  const runs = routeSource.filter((route) => route.type === "run");
  const rides = routeSource.filter((route) => route.type === "ride");
  const runDistance = runs.reduce((sum, route) => sum + route.distanceKm, 0);
  const rideDistance = rides.reduce((sum, route) => sum + route.distanceKm, 0);

  elements.exportEndTitle.textContent = urlParams.get("endTitle") || routesMonthLabel(state.allRoutes) || "Progress unlocked";
  elements.exportEndActivities.textContent = String(routeSource.length);
  elements.exportEndSquares.textContent = String(completedCells.size);
  elements.exportEndRunDistance.textContent = `${runDistance.toFixed(1)} km`;
  elements.exportEndRunCount.textContent = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
  elements.exportEndRideDistance.textContent = `${rideDistance.toFixed(1)} km`;
  elements.exportEndRideCount.textContent = `${rides.length} ${rides.length === 1 ? "ride" : "rides"}`;
}

function updateVisibleSquareCounts(completedCells) {
  elements.routeCount.textContent = String(completedCells.size);
  elements.exportRouteCount.textContent = String(completedCells.size);
  updateExportEndCard();
}

function updateVisibleDistance(distanceKm) {
  const text = `${distanceKm.toFixed(1)} km`;
  elements.totalDistance.textContent = text;
  elements.exportTotalDistance.textContent = text;
}

function focusPlaybackView(targetIndex = state.index) {
  if (!elements.cinematicPan.checked || state.filteredRoutes.length === 0) return false;

  const visibleRoutes = state.filteredRoutes.slice(0, targetIndex + 1);
  const latestRoute = visibleRoutes.at(-1);

  if (!latestRoute) return false;

  const latestBounds = cellKeysBounds(latestRoute.cells);

  if (!latestBounds.isValid()) return false;

  return moveToBounds(latestBounds, { key: `route:${latestRoute.id}`, maxZoom: 14 });
}

function moveToBounds(bounds, options = {}) {
  if (options.key && state.cameraTargetKey === options.key) return false;

  state.cameraTargetKey = options.key || "";
  map.stop();

  const targetZoom = map.getBoundsZoom(bounds, false, [72, 72]);
  const cappedTargetZoom = Math.min(targetZoom, options.maxZoom || 14);

  if (!options.force && map.getBounds().pad(-0.15).contains(bounds) && map.getZoom() >= cappedTargetZoom) {
    refreshGridStyles();
    return false;
  }

  const padding = options.padding || (isExportMode
    ? { topLeft: [72, 240], bottomRight: [72, 420] }
    : { topLeft: [72, 72], bottomRight: [72, 72] });

  map.flyToBounds(bounds, {
    animate: true,
    duration: panDurationSeconds,
    easeLinearity: 0.1,
    maxZoom: options.maxZoom || 14,
    paddingTopLeft: Array.isArray(padding) ? padding : padding.topLeft,
    paddingBottomRight: Array.isArray(padding) ? padding : padding.bottomRight
  });

  return true;
}

function renderRouteList(visibleRoutes, latestRoute) {
  elements.routeList.replaceChildren(
    ...visibleRoutes.slice(-8).reverse().map((route) => {
      const item = document.createElement("li");
      item.className = latestRoute?.id === route.id ? "active" : "";
      item.innerHTML = `
        <span class="route-type ${route.type}">${route.type}</span>
        <span class="route-name">${escapeHtml(route.name)}</span>
        <span class="route-meta">${formatDate(route.date)} · ${route.distanceKm.toFixed(1)} km</span>
      `;
      return item;
    })
  );
}

function clearRouteLayers() {
  if (state.routeAnimationFrame) {
    cancelAnimationFrame(state.routeAnimationFrame);
  }

  state.routeAnimationFrame = null;
  state.routeAnimationToken += 1;
  routeLayerGroup.clearLayers();
  state.routeLayers = [];
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
  updateVisibleDistance(
    state.filteredRoutes.slice(0, state.index).reduce((sum, r) => sum + r.distanceKm, 0) +
      targetDistanceMeters / 1000
  );

  if (visibleSegments.length === 0) {
    removeRouteHeadMarker();
    return;
  }

  // Place / move the sport icon at the leading tip of the route trace
  const lastSeg = visibleSegments.at(-1);
  const headLatLng = lastSeg.at(-1);
  if (headLatLng) {
    const dotColor = traceColors[route.type] || traceColors.other;
    const divIcon = L.divIcon({
      className: "",
      html: `<div class="route-head-icon" style="--head-color:${dotColor}"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    if (state.routeHeadMarker) {
      state.routeHeadMarker.setLatLng(headLatLng).setIcon(divIcon);
    } else {
      state.routeHeadMarker = L.marker(headLatLng, { icon: divIcon, pane: "headPane" }).addTo(map);
    }
  }

  const layer = L.polyline(visibleSegments, {
    color,
    opacity: 1,
    pane: "routePane",
    weight: 4,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(routeLayerGroup);

  layer.bindPopup(popupFor(route));
  state.routeLayers = [layer];
}

function removeRouteHeadMarker() {
  if (state.routeHeadMarker) {
    state.routeHeadMarker.remove();
    state.routeHeadMarker = null;
  }
}

function traceDurationMs() {
  return Math.min(
    Math.max(Math.round(Number(elements.speed.value) * 0.72), minimumTraceDurationMs),
    maximumTraceDurationMs
  );
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

function routesBounds(routes) {
  const bounds = L.latLngBounds([]);

  routes.forEach((route) => bounds.extend(routeBounds(route)));

  return bounds;
}

function routeBounds(route) {
  const bounds = L.latLngBounds([]);

  route.segments.forEach((segment) => {
    segment.forEach((point) => {
      bounds.extend(point);
    });
  });

  return bounds;
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
  state.gridCells = allCellMap(state.filteredRoutes);
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

function popupFor(route) {
  return `
    <strong>${escapeHtml(route.name)}</strong><br />
    ${formatDate(route.date)}<br />
    ${route.type} · ${route.distanceKm.toFixed(1)} km
  `;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  ride: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`
};

function showActivityCallout(route) {
  elements.calloutIcon.className = `callout-icon ${route.type}`;
  elements.calloutIcon.innerHTML = activityIcons[route.type] || "";
  elements.activityCallout.classList.add("visible");
}

function hideActivityCallout() {
  elements.activityCallout.classList.remove("visible");
}

boot();
