import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  test: {
    setupFiles: ['./tests/setup-telemetry.ts'],
    // The SIGKILL campaign has its own command, `npm run test:crash`.
    exclude: [...configDefaults.exclude, 'tests/crash/**'],
  },
});
