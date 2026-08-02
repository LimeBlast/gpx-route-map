import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".pbf": "application/x-protobuf",
  ".pmtiles": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

export function contentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// PMTiles reads archives with HTTP range requests, so byte serving is required
// — without it the client rejects the response outright.
export async function serveFile(filePath, request, response) {
  let size;

  try {
    ({ size } = await stat(filePath));
  } catch {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || "");

  if (!range) {
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": size,
      "Accept-Ranges": "bytes"
    });
    createReadStream(filePath).pipe(response);
    return;
  }

  const [, rawStart, rawEnd] = range;
  const start = rawStart === "" ? Math.max(size - Number(rawEnd), 0) : Number(rawStart);
  const end = rawStart === "" || rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (start >= size || start > end) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    "Content-Type": contentType(filePath),
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Accept-Ranges": "bytes"
  });
  createReadStream(filePath, { start, end }).pipe(response);
}
