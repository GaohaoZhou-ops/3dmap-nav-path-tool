export const DEFAULT_PARKING_CLUSTER_DISTANCE = 0.35;
export const DEFAULT_PARKING_MERGE_XYZ_TOLERANCE = 0.05;
export const DEFAULT_PARKING_MERGE_RPY_TOLERANCE = 5;

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeMergeAngle = (value) => {
  const wrapped = ((finiteNumber(value) + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped) < 1e-10 ? 0 : wrapped;
};

export const angularMergeDistance = (left, right) => Math.abs(
  normalizeMergeAngle(finiteNumber(left) - finiteNumber(right)),
);

export const parkingPointPlanarDistance = (left, right) => Math.hypot(
  finiteNumber(left?.mapPose?.position?.x) - finiteNumber(right?.mapPose?.position?.x),
  finiteNumber(left?.mapPose?.position?.y) - finiteNumber(right?.mapPose?.position?.y),
);

const circularMeanDegrees = (values, fallback = 0) => {
  if (!values.length) return normalizeMergeAngle(fallback);
  const vectors = values.reduce((sum, value) => {
    const radians = finiteNumber(value) * Math.PI / 180;
    return {
      x: sum.x + Math.cos(radians),
      y: sum.y + Math.sin(radians),
    };
  }, { x: 0, y: 0 });
  if (Math.hypot(vectors.x, vectors.y) < 1e-7) return normalizeMergeAngle(fallback);
  return normalizeMergeAngle(Math.atan2(vectors.y, vectors.x) * 180 / Math.PI);
};

const cloneMapPose = (value) => ({
  frameId: 'map',
  position: {
    x: finiteNumber(value?.position?.x),
    y: finiteNumber(value?.position?.y),
    z: finiteNumber(value?.position?.z),
  },
  rpy: {
    roll: normalizeMergeAngle(value?.rpy?.roll),
    pitch: normalizeMergeAngle(value?.rpy?.pitch),
    yaw: normalizeMergeAngle(value?.rpy?.yaw),
  },
});

export const averageParkingPointPose = (parkingPoints) => {
  const members = Array.isArray(parkingPoints) ? parkingPoints.filter(Boolean) : [];
  if (!members.length) return cloneMapPose(null);
  const divisor = members.length;
  const positions = members.reduce((sum, parkingPoint) => ({
    x: sum.x + finiteNumber(parkingPoint.mapPose?.position?.x),
    y: sum.y + finiteNumber(parkingPoint.mapPose?.position?.y),
    z: sum.z + finiteNumber(parkingPoint.mapPose?.position?.z),
  }), { x: 0, y: 0, z: 0 });
  const fallback = members[0].mapPose?.rpy || {};
  return {
    frameId: 'map',
    position: {
      x: positions.x / divisor,
      y: positions.y / divisor,
      z: positions.z / divisor,
    },
    rpy: {
      roll: circularMeanDegrees(
        members.map((item) => item.mapPose?.rpy?.roll),
        fallback.roll,
      ),
      pitch: circularMeanDegrees(
        members.map((item) => item.mapPose?.rpy?.pitch),
        fallback.pitch,
      ),
      yaw: circularMeanDegrees(
        members.map((item) => item.mapPose?.rpy?.yaw),
        fallback.yaw,
      ),
    },
  };
};

const candidateTravel = (pose, members) => {
  const distances = members.map((parkingPoint) => Math.hypot(
    finiteNumber(pose?.position?.x) - finiteNumber(parkingPoint.mapPose?.position?.x),
    finiteNumber(pose?.position?.y) - finiteNumber(parkingPoint.mapPose?.position?.y),
  ));
  return {
    maximum: distances.length ? Math.max(...distances) : 0,
    mean: distances.length
      ? distances.reduce((total, value) => total + value, 0) / distances.length
      : 0,
  };
};

const medoidForMembers = (members) => members.reduce((best, candidate) => {
  const score = members.reduce((total, other) => (
    total
    + parkingPointPlanarDistance(candidate, other)
    + angularMergeDistance(candidate.mapPose?.rpy?.yaw, other.mapPose?.rpy?.yaw) * 0.003
  ), 0);
  return !best || score < best.score ? { parkingPoint: candidate, score } : best;
}, null)?.parkingPoint || members[0] || null;

export const createCommonParkingCandidates = (parkingPoints) => {
  const members = Array.isArray(parkingPoints) ? parkingPoints.filter(Boolean) : [];
  if (!members.length) return [];
  const medoid = medoidForMembers(members);
  const candidates = [
    {
      id: 'cluster-centroid',
      source: 'centroid',
      sourceLabel: '聚类几何中心',
      anchorParkingPointId: medoid.id,
      anchorParkingPointName: medoid.name,
      mapPose: averageParkingPointPose(members),
    },
    ...members.map((parkingPoint) => ({
      id: `existing:${parkingPoint.id}`,
      source: 'existing',
      sourceLabel: `现有位置 · ${parkingPoint.name}`,
      anchorParkingPointId: parkingPoint.id,
      anchorParkingPointName: parkingPoint.name,
      mapPose: cloneMapPose(parkingPoint.mapPose),
    })),
  ];
  const signatures = new Set();
  return candidates.flatMap((candidate) => {
    const signature = [
      candidate.mapPose.position.x,
      candidate.mapPose.position.y,
      candidate.mapPose.position.z,
      candidate.mapPose.rpy.roll,
      candidate.mapPose.rpy.pitch,
      candidate.mapPose.rpy.yaw,
    ].map((value) => finiteNumber(value).toFixed(7)).join('|');
    if (signatures.has(signature)) return [];
    signatures.add(signature);
    return [{
      ...candidate,
      travel: candidateTravel(candidate.mapPose, members),
    }];
  });
};

export const clusterNearbyParkingPoints = (
  parkingPoints,
  requestedDistance = DEFAULT_PARKING_CLUSTER_DISTANCE,
) => {
  const points = Array.isArray(parkingPoints) ? parkingPoints.filter(Boolean) : [];
  const distanceThreshold = Math.max(0.01, finiteNumber(
    requestedDistance,
    DEFAULT_PARKING_CLUSTER_DISTANCE,
  ));
  const parents = points.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const parent = parents[index];
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const unite = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const nearbyPairs = [];

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const distance = parkingPointPlanarDistance(points[left], points[right]);
      if (distance <= distanceThreshold) {
        unite(left, right);
        nearbyPairs.push({
          leftId: points[left].id,
          rightId: points[right].id,
          distance,
        });
      }
    }
  }

  const groups = new Map();
  points.forEach((parkingPoint, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(parkingPoint);
  });
  const clusters = [];
  const isolatedParkingPointIds = [];
  groups.forEach((members) => {
    if (members.length < 2) {
      isolatedParkingPointIds.push(members[0].id);
      return;
    }
    let maximumPairDistance = 0;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        maximumPairDistance = Math.max(
          maximumPairDistance,
          parkingPointPlanarDistance(members[left], members[right]),
        );
      }
    }
    const memberIds = members.map((member) => member.id);
    clusters.push({
      id: `parking-cluster:${memberIds.join('|')}`,
      members,
      memberIds,
      memberNames: members.map((member) => member.name),
      poseCount: members.reduce(
        (total, member) => total + (member.poses?.length || 0),
        0,
      ),
      maximumPairDistance,
      nearbyPairCount: nearbyPairs.filter(
        (pair) => memberIds.includes(pair.leftId) && memberIds.includes(pair.rightId),
      ).length,
    });
  });

  return {
    distanceThreshold,
    clusters,
    nearbyPairs,
    isolatedParkingPointIds,
  };
};

