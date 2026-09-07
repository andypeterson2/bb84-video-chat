import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/js/**/test_*.js', 'tests/js/**/*.test.js'],
    // The auth/reservoir suites run real crypto and wait for keys to mint;
    // under parallel CI load a single mint can exceed the 5s default, so give
    // the whole suite headroom (individual heavy tests may raise it further).
    testTimeout: 15000,
  },
});
