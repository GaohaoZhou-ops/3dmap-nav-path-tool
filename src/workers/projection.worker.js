let positions = null;
let colors = null;
let bounds = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    positions = message.positions;
    colors = message.colors;
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
  const red = colors ? new Uint32Array(cellCount) : null;
  const green = colors ? new Uint32Array(cellCount) : null;
  const blue = colors ? new Uint32Array(cellCount) : null;
  const colorScale = colors && colors[0] <= 1.5 ? 255 : 1;

  let selectedCount = 0;
  let maxDensity = 0;
  for (let i = 0, vertex = 0; i < positions.length; i += 3, vertex += 3) {
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
    const density = ++counts[cell];
    zSums[cell] += z;
    if (density > maxDensity) maxDensity = density;
    if (colors) {
      red[cell] += Math.round(colors[vertex] * colorScale);
      green[cell] += Math.round(colors[vertex + 1] * colorScale);
      blue[cell] += Math.round(colors[vertex + 2] * colorScale);
    }
    selectedCount += 1;
  }

  const pixels = new Uint8ClampedArray(cellCount * 4);
  const zGrid = new Float32Array(cellCount);
  zGrid.fill(Number.NaN);
  const densityDenominator = Math.log1p(Math.max(maxDensity, 1));

  for (let cell = 0; cell < cellCount; cell += 1) {
    const density = counts[cell];
    if (!density) continue;
    const strength = Math.log1p(density) / densityDenominator;
    const offset = cell * 4;
    const sourceR = colors ? red[cell] / density : 112;
    const sourceG = colors ? green[cell] / density : 174;
    const sourceB = colors ? blue[cell] / density : 185;
    pixels[offset] = clamp(10 + sourceR * 0.62 + strength * 25, 0, 255);
    pixels[offset + 1] = clamp(20 + sourceG * 0.68 + strength * 52, 0, 255);
    pixels[offset + 2] = clamp(25 + sourceB * 0.7 + strength * 64, 0, 255);
    pixels[offset + 3] = clamp(118 + strength * 137, 0, 255);
    zGrid[cell] = zSums[cell] / density;
  }

  self.postMessage(
    {
      type: 'projection',
      revision,
      width,
      height,
      pixels: pixels.buffer,
      zGrid: zGrid.buffer,
      selectedCount,
    },
    [pixels.buffer, zGrid.buffer],
  );
};
