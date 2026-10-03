// Shared by the browser and LAN service. All positions are metres, Z up.
export const IPAD_PROTOCOL = 'atlas-ipad-teaching/1';
export const MAX_MODEL_BYTES = 192 * 1024 * 1024;
export const MAX_MODEL_VERTICES = 5000000;
export const MAX_MODEL_INDICES = 30000000;
export const MAX_SAMPLES = 50000;

const check = (condition, message) => { if (!condition) throw new Error(message); };
const finiteVector = (v, keys) => v && keys.every((key) => Number.isFinite(v[key]));
const xyz = ['x', 'y', 'z'];
const validDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function validateModelBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(bytes.byteLength >= 32 && bytes.byteLength <= MAX_MODEL_BYTES, '模型大小无效');
  check(view.getUint32(0, true) === 0x534c5441 && view.getUint32(4, true) === 1, '模型格式不支持');
  const vertices = view.getUint32(8, true), indices = view.getUint32(12, true);
  check(vertices > 0 && vertices <= MAX_MODEL_VERTICES && indices <= MAX_MODEL_INDICES && indices % 3 === 0, '模型数量超出限制');
  check(bytes.byteLength === 32 + vertices * 16 + indices * 4, '模型文件不完整');
  for (let i = 0; i < vertices * 3; i += 1) check(Number.isFinite(view.getFloat32(32 + i * 4, true)), '模型坐标无效');
  for (let i = 0; i < indices; i += 1) check(view.getUint32(32 + vertices * 16 + i * 4, true) < vertices, '模型索引越界');
  return { vertices, indices };
}

export function validateIPadResult(result, manifest, sessionId) {
  check(result?.protocol === IPAD_PROTOCOL, 'iPad 数据协议不支持');
  check(result.sessionId === sessionId && result.modelHash === manifest.modelHash, '示教结果与发送的模型不匹配');
  check(typeof result.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(result.id), '结果标识无效');
  check(result.coordinateFrame === 'virtual_origin', '示教坐标系必须是 virtual_origin');
  check(result.device?.lidar === true && typeof result.device?.model === 'string', '结果缺少 LiDAR 设备信息');
  check(validDate(result.createdAt) && validDate(result.completedAt), '示教时间无效');
  check(Array.isArray(result.calibrations) && result.calibrations.length > 0 && result.calibrations.length <= 1000, '缺少空间校准');
  const segments = new Set();
  for (const calibration of result.calibrations) {
    check(typeof calibration.id === 'string' && !segments.has(calibration.id), '校准标识重复');
    segments.add(calibration.id);
    const m = calibration.worldFromModel;
    check(Array.isArray(m) && m.length === 16 && m.every(Number.isFinite), '校准矩阵无效');
    check(Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) < 0.0001 && Math.abs(m[15] - 1) < 0.0001, '校准矩阵必须是仿射变换');
    const dot = (a, b) => [0, 1, 2].reduce((sum, i) => sum + m[a * 4 + i] * m[b * 4 + i], 0);
    check([0, 1, 2].every((a) => [0, 1, 2].every((b) => Math.abs(dot(a, b) - (a === b ? 1 : 0)) < 0.002)), '校准不能缩放或拉伸物体');
    const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    check(Math.abs(determinant - 1) < 0.002, '校准不能镜像物体');
  }
  check(Array.isArray(result.samples) && result.samples.length > 0 && result.samples.length <= MAX_SAMPLES, '示教点数量无效');
  const ids = new Set();
  for (const sample of result.samples) {
    check(typeof sample.id === 'string' && !ids.has(sample.id), '示教点标识重复');
    ids.add(sample.id);
    check(sample.name == null || (typeof sample.name === 'string' && sample.name.length <= 80), 'Pose 名称过长');
    check(sample.previewAspect == null || (Number.isFinite(sample.previewAspect) && sample.previewAspect > 0 && sample.previewAspect < 10), 'Pose 预览比例无效');
    for (const key of ['previewCameraTransform', 'previewProjection']) {
      check(sample[key] == null || (Array.isArray(sample[key]) && sample[key].length === 16 && sample[key].every(Number.isFinite)), 'Pose 预览矩阵无效');
    }
    check(segments.has(sample.segmentId) && validDate(sample.capturedAt), '示教点缺少校准或时间');
    check(['keyframe', 'trajectory'].includes(sample.kind) && sample.tracking === 'normal', '仅接收定位正常时的示教点');
    check(finiteVector(sample.cameraPose?.position, xyz) && finiteVector(sample.cameraPose?.quaternion, [...xyz, 'w']), '相机位姿无效');
    const q = sample.cameraPose.quaternion;
    check(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.002, '相机旋转四元数未归一化');
    check(sample.cameraPose.frameName === 'ipad_camera_optical_frame', '相机轴约定无效');
    check(sample.surfacePoint == null || finiteVector(sample.surfacePoint, xyz), '表面点无效');
  }
  return result;
}
