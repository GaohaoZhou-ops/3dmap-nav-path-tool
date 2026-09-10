export async function sha256ArrayBuffer(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256 地图指纹');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
