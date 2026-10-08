import { defineConfig } from 'vitest/config';

// The real-process crash and restart suite (DEC-12): `npm run test:crash`.
// Slow and destructive by design (it starts child processes and kills them with
// SIGKILL), so the default `npm test` excludes tests/crash. Node 24 only. Every
// database is a throwaway under the OS temp directory.
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24)
  throw new Error(
    `test:crash runs on Node 24 only (this is Node ${process.versions.node}).`,
  );

export default defineConfig({
  test: {
    include: ['tests/crash/**/*.test.ts'],
    setupFiles: ['./tests/setup-telemetry.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One file at a time: each test starts and kills processes.
    fileParallelism: false,
  },
});
