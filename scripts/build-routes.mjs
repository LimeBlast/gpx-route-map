import { DOMParser } from "@xmldom/xmldom";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gpxDir = path.join(rootDir, "gpx");
const outputPath = path.join(rootDir, "public", "routes.json");
const overridesPath = path.join(rootDir, "activity-overrides.json");
const trimMeters = Number(process.env.TRIM_METERS || 0);
const maxLineGapMeters = Number(process.env.MAX_LINE_GAP_METERS || 2500);
const monthFilter = process.env.MONTH || ""; // e.g. "2025-05" to include only that month
const supportedExtensions = new Set([".fit", ".gpx"]);
const activityOverrides = await readActivityOverrides();

const files = (await readdir(gpxDir))
  .filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()))
  .sort((left, right) => left.localeCompare(right));

const routes = [];

for (const file of files) {
  const filePath = path.join(gpxDir, file);
  const route = await readRoute(filePath, file);

  if (route.points.length < 2) {
    console.warn(`Skipping ${file}: fewer than 2 track points`);
    continue;
  }

  const trimmedPoints = trimMeters > 0 ? trimRoute(route.points, trimMeters) : route.points;

  if (trimmedPoints.length < 2) {
    console.warn(`Skipping ${file}: fewer than 2 points after trimming`);
    continue;
  }

  const fileStats = await stat(filePath);
  const firstPointTime = trimmedPoints.find((point) => point.time)?.time;
  const date = firstPointTime || route.date || fileStats.mtime.toISOString();
  const segments = splitTrackSegments(trimmedPoints);
  const distanceKm = segments.reduce((sum, segment) => sum + distanceInKm(segment), 0);
  const type = activityOverrides[file] || route.type || inferType(file, route.name);

  if (!["run", "ride"].includes(type)) {
    console.warn(`Skipping ${file}: not a run or ride`);
    continue;
  }

  if (monthFilter && !dateIsInMonth(date, monthFilter)) {
    continue;
  }

  routes.push({
    id: slugify(file.replace(/\.(fit|gpx)$/i, "")),
    file,
    name: route.name,
    type,
    date,
    distanceKm: round(distanceKm, 3),
    pointCount: trimmedPoints.length,
    segmentCount: segments.length,
    segments: segments.map((segment) => segment.map((point) => [point.longitude, point.latitude])),
    coordinates: trimmedPoints.map((point) => [point.longitude, point.latitude])
  });
}

routes.sort((left, right) => new Date(left.date) - new Date(right.date));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    { generatedAt: new Date().toISOString(), trimMeters, maxLineGapMeters, routes },
    null,
    2
  )}\n`
);

console.log(`Wrote ${routes.length} routes to ${path.relative(rootDir, outputPath)}`);

async function readRoute(filePath, file) {
  const extension = path.extname(file).toLowerCase();

  if (extension === ".fit") {
    return readFitRoute(await readFile(filePath), file);
  }

  return readGpxRoute(await readFile(filePath, "utf8"), file);
}

async function readActivityOverrides() {
  try {
    return JSON.parse(await readFile(overridesPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function readGpxRoute(xml, file) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const name = readText(document, "name") || titleFromFile(file);

  return {
    name,
    type: inferType(file, name),
    date: readText(document, "time"),
    points: readGpxTrackPoints(document)
  };
}

function readGpxTrackPoints(document) {
  return Array.from(document.getElementsByTagName("trkpt"))
    .map((node) => ({
      latitude: Number(node.getAttribute("lat")),
      longitude: Number(node.getAttribute("lon")),
      elevation: Number(readChildText(node, "ele")),
      time: readChildText(node, "time")
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function readFitRoute(buffer, file) {
  const messages = readFitMessages(buffer);
  const points = messages.records
    .map((record) => ({
      latitude: semicirclesToDegrees(record.position_lat),
      longitude: semicirclesToDegrees(record.position_long),
      time: fitTimestampToIso(record.timestamp)
    }))
    .filter(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180
    );
  const name = titleFromFile(file);

  return {
    name,
    type: inferType(file, name, messages.sport),
    date: points.find((point) => point.time)?.time || fitTimestampToIso(messages.timestamp),
    points
  };
}

function readFitMessages(buffer) {
  const headerSize = buffer.readUInt8(0);
  const dataSize = buffer.readUInt32LE(4);
  const dataStart = headerSize;
  const dataEnd = dataStart + dataSize;
  const definitions = new Map();
  const records = [];
  const messages = { records, sport: "", timestamp: null };

  let offset = dataStart;
  let timestampAccumulator = null;

  while (offset < dataEnd) {
    const header = buffer.readUInt8(offset);
    offset += 1;

    const isCompressedTimestamp = (header & 0x80) !== 0;
    const isDefinition = (header & 0x40) !== 0;
    const hasDeveloperFields = (header & 0x20) !== 0;
    const localMessageType = isCompressedTimestamp ? (header >> 5) & 0x03 : header & 0x0f;

    if (isDefinition) {
      const definition = readFitDefinition(buffer, offset, hasDeveloperFields);
      definitions.set(localMessageType, definition.message);
      offset = definition.offset;
      continue;
    }

    const definition = definitions.get(localMessageType);

    if (!definition) {
      throw new Error(`FIT file references missing local message ${localMessageType}`);
    }

    const parsed = readFitDataMessage(buffer, offset, definition);
    offset = parsed.offset;

    if (isCompressedTimestamp && parsed.values.timestamp == null && timestampAccumulator != null) {
      parsed.values.timestamp = expandCompressedTimestamp(timestampAccumulator, header & 0x1f);
    }

    if (parsed.values.timestamp != null) {
      timestampAccumulator = parsed.values.timestamp;
    }

    if (definition.globalMessageNumber === 20) {
      if (parsed.values.position_lat != null && parsed.values.position_long != null) {
        records.push(parsed.values);
      }
    } else if (definition.globalMessageNumber === 18) {
      messages.sport ||= sportName(parsed.values.sport);
      messages.timestamp ||= parsed.values.timestamp;
    } else if (definition.globalMessageNumber === 34) {
      messages.timestamp ||= parsed.values.timestamp;
    }
  }

  return messages;
}

function readFitDefinition(buffer, offset, hasDeveloperFields) {
  offset += 1;
  const littleEndian = buffer.readUInt8(offset) === 0;
  offset += 1;

  const globalMessageNumber = readUnsigned(buffer, offset, 2, littleEndian);
  offset += 2;

  const fieldCount = buffer.readUInt8(offset);
  offset += 1;

  const fields = [];

  for (let index = 0; index < fieldCount; index += 1) {
    fields.push({
      number: buffer.readUInt8(offset),
      size: buffer.readUInt8(offset + 1),
      baseType: buffer.readUInt8(offset + 2)
    });
    offset += 3;
  }

  const developerFields = [];

  if (hasDeveloperFields) {
    const developerFieldCount = buffer.readUInt8(offset);
    offset += 1;

    for (let index = 0; index < developerFieldCount; index += 1) {
      developerFields.push({ size: buffer.readUInt8(offset + 1) });
      offset += 3;
    }
  }

  return {
    offset,
    message: { globalMessageNumber, littleEndian, fields, developerFields }
  };
}

function readFitDataMessage(buffer, offset, definition) {
  const values = {};

  for (const field of definition.fields) {
    const value = readFitFieldValue(buffer, offset, field, definition.littleEndian);
    const fieldName = fitFieldName(definition.globalMessageNumber, field.number);

    if (fieldName) {
      values[fieldName] = value;
    }

    offset += field.size;
  }

  for (const field of definition.developerFields) {
    offset += field.size;
  }

  return { offset, values };
}

function readFitFieldValue(buffer, offset, field, littleEndian) {
  const baseType = field.baseType & 0x1f;

  if (baseType === 7) {
    return buffer
      .subarray(offset, offset + field.size)
      .toString("utf8")
      .replace(/\0.*$/u, "")
      .trim();
  }

  return readFitScalar(buffer, offset, Math.min(field.size, baseTypeSize(baseType)), baseType, littleEndian);
}

function readFitScalar(buffer, offset, size, baseType, littleEndian) {
  if (size <= 0) return null;

  switch (baseType) {
    case 0:
    case 2:
    case 10:
    case 13:
      return buffer.readUInt8(offset);
    case 1:
      return buffer.readInt8(offset);
    case 3:
      return littleEndian ? buffer.readInt16LE(offset) : buffer.readInt16BE(offset);
    case 4:
    case 11:
      return readUnsigned(buffer, offset, 2, littleEndian);
    case 5:
      return littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset);
    case 6:
    case 12:
      return readUnsigned(buffer, offset, 4, littleEndian);
    case 8:
      return littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset);
    case 9:
      return littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset);
    default:
      return null;
  }
}

function readUnsigned(buffer, offset, size, littleEndian) {
  return littleEndian ? buffer.readUIntLE(offset, size) : buffer.readUIntBE(offset, size);
}

function baseTypeSize(baseType) {
  if ([0, 1, 2, 10, 13].includes(baseType)) return 1;
  if ([3, 4, 11].includes(baseType)) return 2;
  if ([5, 6, 8, 12].includes(baseType)) return 4;
  if ([9, 14, 15, 16].includes(baseType)) return 8;
  return 0;
}

function fitFieldName(globalMessageNumber, fieldNumber) {
  if (globalMessageNumber === 20) {
    return {
      0: "position_lat",
      1: "position_long",
      253: "timestamp"
    }[fieldNumber];
  }

  if (globalMessageNumber === 18) {
    return {
      5: "sport",
      253: "timestamp"
    }[fieldNumber];
  }

  if (globalMessageNumber === 34) {
    return {
      253: "timestamp"
    }[fieldNumber];
  }

  return null;
}

function sportName(value) {
  return {
    1: "run",
    2: "ride"
  }[value] || "";
}

function expandCompressedTimestamp(previousTimestamp, compressedOffset) {
  const candidate = (previousTimestamp & ~0x1f) + compressedOffset;
  return candidate <= previousTimestamp ? candidate + 0x20 : candidate;
}

function semicirclesToDegrees(value) {
  return typeof value === "number" ? (value * 180) / 2 ** 31 : null;
}

function fitTimestampToIso(value) {
  if (typeof value !== "number") return "";

  const fitEpochUnixSeconds = 631_065_600;
  return new Date((value + fitEpochUnixSeconds) * 1000).toISOString();
}

function readText(document, tagName) {
  const node = document.getElementsByTagName(tagName)[0];
  return node?.textContent?.trim() || "";
}

function readChildText(node, tagName) {
  const child = node.getElementsByTagName(tagName)[0];
  return child?.textContent?.trim() || "";
}

function inferType(file, name, sport = "") {
  const value = `${file} ${name} ${sport}`.toLowerCase();

  if (/\b(run|running|jog|jogging)\b/.test(value)) return "run";
  if (/\b(ride|riding|bike|biking|cycle|cycling|cyclist|bicycle)\b/.test(value)) return "ride";

  return "other";
}

function titleFromFile(file) {
  return file
    .replace(/\.(fit|gpx)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function distanceInKm(points) {
  let meters = 0;

  for (let index = 1; index < points.length; index += 1) {
    meters += haversineMeters(points[index - 1], points[index]);
  }

  return meters / 1000;
}

function splitTrackSegments(points) {
  const segments = [];
  let currentSegment = [];

  for (const point of points) {
    const previousPoint = currentSegment.at(-1);

    if (previousPoint && shouldStartNewSegment(previousPoint, point)) {
      if (currentSegment.length > 1) {
        segments.push(currentSegment);
      }

      currentSegment = [];
    }

    currentSegment.push(point);
  }

  if (currentSegment.length > 1) {
    segments.push(currentSegment);
  }

  return segments;
}

function shouldStartNewSegment(previousPoint, point) {
  const gapMeters = haversineMeters(previousPoint, point);

  if (gapMeters <= maxLineGapMeters) {
    return false;
  }

  const seconds = secondsBetween(previousPoint.time, point.time);

  if (!seconds) {
    return true;
  }

  const metersPerSecond = gapMeters / seconds;
  return metersPerSecond > 12 || gapMeters > maxLineGapMeters * 4;
}

function secondsBetween(left, right) {
  if (!left || !right) return null;

  const seconds = (new Date(right).getTime() - new Date(left).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function trimRoute(points, metersToTrim) {
  return trimEnd(trimStart(points, metersToTrim), metersToTrim);
}

function trimStart(points, metersToTrim) {
  let distance = 0;

  for (let index = 1; index < points.length; index += 1) {
    distance += haversineMeters(points[index - 1], points[index]);

    if (distance >= metersToTrim) {
      return points.slice(index);
    }
  }

  return [];
}

function trimEnd(points, metersToTrim) {
  let distance = 0;

  for (let index = points.length - 1; index > 0; index -= 1) {
    distance += haversineMeters(points[index], points[index - 1]);

    if (distance >= metersToTrim) {
      return points.slice(0, index + 1);
    }
  }

  return [];
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

function dateIsInMonth(dateString, month) {
  const d = new Date(dateString);
  const [year, monthNum] = month.split("-").map(Number);
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === monthNum;
}

function round(value, places) {
  return Number(value.toFixed(places));
}
