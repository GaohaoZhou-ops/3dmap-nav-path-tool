let positions = null;
let bounds = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    positions = message.positions;
    bounds = message.bounds;
    self.postMessage({ type: 'ready' });
    return;
  }

  if (message.type !== 'project' || !positions || !bounds) return;

  const { minHeight, maxHeight, revision } = message;
  const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
  const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
  const width = 2048;
  const height = clamp(Math.round((width * rangeY) / rangeX), 128, 640);
  const cellCount = width * height;
  const counts = new Uint32Array(cellCount);
  const zSums = new Float32Array(cellCount);

  let selectedCount = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 2];
    if (z < minHeight || z > maxHeight) continue;
    const x = positions[i];
    const y = positions[i + 1];
    const pixelX = clamp(
      Math.floor(((x - bounds.min.x) / rangeX) * (width - 1)),
      0,
      width - 1,
    );
    const pixelY = clamp(
      Math.floor(((bounds.max.y - y) / rangeY) * (height - 1)),
      0,
      height - 1,
    );
    const cell = pixelY * width + pixelX;
    counts[cell] += 1;
    zSums[cell] += z;
    selectedCount += 1;
  }

  const zGrid = new Float32Array(cellCount);
  zGrid.fill(Number.NaN);

  for (let cell = 0; cell < cellCount; cell += 1) {
    const density = counts[cell];
    if (!density) continue;
    zGrid[cell] = zSums[cell] / density;
  }

  self.postMessage(
    {
      type: 'projection',
      revision,
      width,
      height,
      zGrid: zGrid.buffer,
      selectedCount,
    },
    [zGrid.buffer],
  );
};
