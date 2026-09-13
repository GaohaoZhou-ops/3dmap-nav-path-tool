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
