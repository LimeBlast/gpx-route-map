import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Build once with no MONTH filter purely to find out which months gpx/ covers;
// each per-month render rebuilds routes.json for its own month anyway.
await run("npm", ["run", "build:routes"]);

const { routes } = JSON.parse(
  await readFile(path.join(rootDir, "public", "routes.json"), "utf8")
);
const months = [...new Set(routes.map((route) => route.date.slice(0, 7)))].sort();

if (!months.length) {
  console.error("No activities found in gpx/");
  process.exit(1);
}

// Cover every month's areas up front rather than discovering a gap eight
// renders in. No-op when the basemap already holds them.
await run("npm", ["run", "build:basemap"]);

console.log(`Rendering ${months.length} month(s): ${months.join(", ")}`);

for (const [index, month] of months.entries()) {
  console.log(`\n=== [${index + 1}/${months.length}] ${month} ===`);
  await run("node", ["scripts/render-instagram.mjs"], { MONTH: month });
}

console.log(`\nDone — ${months.length} video(s) in exports/`);

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...env }
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))
    );
  });
}
