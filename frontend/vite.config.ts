/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '',
  build: {
    outDir: '../src/agentos/gateway/webui_dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Lets the dev app fetch bootstrap via /control/bootstrap.json; the
      // control-UI base_path is auth-exempt, so the dev flow needs no token.
      '/control': {
        target: 'http://127.0.0.1:18791',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:18791',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:18791',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
