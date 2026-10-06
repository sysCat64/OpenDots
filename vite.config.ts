/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  test: { setupFiles: ['./tests/setup-telemetry.ts'] },
});
