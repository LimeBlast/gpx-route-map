// Pulls Protomaps basemap extracts covering the areas the routes actually
// visit, so rendering needs no network at all.
//
//   npm run build:routes && node scripts/fetch-basemap.mjs
//
// Requires the pmtiles CLI (brew install pmtiles). Extracts are read straight
// out of the 137GB planet build over HTTP range requests — nothing that large
// is ever downloaded.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { padBounds, routeClusters } from "./lib/bounds.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basemapDir = path.join(rootDir, "basemap"); // outside public/ so vite does not copy 180MB into dist
const routesPath = path.join(rootDir, "public", "routes.json");
const manifestPath = path.join(basemapDir, "basemap.json");
const clusterJoinDegrees = Number(process.env.CLUSTER_JOIN_DEGREES || 0.35);
const clusterPadDegrees = Number(process.env.CLUSTER_PAD_DEGREES || 0.25);
const maxZoom = Number(process.env.BASEMAP_MAX_ZOOM || 14);
const minZoom = Number(process.env.BASEMAP_MIN_ZOOM || 0);
const worldMaxZoom = Number(process.env.BASEMAP_WORLD_MAX_ZOOM || 5);

const { routes } = JSON.parse(await readFile(routesPath, "utf8"));
const clusters = routeClusters(routes, clusterJoinDegrees).map((cluster) =>
  padBounds(cluster, clusterPadDegrees)
);

if (clusters.length === 0) {
  console.error("No located routes in routes.json — run build:routes first.");
  process.exit(1);
}

// Areas already on disk are kept, so running this for one month never throws
// away the areas the other months need. FORCE_BASEMAP_REBUILD=1 starts over.
const kept = process.env.FORCE_BASEMAP_REBUILD === "1" ? [] : await existingExtracts();
const keptAreas = kept.filter((extract) => extract.name !== "world.pmtiles");
const worldKept = kept.find((extract) => extract.name === "world.pmtiles");
const missing = missingAreas(clusters, keptAreas);

console.log(`${clusters.length} area${clusters.length === 1 ? "" : "s"} of activity to cover:`);
clusters.forEach((cluster, index) => {
  console.log(`  ${index + 1}. ${formatBounds(cluster)}`);
});
console.log(
  `Already downloaded: ${keptAreas.length} area(s)${worldKept ? " + world" : ""}. ` +
    `To fetch: ${missing.length} area(s)${worldKept ? "" : " + world"}.`
);

if (!missing.length && worldKept) {
  console.log("\nBasemap already covers every route — nothing to fetch.");
  process.exit(0);
}

const build = process.env.BASEMAP_BUILD || (await latestBuild());
const source = `https://build.protomaps.com/${build}.pmtiles`;

console.log(`Planet build: ${build}`);
await mkdir(basemapDir, { recursive: true });

const extracts = [];

// A coarse whole-world layer underneath, so zoomed-out views and the flights
// between areas show real land rather than empty background
if (worldKept) {
  extracts.push(worldKept);
} else {
  const worldPath = path.join(basemapDir, "world.pmtiles");
  console.log(`\nExtracting world.pmtiles (z0-${worldMaxZoom})...`);
  await run("pmtiles", ["extract", source, worldPath, `--minzoom=0`, `--maxzoom=${worldMaxZoom}`]);
  const worldStat = await stat(worldPath);
  console.log(`  world.pmtiles: ${(worldStat.size / 1024 / 1024).toFixed(1)} MB`);
  extracts.push({
    name: "world.pmtiles",
    bounds: { west: -180, south: -85, east: 180, north: 85 },
    maxZoom: worldMaxZoom,
    bytes: worldStat.size
  });
}

extracts.push(...keptAreas.filter((area) => !missing.some((entry) => entry.replaces.includes(area))));

for (const { bounds, replaces } of missing) {
  const name = `area-${nextAreaIndex()}.pmtiles`;
  const outputPath = path.join(basemapDir, name);
  const bbox = `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;

  console.log(`\nExtracting ${name} (${formatBounds(bounds)})...`);
  await run("pmtiles", [
    "extract",
    source,
    outputPath,
    `--bbox=${bbox}`,
    `--minzoom=${minZoom}`,
    `--maxzoom=${maxZoom}`
  ]);

  const { size } = await stat(outputPath);
  console.log(`  ${name}: ${(size / 1024 / 1024).toFixed(1)} MB`);
  extracts.push({ name, bounds, maxZoom, bytes: size });

  // The widened extract covers everything the areas it grew out of held
  for (const replaced of replaces) {
    await rm(path.join(basemapDir, replaced.name), { force: true });
  }
}

await fetchGlyphs();

await writeFile(
  manifestPath,
  `${JSON.stringify({ build, extracts }, null, 2)}\n`
);

const totalBytes = extracts.reduce((sum, extract) => sum + extract.bytes, 0);
console.log(`\nWrote ${extracts.length} extract(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
console.log(`Manifest: ${path.relative(rootDir, manifestPath)}`);

// Manifest entries whose .pmtiles file is actually still on disk
async function existingExtracts() {
  try {
    const { extracts } = JSON.parse(await readFile(manifestPath, "utf8"));
    const present = [];

    for (const extract of extracts) {
      try {
        await stat(path.join(basemapDir, extract.name));
        present.push(extract);
      } catch {
        console.log(`  ${extract.name} listed in the manifest but missing — refetching`);
      }
    }

    return present;
  } catch {
    return [];
  }
}

// Clusters already inside an existing area need nothing. One that only partly
// overlaps is widened to the union and refetched, rather than added alongside,
// so overlapping extracts never draw the same labels twice.
function missingAreas(wanted, areas) {
  const missing = [];

  for (const cluster of wanted) {
    if (areas.some((area) => contains(area.bounds, cluster))) continue;

    const replaces = areas.filter((area) => intersects(area.bounds, cluster));
    missing.push({
      bounds: replaces.reduce((merged, area) => union(merged, area.bounds), cluster),
      replaces
    });
  }

  return missing;
}

function contains(outer, inner) {
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= inner.south &&
    outer.north >= inner.north
  );
}

function intersects(a, b) {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function union(a, b) {
  return {
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north)
  };
}

// Never reuses a name still in the manifest, so a widened area lands in a new
// file and the old one can be deleted afterwards
function nextAreaIndex() {
  const used = new Set(
    [...kept, ...extracts].map((extract) => Number(extract.name.match(/^area-(\d+)\.pmtiles$/)?.[1]))
  );

  for (let index = 1; ; index += 1) {
    if (!used.has(index)) return index;
  }
}

// Label glyphs, so rendering needs nothing from the network at all
async function fetchGlyphs() {
  const fontstacks = ["Noto Sans Regular", "Noto Sans Italic", "Noto Sans Medium"];
  const ranges = ["0-255", "256-511", "512-767", "768-1023", "8192-8447"];
  let written = 0;

  for (const fontstack of fontstacks) {
    for (const range of ranges) {
      const target = path.join(basemapDir, "fonts", fontstack, `${range}.pbf`);

      try {
        await stat(target);
        continue;
      } catch {
        // not fetched yet
      }

      const response = await fetch(
        `https://protomaps.github.io/basemaps-assets/fonts/${encodeURIComponent(fontstack)}/${range}.pbf`
      );

      if (!response.ok) continue;

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
      written += 1;
    }
  }

  console.log(`Glyphs: ${written} font range(s) fetched`);
}

// Builds are daily but not every date exists, so walk back until one responds
async function latestBuild() {
  for (let daysAgo = 1; daysAgo <= 21; daysAgo += 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    const stamp = date.toISOString().slice(0, 10).replaceAll("-", "");
    const response = await fetch(`https://build.protomaps.com/${stamp}.pmtiles`, {
      headers: { Range: "bytes=0-16" }
    });

    if (response.ok) return stamp;
  }

  throw new Error("Could not find a recent Protomaps planet build");
}

function formatBounds(bounds) {
  return `${bounds.west.toFixed(2)},${bounds.south.toFixed(2)} → ${bounds.east.toFixed(2)},${bounds.north.toFixed(2)}`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit" });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}
