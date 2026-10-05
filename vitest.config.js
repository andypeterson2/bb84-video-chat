import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/js/**/test_*.js', 'tests/js/**/*.test.js'],
    // Exceeds the harness's 45s mint wait, or a test aborts before its own wait
    // reports. A mint is ~25 frames, and these files share one core.
    testTimeout: 60000,
  },
});
