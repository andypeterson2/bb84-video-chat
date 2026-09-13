import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/js/**/test_*.js', 'tests/js/**/*.test.js'],
    // Real crypto key mints can exceed the 5s default under parallel CI load;
    // heavy tests may raise it further.
    testTimeout: 15000,
  },
});
