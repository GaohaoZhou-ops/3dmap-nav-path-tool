import { sha256Bytes } from './hash.js';
import { IPAD_PROTOCOL, MAX_MODEL_BYTES, MAX_MODEL_VERTICES, MAX_MODEL_INDICES, validateIPadResult } from './ipadProtocol.js';

export const IPAD_API = '/__atlas/ipad';
const ticketKey = 'atlas-ipad-handoffs-v1';

export async function ipadRequest(path, { token, body, method = 'GET', ...options } = {}) {
  const response = await fetch(`${IPAD_API}${path}`, {
    ...options, method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body != null ? { 'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' } : {}) },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `局域网服务返回 ${response.status}`);
  return result;
}

export async function packIPadModel(mapData) {
  const geometry = mapData?.geometry;
  const positions = geometry?.getAttribute('position'), colors = geometry?.getAttribute('color');
  if (!positions?.count) throw new Error('请先加载独立示教物体');
  const sourceIndex = geometry.getIndex();
  // Preserve source geometry; display budgets are selected locally on the iPad.
  const vertices = positions.count, indices = sourceIndex?.count || 0;
  if (vertices > MAX_MODEL_VERTICES || indices > MAX_MODEL_INDICES || 32 + vertices * 16 + indices * 4 > MAX_MODEL_BYTES) {
    throw new Error('物体超过 iPad 传输上限（500 万顶点、1000 万三角面、192 MiB），请先精简源模型后重试');
  }
  if (indices % 3 !== 0) throw new Error('物体三角面索引不完整');
  const buffer = new ArrayBuffer(32 + vertices * 16 + indices * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x534c5441, true); view.setUint32(4, 1, true);
  view.setUint32(8, vertices, true); view.setUint32(12, indices, true);
  for (let i = 0; i < vertices; i += 1) {
    const source = i;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions.getComponent(source, axis);
      if (!Number.isFinite(value)) throw new Error('物体含无效坐标，无法移动到 iPad');
      view.setFloat32(32 + (i * 3 + axis) * 4, value, true);
      // Three.js vertex colours are linear; SceneKit's vertex colours are linear too.
      view.setUint8(32 + vertices * 12 + i * 4 + axis, colors ? Math.round(Math.max(0, Math.min(1, colors.getComponent(source, axis))) * 255) : [92, 210, 222][axis]);
    }
    view.setUint8(32 + vertices * 12 + i * 4 + 3, 255);
    if (i % 100000 === 99999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < indices; i += 1) {
    const index = sourceIndex.getX(i);
    if (!Number.isInteger(index) || index < 0 || index >= vertices) throw new Error('物体三角面索引越界');
    view.setUint32(32 + vertices * 16 + i * 4, index, true);
    if (i % 500000 === 499999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const modelHash = await sha256Bytes(buffer);
  return { buffer, manifest: { protocol: IPAD_PROTOCOL, modelHash,
    name: mapData.name, sourceHash: mapData.sourceHash || modelHash,
    sourceMapId: mapData.mapId || '', coordinateFrame: 'virtual_origin',
    distanceUnit: 'meter', verticalAxis: 'Z', vertices, indices, sampled: false,
    originalVertices: positions.count, byteLength: buffer.byteLength, bounds: mapData.bounds } };
}

export function readIPadTickets() {
  try { const items = JSON.parse(localStorage.getItem(ticketKey) || '[]'); return Array.isArray(items) ? items : []; }
  catch { return []; }
}

export function rememberIPadTicket(ticket) {
  const tickets = readIPadTickets();
  localStorage.setItem(ticketKey, JSON.stringify([ticket, ...tickets.filter((item) => item.id !== ticket.id)]));
}

export async function ipadResultTask(result, ticket, mapData) {
  validateIPadResult(result, ticket.manifest, ticket.id);
  // Compare actual geometry with the transferred model, never names, IDs or teaching poses.
  const { manifest } = await packIPadModel(mapData);
  if (manifest.modelHash !== ticket.manifest.modelHash || manifest.byteLength !== ticket.manifest.byteLength) {
    throw new Error('当前独立示教物体与 iPad 的模型内容不一致，即使文件同名也无法接收；请打开配对时的模型');
  }
  return { id: `ipad-${result.id}`, name: `iPad 示教 · ${ticket.manifest.name}`,
    createdAt: result.createdAt, updatedAt: result.completedAt, coordinateFrame: 'virtual_origin',
    robot: {}, map: { id: mapData.mapId, fileName: mapData.name, sourceHash: mapData.sourceHash,
      teachingSpaceMode: 'independent', coordinateFrame: 'virtual_origin' },
    parkingPoints: [], mobileCapture: result };
}
