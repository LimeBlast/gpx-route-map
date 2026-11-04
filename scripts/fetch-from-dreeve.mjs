// Downloads a month's original activity files from Dreeve into gpx/ (or GPX_DIR),
// named so build-routes.mjs classifies them: 2026-10-03-073000-Ride-<activity id>.fit
// Needs DREEVE_API_KEY (Dreeve → Settings → Security → API access), from .env or the environment.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gpxDir = path.resolve(rootDir, process.env.GPX_DIR || "gpx");
const baseUrl = (process.env.DREEVE_URL || "https://fitness.limeblast.co.uk") + "/api/v1";
const apiKey = process.env.DREEVE_API_KEY;
const month = process.env.MONTH || lastMonth();

// Dreeve sport type → the word build-routes.mjs recognises. Anything else (strength, yoga, …) isn't fetched.
const SPORTS = {
  Run: "Run", TrailRun: "Run",
  Ride: "Ride", GravelRide: "Ride", MountainBikeRide: "Ride",
  Walk: "Walk", Hike: "Walk",
  Swim: "Swim"
};

if (!apiKey) throw new Error("DREEVE_API_KEY is not set (put it in .env)");
if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`MONTH must be YYYY-MM, got ${month}`);

await mkdir(gpxDir, { recursive: true });
const activities = await monthActivities(month);
let fetched = 0;

for (const activity of activities) {
  const base = `${activity.startDateLocal.replaceAll(":", "").replace("T", "-")}-${SPORTS[activity.sportType]}-${activity.id.replace(/^activity-/, "")}`;
  const { fileImports } = await api(`/file-imports?filters[activityId]=${activity.id}`);
  const fileImport = fileImports.find((item) => item.hasFile);

  if (!fileImport) {
    console.warn(`No original file for ${activity.startDateLocal} ${activity.sportType} (${activity.id})`);
    continue;
  }

  const extension = path.extname(fileImport.filename).toLowerCase();
  if (![".fit", ".gpx"].includes(extension)) {
    console.warn(`Skipping ${fileImport.filename}: build-routes reads only .fit and .gpx`);
    continue;
  }

  const target = path.join(gpxDir, base + extension);
  if (await exists(target)) continue;

  const response = await request(`/file-imports/${fileImport.id}/file`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  fetched += 1;
}

console.log(`${month}: ${activities.length} activities in Dreeve, ${fetched} new files in ${path.relative(rootDir, gpxDir)}/`);

async function monthActivities(yyyyMm) {
  const [year, monthNumber] = yyyyMm.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const filters = `filters[from]=${yyyyMm}-01&filters[to]=${yyyyMm}-${lastDay}&filters[sportType]=${Object.keys(SPORTS).join(",")}`;
  const all = [];

  for (let page = 1; ; page += 1) {
    const { activities, pagination } = await api(`/activities?${filters}&pagination[size]=100&pagination[page]=${page}`);
    all.push(...activities);
    if (page >= pagination.totalPages) return all;
  }
}

async function api(pathAndQuery) {
  return (await request(pathAndQuery)).json();
}

async function request(pathAndQuery) {
  const response = await fetch(baseUrl + pathAndQuery, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Dreeve ${pathAndQuery}: ${response.status} ${await response.text()}`);
  return response;
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

function lastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
