export function pathExists(adjacency, start, target) {
  if (start === target) return true;
  const seen = new Set([start]);
  const queue = [start];

  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export function inspectConnectivity(waypoints, edges) {
  const ids = waypoints.map((point) => point.id);
  const adjacency = new Map(ids.map((id) => [id, []]));

  edges.forEach((edge) => {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from).push(edge.to);
    }
  });

  const edgeStatus = new Map();
  edges.forEach((edge) => {
    const mutual =
      pathExists(adjacency, edge.from, edge.to) &&
      pathExists(adjacency, edge.to, edge.from);
    edgeStatus.set(edge.id, mutual ? 'connected' : 'unreachable');
  });

  let stronglyConnected = ids.length > 0;
  if (ids.length > 1) {
    const origin = ids[0];
    stronglyConnected = ids.every(
      (id) =>
        pathExists(adjacency, origin, id) &&
        pathExists(adjacency, id, origin),
    );
  }

  return { stronglyConnected, edgeStatus };
}
