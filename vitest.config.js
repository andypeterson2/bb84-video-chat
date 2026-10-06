import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'tests/js/**/test_*.js',
      'tests/js/**/*.test.js',
      'tests/server/**/*.test.js',
      'tests/contract/**/*.test.js',
    ],
    // Minting real keys is slow enough that parallel files starve each other:
    // the heaviest swings 4s to 48s and fails one run in five. Serially, 22s.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
