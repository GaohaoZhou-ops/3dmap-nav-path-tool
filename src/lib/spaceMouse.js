export const SPACEMOUSE_VENDOR_ID = 0x256f;
export const SPACEMOUSE_WIRELESS_BT_PRODUCT_ID = 0xc63a;

// The Bluetooth Edition keeps PID c63a when used directly. The receiver PIDs
// are included so the same physical mouse can also be used through the bundled
// 3Dconnexion receiver without changing the application-side control profile.
export const SPACEMOUSE_SUPPORTED_PRODUCT_IDS = Object.freeze([
  SPACEMOUSE_WIRELESS_BT_PRODUCT_ID,
  0xc652,
  0xc65a,
  0xc65c,
]);

export const SPACEMOUSE_PROFILE_STORAGE_KEY =
  'atlas-route-studio:spacemouse-wireless-bt-profile-v3';
const SPACEMOUSE_LEGACY_PROFILE_STORAGE_KEY =
  'atlas-route-studio:spacemouse-wireless-bt-profile-v2';
const SPACEMOUSE_OLDER_PROFILE_STORAGE_KEY =
  'atlas-route-studio:spacemouse-wireless-bt-profile-v1';
export const SPACEMOUSE_PROFILE_SEMANTICS = 'ros-x-forward-y-left-z-up-rpy-v1';
export const SPACEMOUSE_CALIBRATION_MODEL = 'coupled-6d-ridge-v1';
export const SPACEMOUSE_CAPTURE_STRATEGY = 'outbound-peak-envelope-v1';

export const SPACEMOUSE_RAW_AXES = Object.freeze(['x', 'y', 'z', 'rx', 'ry', 'rz']);
export const SPACEMOUSE_CONTROL_AXES = Object.freeze(['x', 'y', 'z', 'roll', 'pitch', 'yaw']);

export const SPACEMOUSE_CALIBRATION_STEPS = Object.freeze([
  { axis: 'x', direction: 'positive', code: '+X', title: '前进', action: '将空间球向前平推到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'x', direction: 'negative', code: '−X', title: '后退', action: '将空间球向后平拉到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'y', direction: 'positive', code: '+Y', title: '向左', action: '将空间球向左平推到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'y', direction: 'negative', code: '−Y', title: '向右', action: '将空间球向右平推到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'z', direction: 'positive', code: '+Z', title: '向上', action: '将空间球向上提到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'z', direction: 'negative', code: '−Z', title: '向下', action: '将空间球向下压到舒适最大幅度，再松手回中', group: 'XYZ' },
  { axis: 'roll', direction: 'positive', code: '+R', title: '左翻滚', action: '将空间球向左翻滚到舒适最大角度，再松手回中', group: 'RPY' },
  { axis: 'roll', direction: 'negative', code: '−R', title: '右翻滚', action: '将空间球向右翻滚到舒适最大角度，再松手回中', group: 'RPY' },
  { axis: 'pitch', direction: 'positive', code: '+P', title: '前倾', action: '将空间球向前倾到舒适最大角度，再松手回中', group: 'RPY' },
  { axis: 'pitch', direction: 'negative', code: '−P', title: '后仰', action: '将空间球向后仰到舒适最大角度，再松手回中', group: 'RPY' },
  { axis: 'yaw', direction: 'positive', code: '+YAW', title: '左偏航', action: '将空间球向左偏航到舒适最大角度，再松手回中', group: 'RPY' },
  { axis: 'yaw', direction: 'negative', code: '−YAW', title: '右偏航', action: '将空间球向右偏航到舒适最大角度，再松手回中', group: 'RPY' },
]);

const emptyAxes = () => Object.fromEntries(SPACEMOUSE_RAW_AXES.map((axis) => [axis, 0]));
const emptyControlAxes = () => (
  Object.fromEntries(SPACEMOUSE_CONTROL_AXES.map((axis) => [axis, 0]))
);

export function createSpaceMouseInputState() {
  return {
    connected: false,
    calibrated: false,
    calibrating: false,
    controlEnabled: true,
    mode: 'xyz',
    axes: emptyControlAxes(),
    rawAxes: emptyAxes(),
    timestamp: 0,
    lastMotionTimestamp: 0,
    revision: 0,
  };
}

export function isSupportedSpaceMouseDevice(device) {
  return Boolean(
    device
    && Number(device.vendorId) === SPACEMOUSE_VENDOR_ID
    && SPACEMOUSE_SUPPORTED_PRODUCT_IDS.includes(Number(device.productId)),
  );
}

export function spaceMouseConnectionLabel(device) {
  const productId = Number(device?.productId);
  if ([0xc652, 0xc65a, 0xc65c].includes(productId)) return '2.4 GHz 接收器';
  const name = String(device?.productName || '').toLowerCase();
  if (name.includes(' bt') || name.includes('bluetooth')) return 'Bluetooth LE / USB-C';
  return 'USB-C / Bluetooth LE';
}

const asDataView = (data) => {
  if (data instanceof DataView) return data;
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(new Uint8Array(data || []).buffer);
};

const readVector = (view, offset = 0) => {
  if (view.byteLength < offset + 6) return null;
  return [
    view.getInt16(offset, true),
    view.getInt16(offset + 2, true),
    view.getInt16(offset + 4, true),
  ];
};

export function parseSpaceMouseInputReport(reportId, data) {
  let view = asDataView(data);
  let id = Number(reportId) || 0;
  if (
    id === 0
    && view.byteLength > 0
    && [1, 2, 3].includes(view.getUint8(0))
  ) {
    id = view.getUint8(0);
    view = new DataView(view.buffer, view.byteOffset + 1, view.byteLength - 1);
  }

  if (id === 1) {
    const translation = readVector(view, 0);
    const rotation = readVector(view, 6);
    return {
      reportId: id,
      translation: translation
        ? { x: translation[0], y: translation[1], z: translation[2] }
        : null,
      rotation: rotation
        ? { rx: rotation[0], ry: rotation[1], rz: rotation[2] }
        : null,
      buttons: null,
    };
  }

  if (id === 2) {
    const rotation = readVector(view, 0);
    return {
      reportId: id,
      translation: null,
      rotation: rotation
        ? { rx: rotation[0], ry: rotation[1], rz: rotation[2] }
        : null,
      buttons: null,
    };
  }

  if (id === 3) {
    let mask = 0;
    const bytes = Math.min(view.byteLength, 4);
    for (let index = 0; index < bytes; index += 1) {
      mask += view.getUint8(index) * (2 ** (index * 8));
    }
    return { reportId: id, translation: null, rotation: null, buttons: mask >>> 0 };
  }

  return { reportId: id, translation: null, rotation: null, buttons: null };
}

const validLegacyMapping = (value) => (
  value
  && SPACEMOUSE_RAW_AXES.includes(value.sourceAxis)
  && (value.sourceSign === 1 || value.sourceSign === -1)
  && Number.isFinite(Number(value.peak))
  && Number(value.peak) > 0
);

const captureVector = (capture) => {
  if (capture?.vector) {
    const vector = SPACEMOUSE_RAW_AXES.map((axis) => Number(capture.vector[axis]));
    return vector.every(Number.isFinite) ? vector : null;
  }
  if (!validLegacyMapping(capture)) return null;
  return SPACEMOUSE_RAW_AXES.map((axis) => (
    axis === capture.sourceAxis ? capture.sourceSign * Number(capture.peak) : 0
  ));
};

const vectorMagnitude = (vector) => Math.sqrt(
  vector.reduce((total, value) => total + value * value, 0),
);

const cosineSimilarity = (left, right) => {
  const denominator = vectorMagnitude(left) * vectorMagnitude(right);
  if (denominator < 1e-9) return 1;
  return left.reduce((total, value, index) => total + value * right[index], 0)
    / denominator;
};

const normalizeCapture = (capture) => {
  const values = captureVector(capture);
  if (!values) return null;
  const magnitude = vectorMagnitude(values);
  const maximum = Math.max(...values.map(Math.abs), 0);
  const dominantIndex = values.findIndex((value) => Math.abs(value) === maximum);
  const activeAxes = SPACEMOUSE_RAW_AXES.filter((axis, index) => (
    Math.abs(values[index]) >= Math.max(12, maximum * 0.12)
  ));
  return {
    ...capture,
    vector: Object.fromEntries(
      SPACEMOUSE_RAW_AXES.map((axis, index) => [axis, Number(values[index].toFixed(4))]),
    ),
    magnitude: Number(magnitude.toFixed(4)),
    dominantAxis: capture?.dominantAxis || SPACEMOUSE_RAW_AXES[dominantIndex] || 'x',
    activeAxes: activeAxes.length ? activeAxes : [SPACEMOUSE_RAW_AXES[dominantIndex] || 'x'],
  };
};

const normalizeCalibrationRecords = (records) => Object.fromEntries(
  SPACEMOUSE_CONTROL_AXES.map((axis) => [axis, {
    positive: normalizeCapture(records?.[axis]?.positive),
    negative: normalizeCapture(records?.[axis]?.negative),
  }]),
);

export function validateSpaceMouseCalibration(records) {
  const issues = [];

  SPACEMOUSE_CONTROL_AXES.forEach((axis) => {
    const positive = captureVector(records?.[axis]?.positive);
    const negative = captureVector(records?.[axis]?.negative);
    if (!positive || !negative) {
      issues.push(`${axis.toUpperCase()} 尚未完成正负方向采集`);
      return;
    }
    if (vectorMagnitude(positive) < 1 || vectorMagnitude(negative) < 1) {
      issues.push(`${axis.toUpperCase()} 的有效运动幅度不足`);
      return;
    }
    if (cosineSimilarity(positive, negative) > 0.72) {
      issues.push(`${axis.toUpperCase()} 的正反动作特征过于相似，请重新采集`);
    }
  });

  return { valid: issues.length === 0, issues };
}

const zeroMatrix = (rows, columns) => Array.from(
  { length: rows },
  () => Array(columns).fill(0),
);

const invertMatrix = (matrix) => {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...Array.from({ length: size }, (_, columnIndex) => (
      rowIndex === columnIndex ? 1 : 0
    )),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    if (Math.abs(augmented[pivotRow][column]) < 1e-12) return null;
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    const pivot = augmented[column][column];
    for (let index = 0; index < size * 2; index += 1) {
      augmented[column][index] /= pivot;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (!factor) continue;
      for (let index = 0; index < size * 2; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row.slice(size));
};

const multiplyMatrices = (left, right) => {
  const result = zeroMatrix(left.length, right[0].length);
  for (let row = 0; row < left.length; row += 1) {
    for (let column = 0; column < right[0].length; column += 1) {
      for (let inner = 0; inner < right.length; inner += 1) {
        result[row][column] += left[row][inner] * right[inner][column];
      }
    }
  }
  return result;
};

const buildCoupledCalibrationModel = (records) => {
  const normalizedRecords = normalizeCalibrationRecords(records);
  const training = [];
  SPACEMOUSE_CONTROL_AXES.forEach((axis, controlIndex) => {
    ['positive', 'negative'].forEach((direction) => {
      training.push({
        raw: captureVector(normalizedRecords[axis][direction]),
        controlIndex,
        target: direction === 'positive' ? 1 : -1,
      });
    });
  });
  const rawScale = SPACEMOUSE_RAW_AXES.map((_, rawIndex) => Math.max(
    1,
    ...training.map(({ raw }) => Math.abs(raw[rawIndex])),
  ));
  const design = training.map(({ raw }) => raw.map(
    (value, rawIndex) => value / rawScale[rawIndex],
  ));
  const targets = training.map(({ controlIndex, target }) => (
    SPACEMOUSE_CONTROL_AXES.map((_, index) => index === controlIndex ? target : 0)
  ));
  const transpose = SPACEMOUSE_RAW_AXES.map((_, column) => (
    design.map((row) => row[column])
  ));
  const gram = multiplyMatrices(transpose, design);
  const ridge = 0.004;
  gram.forEach((row, index) => { row[index] += ridge; });
  const inverse = invertMatrix(gram);
  if (!inverse) throw new Error('六维解耦矩阵无法求解，请重新执行标定');
  const rawToControl = multiplyMatrices(multiplyMatrices(inverse, transpose), targets);
  const decoder = SPACEMOUSE_CONTROL_AXES.map((_, controlIndex) => (
    SPACEMOUSE_RAW_AXES.map((__, rawIndex) => rawToControl[rawIndex][controlIndex])
  ));
  let squaredError = 0;
  training.forEach(({ controlIndex, target }, sampleIndex) => {
    decoder.forEach((weights, outputIndex) => {
      const prediction = weights.reduce(
        (total, weight, rawIndex) => total + weight * design[sampleIndex][rawIndex],
        0,
      );
      const expected = outputIndex === controlIndex ? target : 0;
      squaredError += (prediction - expected) ** 2;
    });
  });
  const activeAxisAverage = training.reduce((total, { raw }) => {
    const maximum = Math.max(...raw.map(Math.abs), 0);
    return total + raw.filter((value) => Math.abs(value) >= Math.max(12, maximum * 0.12)).length;
  }, 0) / training.length;
  return {
    mappings: normalizedRecords,
    rawScale,
    decoder,
    fitError: Math.sqrt(squaredError / (training.length * SPACEMOUSE_CONTROL_AXES.length)),
    activeAxisAverage,
  };
};

export function createSpaceMouseProfile(records, device) {
  const validation = validateSpaceMouseCalibration(records);
  if (!validation.valid) {
    throw new Error(validation.issues.join('；'));
  }
  const calibration = buildCoupledCalibrationModel(records);
  const captureStrategy = SPACEMOUSE_CONTROL_AXES.every((axis) => (
    ['positive', 'negative'].every((direction) => (
      calibration.mappings[axis]?.[direction]?.captureStrategy
        === SPACEMOUSE_CAPTURE_STRATEGY
    ))
  )) ? SPACEMOUSE_CAPTURE_STRATEGY : 'legacy-full-gesture-v1';
  return {
    version: 3,
    semantics: SPACEMOUSE_PROFILE_SEMANTICS,
    calibrationModel: SPACEMOUSE_CALIBRATION_MODEL,
    captureStrategy,
    model: '3DConnexion SpaceMouse Wireless Bluetooth Edition',
    device: {
      vendorId: Number(device?.vendorId) || SPACEMOUSE_VENDOR_ID,
      productId: Number(device?.productId) || SPACEMOUSE_WIRELESS_BT_PRODUCT_ID,
      productName: String(device?.productName || 'SpaceMouse Wireless BT'),
    },
    mappings: calibration.mappings,
    decoder: calibration.decoder,
    rawScale: calibration.rawScale,
    fitError: calibration.fitError,
    activeAxisAverage: calibration.activeAxisAverage,
    responseCurve: 1.35,
    deadzoneRatio: 0.075,
    calibratedAt: new Date().toISOString(),
  };
}

const reverseAxisMapping = (mapping) => ({
  positive: mapping?.negative,
  negative: mapping?.positive,
});

const migrateV1SpaceMouseProfile = (legacy) => {
  if (
    legacy?.version !== 1
    || !validateSpaceMouseCalibration(legacy.mappings).valid
  ) return null;
  const mappings = {
    // v1 used screen-right / screen-up / dolly-forward as X / Y / Z.
    // v2 follows the ROS-style +X forward, +Y left, +Z up convention.
    x: legacy.mappings.z,
    y: reverseAxisMapping(legacy.mappings.x),
    z: legacy.mappings.y,
    roll: reverseAxisMapping(legacy.mappings.roll),
    pitch: reverseAxisMapping(legacy.mappings.pitch),
    yaw: legacy.mappings.yaw,
  };
  if (!validateSpaceMouseCalibration(mappings).valid) return null;
  return {
    ...legacy,
    version: 2,
    semantics: SPACEMOUSE_PROFILE_SEMANTICS,
    mappings,
    migratedFrom: 'screen-xyz-rpy-v1',
    migratedAt: new Date().toISOString(),
  };
};

const migrateSingleAxisProfile = (legacy) => {
  if (!legacy || !validateSpaceMouseCalibration(legacy.mappings).valid) return null;
  try {
    const migrated = createSpaceMouseProfile(legacy.mappings, legacy.device);
    return {
      ...migrated,
      responseCurve: Number(legacy.responseCurve) || migrated.responseCurve,
      deadzoneRatio: Number(legacy.deadzoneRatio) || migrated.deadzoneRatio,
      calibratedAt: legacy.calibratedAt || migrated.calibratedAt,
      migratedFrom: legacy.migratedFrom
        ? `${legacy.migratedFrom}->coupled-6d-v3`
        : `single-axis-v${legacy.version}->coupled-6d-v3`,
      migratedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

export function loadSpaceMouseProfile(storage = globalThis.localStorage) {
  try {
    const profile = JSON.parse(storage?.getItem(SPACEMOUSE_PROFILE_STORAGE_KEY) || 'null');
    if (
      profile?.version === 3
      && profile.semantics === SPACEMOUSE_PROFILE_SEMANTICS
      && profile.calibrationModel === SPACEMOUSE_CALIBRATION_MODEL
      && validateSpaceMouseCalibration(profile.mappings).valid
    ) {
      const calibration = buildCoupledCalibrationModel(profile.mappings);
      return {
        ...profile,
        captureStrategy: profile.captureStrategy || 'legacy-full-gesture-v1',
        mappings: calibration.mappings,
        decoder: calibration.decoder,
        rawScale: calibration.rawScale,
        fitError: calibration.fitError,
        activeAxisAverage: calibration.activeAxisAverage,
      };
    }

    const legacyV2 = JSON.parse(
      storage?.getItem(SPACEMOUSE_LEGACY_PROFILE_STORAGE_KEY) || 'null',
    );
    const legacyV1 = JSON.parse(
      storage?.getItem(SPACEMOUSE_OLDER_PROFILE_STORAGE_KEY) || 'null',
    );
    const migrated = migrateSingleAxisProfile(legacyV2)
      || migrateSingleAxisProfile(migrateV1SpaceMouseProfile(legacyV1));
    if (!migrated) return null;
    saveSpaceMouseProfile(migrated, storage);
    return migrated;
  } catch {
    return null;
  }
}

export function saveSpaceMouseProfile(profile, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SPACEMOUSE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    storage?.removeItem?.(SPACEMOUSE_LEGACY_PROFILE_STORAGE_KEY);
    storage?.removeItem?.(SPACEMOUSE_OLDER_PROFILE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function applySpaceMouseProfile(rawAxes, profile) {
  if (
    !profile
    || profile.calibrationModel !== SPACEMOUSE_CALIBRATION_MODEL
    || !Array.isArray(profile.decoder)
    || !Array.isArray(profile.rawScale)
  ) {
    return emptyControlAxes();
  }
  const normalizedRaw = SPACEMOUSE_RAW_AXES.map((axis, index) => (
    (Number(rawAxes?.[axis]) || 0) / Math.max(Number(profile.rawScale[index]) || 0, 1)
  ));
  const deadzone = Math.max(0, Math.min(0.4, Number(profile.deadzoneRatio) || 0.075));
  const responseCurve = Math.max(0.4, Number(profile.responseCurve) || 1.35);
  return Object.fromEntries(SPACEMOUSE_CONTROL_AXES.map((axis, controlIndex) => {
    const decoded = profile.decoder[controlIndex]?.reduce(
      (total, weight, rawIndex) => total + (Number(weight) || 0) * normalizedRaw[rawIndex],
      0,
    ) || 0;
    const magnitude = Math.abs(decoded);
    if (magnitude <= deadzone) return [axis, 0];
    const normalized = Math.min(1, (magnitude - deadzone) / Math.max(1 - deadzone, 1e-6));
    return [axis, Math.sign(decoded) * (normalized ** responseCurve)];
  }));
}

export function zeroSpaceMouseAxes() {
  return emptyAxes();
}

export function zeroSpaceMouseControlAxes() {
  return emptyControlAxes();
}
