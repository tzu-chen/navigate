import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        // Deliberately NOT changeOrigin. The walkthrough bundle is served into a
        // sandboxed, opaque-origin iframe, and its CSP has to name the origin the
        // *browser* sees in order to allow the vendored three.js/MathJax assets.
        // The server derives that from the Host header, so rewriting Host here
        // would emit a CSP for localhost:3001 while the page loads from :5173.
        changeOrigin: false,
      },
    },
  },
});
