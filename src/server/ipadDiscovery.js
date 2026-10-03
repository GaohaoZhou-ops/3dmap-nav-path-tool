import { Bonjour } from 'bonjour-service';
import { IPAD_PROTOCOL } from '../lib/ipadProtocol.js';

export const IPAD_SERVICE_TYPE = 'atlas-teach';

// Publish only once HTTP is listening, and retire the advertisement with it.
export function advertiseIPadService(httpServer, { serverId, serverName, onError = () => {} }) {
  let bonjour, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    httpServer.off('listening', start); httpServer.off('close', stop);
    if (!bonjour) return;
    const instance = bonjour; bonjour = undefined;
    let destroyed = false;
    const destroy = () => { if (!destroyed) { destroyed = true; clearTimeout(timer); instance.destroy(); } };
    const timer = setTimeout(destroy, 1000); timer.unref();
    instance.unpublishAll(destroy);
  };
  const start = () => {
    const address = httpServer.address();
    if (stopped || bonjour || !address || typeof address === 'string' || /^(127\.|::1$)/.test(address.address)) return;
    try {
      bonjour = new Bonjour(undefined, (error) => { onError(error); stop(); });
      const suffix = ` (${address.port})-${serverId.slice(0, 6)}`;
      let name = 'Atlas';
      for (const char of ` ${serverName}`) {
        if (Buffer.byteLength(name + char + suffix) > 63) break;
        name += char;
      }
      bonjour.publish({ name: name + suffix, type: IPAD_SERVICE_TYPE, protocol: 'tcp', port: address.port,
        disableIPv6: true, txt: { protocol: IPAD_PROTOCOL, id: serverId } });
    } catch (error) { onError(error); stop(); }
  };
  httpServer.once('close', stop);
  if (httpServer.listening) start(); else httpServer.once('listening', start);
  return stop;
}
