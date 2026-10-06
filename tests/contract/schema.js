/**
 * Shared helper for the API contract tests.
 *
 * Validates responses against the JSON Schemas in `schemas/`, vendored from the
 * website repo's `docs/api-contract/schemas/`. The schemas are the cross-repo
 * agreement every backend keeps: `/health` liveness, the `/api` discovery
 * manifest, and the 4xx/5xx error envelope.
 *
 * The signaling app is importable here, so these tests drive a real server on
 * an OS-assigned port rather than skipping when nothing is listening. They run
 * on every CI push: a response that stops matching the schema fails the build.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map();

function validator(name) {
  let compiled = validators.get(name);
  if (!compiled) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
    compiled = ajv.compile(schema);
    validators.set(name, compiled);
  }
  return compiled;
}

/** Throw unless `instance` validates against `schemas/<name>.schema.json`. */
export function assertMatches(name, instance) {
  const compiled = validator(name);
  if (compiled(instance)) return;
  const first = compiled.errors?.[0];
  throw new Error(
    `${name} schema violation: ${first?.instancePath || '/'} ${first?.message ?? 'invalid'}\n` +
      `instance: ${JSON.stringify(instance).slice(0, 400)}`,
  );
}
