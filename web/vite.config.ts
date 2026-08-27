import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path can be overridden to match the server's --base when hosting under a
// reverse-proxy sub-path (e.g. ANTERM_BASE=/term  ->  VITE_BASE=/term/).
const base = process.env.VITE_BASE ?? '/';
const serverTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces (127.0.0.1, ::1, LAN)
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      '/ws': { target: serverTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: [
            '@xterm/xterm',
            '@xterm/addon-fit',
            '@xterm/addon-web-links',
            '@xterm/addon-search',
            '@xterm/addon-clipboard',
          ],
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
});
