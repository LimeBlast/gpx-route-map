// Geographic helpers shared by the render script and the basemap fetcher.

export function coordinateBounds(coordinates) {
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };

  for (const [longitude, latitude] of coordinates) {
    if (longitude < bounds.west) bounds.west = longitude;
    if (longitude > bounds.east) bounds.east = longitude;
    if (latitude < bounds.south) bounds.south = latitude;
    if (latitude > bounds.north) bounds.north = latitude;
  }

  return bounds;
}

export function padBounds(bounds, degrees) {
  return {
    west: bounds.west - degrees,
    east: bounds.east + degrees,
    south: bounds.south - degrees,
    north: bounds.north + degrees
  };
}

export function mergeBounds(list) {
  return list.reduce((merged, bounds) => ({
    west: Math.min(merged.west, bounds.west),
    east: Math.max(merged.east, bounds.east),
    south: Math.min(merged.south, bounds.south),
    north: Math.max(merged.north, bounds.north)
  }));
}

function boundsOverlap(left, right) {
  return (
    left.west <= right.east &&
    right.west <= left.east &&
    left.south <= right.north &&
    right.south <= left.north
  );
}

// Merge routes into areas of activity — a month in one city collapses to one
// cluster, a month either side of an ocean stays two
export function clusterBounds(routeBounds, joinDegrees) {
  const clusters = [];

  for (const bounds of routeBounds) {
    const padded = padBounds(bounds, joinDegrees);
    const overlapping = clusters.filter((cluster) => boundsOverlap(cluster, padded));

    for (const cluster of overlapping) {
      clusters.splice(clusters.indexOf(cluster), 1);
    }

    clusters.push(mergeBounds([padded, ...overlapping]));
  }

  return clusters;
}

export function routeClusters(routes, joinDegrees) {
  const routeBounds = routes
    .filter((route) => route.coordinates?.length > 1)
    .map((route) => coordinateBounds(route.coordinates));

  return routeBounds.length === 0 ? [] : clusterBounds(routeBounds, joinDegrees);
}
