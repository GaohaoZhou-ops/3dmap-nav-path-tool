import { calculatePathDistances } from './pathMetrics.js';

const numberOr = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const booleanOr = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
};

export const createId = (prefix) =>
  `${prefix}-${
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  }`;

export function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

export async function fetchBufferWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`示例地图请求失败（${response.status}）`);
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body || !total) {
    const buffer = await response.arrayBuffer();
    onProgress(1);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged.buffer;
}

export function normalizeProject(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('JSON 根节点必须是对象');
  }

  const rawPoints =
    payload.waypoints || payload.navigationPoints || payload.points || [];
  const waypoints = rawPoints.map((point, index) => {
    const pose = point.pose || point.position || point;
    const xzy = Array.isArray(point.xzy) ? point.xzy : [];
    const rpy = Array.isArray(point.rpy) ? point.rpy : [];
    return {
      id: String(point.id || createId('wp')),
      name: String(point.name || point.label || `P${String(index + 1).padStart(2, '0')}`),
      pose: {
        x: numberOr(pose.x, numberOr(xzy[0])),
        y: numberOr(pose.y, numberOr(xzy[2])),
        z: numberOr(pose.z, numberOr(xzy[1])),
        roll: numberOr(pose.roll, numberOr(rpy[0])),
        pitch: numberOr(pose.pitch, numberOr(rpy[1])),
        yaw: numberOr(pose.yaw, numberOr(rpy[2])),
      },
      source: point.source || 'imported',
    };
  });

  const rawEdges = payload.paths || payload.edges || payload.routes || [];
  const edges = rawEdges
    .map((edge) => {
      const limits = edge.limits || edge.constraints || edge;
      const motion = edge.motion || edge.behavior || {};
      const rawDirection = String(
        motion.direction ?? edge.motionDirection ?? edge.travelDirection ?? 'forward',
      ).toLowerCase();
      return {
        id: String(edge.id || createId('edge')),
        from: String(edge.from ?? edge.source ?? edge.start ?? ''),
        to: String(edge.to ?? edge.target ?? edge.end ?? ''),
        directed: edge.directed !== false,
        limits: {
          minSpeed: numberOr(limits.minSpeed ?? limits.min_speed, 0.2),
          maxSpeed: numberOr(limits.maxSpeed ?? limits.max_speed, 1),
          minAcceleration: numberOr(
            limits.minAcceleration ?? limits.min_acceleration,
            -0.8,
          ),
          maxAcceleration: numberOr(
            limits.maxAcceleration ?? limits.max_acceleration,
            0.8,
          ),
        },
        motion: {
          direction: ['reverse', 'backward', 'back', '倒车'].includes(rawDirection)
            ? 'reverse'
            : 'forward',
          enable3DObstacleAvoidance: booleanOr(
            motion.enable3DObstacleAvoidance
              ?? motion.enable_3d_obstacle_avoidance
              ?? edge.enable3DObstacleAvoidance
              ?? edge.enable_3d_obstacle_avoidance,
            true,
          ),
        },
        status: ['connected', 'unreachable'].includes(edge.connectivity)
          ? edge.connectivity
          : 'unchecked',
      };
    })
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to);

  const projection = payload.projection || payload.slice || payload.map?.slice || {};
  const minHeight = numberOr(
    projection.minHeight ?? projection.minZ ?? projection.lower,
    NaN,
  );
  const maxHeight = numberOr(
    projection.maxHeight ?? projection.maxZ ?? projection.upper,
    NaN,
  );

  return {
    waypoints,
    edges,
    slice:
      Number.isFinite(minHeight) && Number.isFinite(maxHeight)
        ? [Math.min(minHeight, maxHeight), Math.max(minHeight, maxHeight)]
        : null,
    map: payload.map || null,
    view2d: payload.view2d || null,
  };
}

export function buildExport({ mapData, heightRange, waypoints, edges, view2d }) {
  const pointById = new Map(waypoints.map((point) => [point.id, point]));
  return {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    coordinateSystem: {
      horizontalPlane: 'XY',
      verticalAxis: 'Z',
      angleUnit: 'degree',
      distanceUnit: 'meter',
    },
    map: {
      fileName: mapData?.name || null,
      format: 'ply',
      pointCount: mapData?.pointCount || 0,
      bounds: mapData?.bounds || null,
    },
    projection: {
      plane: 'XY',
      verticalAxis: 'Z',
      minHeight: heightRange[0],
      maxHeight: heightRange[1],
    },
    view2d: view2d || null,
    waypoints: waypoints.map((point) => ({
      id: point.id,
      name: point.name,
      pose: { ...point.pose },
      xzy: [point.pose.x, point.pose.z, point.pose.y],
      rpy: [point.pose.roll, point.pose.pitch, point.pose.yaw],
      source: point.source || 'point-cloud-slice',
    })),
    paths: edges.map((edge) => {
      const distance = calculatePathDistances(
        pointById.get(edge.from)?.pose,
        pointById.get(edge.to)?.pose,
      );
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        directed: true,
        limits: { ...edge.limits },
        motion: {
          direction: edge.motion?.direction === 'reverse' ? 'reverse' : 'forward',
          enable3DObstacleAvoidance: edge.motion?.enable3DObstacleAvoidance !== false,
        },
        distance: distance
          ? {
              straight3D: distance.straight3D,
              planarXY: distance.planarXY,
              verticalDelta: distance.verticalDelta,
            }
          : null,
        connectivity: edge.status || 'unchecked',
      };
    }),
  };
}

export function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function clampSlice(slice, bounds) {
  if (!slice || !bounds) return slice;
  const low = Math.max(bounds.min.z, Math.min(bounds.max.z, slice[0]));
  const high = Math.max(bounds.min.z, Math.min(bounds.max.z, slice[1]));
  if (low === high) {
    const padding = Math.max((bounds.max.z - bounds.min.z) * 0.05, 0.01);
    return [Math.max(bounds.min.z, low - padding), Math.min(bounds.max.z, high + padding)];
  }
  return [Math.min(low, high), Math.max(low, high)];
}
