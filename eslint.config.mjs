// Flat config (fleet lint baseline): @eslint/js recommended + complexity
// budgets over the browser client and its vitest suites. Python is ruff's job
// (ruff.toml); this file owns the JS half of the repo.
import js from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';

// Complexity budgets. Cognitive complexity is the primary metric — it punishes
// nesting, not flat readable constructs — so the core `complexity` rule stays
// off (no double-charging).
const complexityBudgets = {
  'sonarjs/cognitive-complexity': ['error', 15],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-nested-callbacks': ['error', 3],
};

const sharedRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  ...complexityBudgets,
};

export default [
  { ignores: ['node_modules/**', 'website/client/static/vendor/**'] },
  {
    // The ES-module client libs (BB84 protocol stack, crypto, signaling, …).
    files: ['website/client/static/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { sonarjs },
    rules: sharedRules,
  },
  {
    // The page bootstrap — a classic <script>, loaded before the module graph.
    files: ['website/client/static/app.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        io: 'readonly', // socket.io client from the CDN <script> tag
      },
    },
    plugins: { sonarjs },
    rules: sharedRules,
  },
  {
    // The Insertable-Streams crypto worker — an ES-module Web Worker (it imports
    // the shared crypto.js), loaded with `type: 'module'`.
    files: ['website/client/static/js/crypto-worker.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.worker },
    },
    plugins: { sonarjs },
    rules: sharedRules,
  },
  {
    // The bootstrap's main call-flow function sits at cognitive complexity 80 —
    // grandfathered at the config level (the file is mid-refactor on the
    // api-contract branch); the budget stays on for everything else.
    files: ['website/client/static/app.js'],
    rules: { 'sonarjs/cognitive-complexity': 'off' },
  },
  {
    // Vitest suites (jsdom; vitest.config.js sets globals: true).
    files: ['tests/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.vitest },
    },
    plugins: { sonarjs },
    rules: {
      ...sharedRules,
      // Test files legitimately nest describe/test/callback structures.
      'max-nested-callbacks': ['error', 5],
    },
  },
];
