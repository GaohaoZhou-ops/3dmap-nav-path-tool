export const SLICE_CONTROL_MARGIN_RATIO = 0.05;
export const SLICE_CONTROL_MIN_MARGIN = 0.05;

const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function getSliceControlBounds(bounds) {
  const first = finite(bounds?.min?.z);
  const second = finite(bounds?.max?.z);
  if (first === null || second === null) {
    return {
      min: 0,
      max: 1,
      cloudMin: 0,
      cloudMax: 1,
      margin: 0,
      hasCloudBounds: false,
    };
  }

  const cloudMin = Math.min(first, second);
  const cloudMax = Math.max(first, second);
  const cloudSpan = cloudMax - cloudMin;
  const margin = Math.max(cloudSpan * SLICE_CONTROL_MARGIN_RATIO, SLICE_CONTROL_MIN_MARGIN);
  return {
    min: cloudMin - margin,
    max: cloudMax + margin,
    cloudMin,
    cloudMax,
    margin,
    hasCloudBounds: true,
  };
}
