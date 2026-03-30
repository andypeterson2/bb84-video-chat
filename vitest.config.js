import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/js/**/test_*.js', 'tests/js/**/*.test.js'],
  },
});
