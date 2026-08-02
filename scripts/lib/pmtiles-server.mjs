// Serves MVT tiles straight out of local .pmtiles archives.
//
// The browser could read the archives itself with pmtiles' MapLibre protocol,
// but that glue never resolves against MapLibre 6 — tiles are requested and
// nothing ever comes back. Reading them here instead keeps the client on
// MapLibre's ordinary vector-tile path.

import { open } from "node:fs/promises";
import path from "node:path";
import { PMTiles } from "pmtiles";

class FileSource {
  constructor(filePath) {
    this.filePath = filePath;
    this.handle = null;
  }

  getKey() {
    return this.filePath;
  }

  async getBytes(offset, length) {
    this.handle ||= await open(this.filePath, "r");

    const buffer = Buffer.alloc(length);
    await this.handle.read(buffer, 0, length, offset);

    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length) };
  }
}

const archives = new Map();

function archiveFor(filePath) {
  if (!archives.has(filePath)) {
    archives.set(filePath, new PMTiles(new FileSource(filePath)));
  }

  return archives.get(filePath);
}

// /basemap/tiles/<archive>/<z>/<x>/<y>.mvt
const tilePattern = /^\/basemap\/tiles\/([\w.-]+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

export function isTileRequest(pathname) {
  return tilePattern.test(pathname);
}

export async function serveTile(basemapDir, pathname, response) {
  const match = tilePattern.exec(pathname);

  if (!match) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const [, name, z, x, y] = match;
  const filePath = path.join(basemapDir, name);

  if (!filePath.startsWith(basemapDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const tile = await archiveFor(filePath).getZxy(Number(z), Number(x), Number(y));

    if (!tile?.data) {
      // Missing tiles are normal at the edges of an extract
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/x-protobuf",
      "Content-Length": tile.data.byteLength
    });
    response.end(Buffer.from(tile.data));
  } catch (error) {
    console.warn(`Tile ${name} ${z}/${x}/${y} failed: ${error.message}`);
    response.writeHead(500);
    response.end();
  }
}
