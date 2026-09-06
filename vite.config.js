import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomUUID } from 'node:crypto';

function workspaceSessionPlugin() {
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  const installSessionEndpoint = (middlewares) => {
    middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__atlas/session') {
        next();
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.end(JSON.stringify({ sessionId, startedAt }));
    });
  };

  return {
    name: 'atlas-workspace-session',
    configureServer(server) {
      installSessionEndpoint(server.middlewares);
    },
    configurePreviewServer(server) {
      installSessionEndpoint(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), workspaceSessionPlugin()],
  publicDir: 'maps',
  server: {
    host: '127.0.0.1',
    port: 21990,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 21990,
    strictPort: true,
  },
});
