const finiteCoordinate = (pose, key) => {
  const value = Number(pose?.[key]);
  return Number.isFinite(value) ? value : null;
};

export function calculatePathDistances(sourcePose, targetPose) {
  const source = ['x', 'y', 'z'].map((key) => finiteCoordinate(sourcePose, key));
  const target = ['x', 'y', 'z'].map((key) => finiteCoordinate(targetPose, key));
  if ([...source, ...target].some((value) => value === null)) return null;

  const dx = target[0] - source[0];
  const dy = target[1] - source[1];
  const dz = target[2] - source[2];
  return {
    straight3D: Math.hypot(dx, dy, dz),
    planarXY: Math.hypot(dx, dy),
    verticalDelta: Math.abs(dz),
  };
}
