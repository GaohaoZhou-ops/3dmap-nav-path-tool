export const normalizeRobotJointLocks = (value) => {
  let source = [];
  if (value instanceof Set || Array.isArray(value)) {
    source = [...value];
  } else if (value && typeof value === 'object') {
    source = Object.entries(value).flatMap(([name, locked]) => locked ? [name] : []);
  }

  return [...new Set(source.flatMap((entry) => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    const normalized = String(name || '').trim();
    return normalized ? [normalized] : [];
  }))];
};

export const isRobotBodyJoint = (value) => {
  const name = typeof value === 'string' ? value : value?.name;
  return /(ankle|knee|waist)/i.test(String(name || ''));
};

export const defaultRobotJointLocks = (movableJoints) => normalizeRobotJointLocks(
  (Array.isArray(movableJoints) ? movableJoints : [])
    .filter(isRobotBodyJoint)
    .map((joint) => joint?.name),
);
