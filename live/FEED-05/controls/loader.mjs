import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';

// Test boundary only: the actual launchers/cases run; external browser and
// framework entry points stop before acquiring any real resource or identity.
export async function resolve(specifier, context, next) {
  const modules = {
    '@playwright/test': `export const chromium = {
      executablePath() { throw new Error('CONTROL_BROWSER_BOUNDARY'); },
      launchPersistentContext() { return globalThis.controlContext(); }
    };`,
    '@e2e-dev/web': 'export function test(name, options, body) { globalThis.controlBody = body; }',
    e2e: `export const credentials = {}, secrets = {};
      export function expect() { throw new Error('UNEXPECTED_UI_BOUNDARY'); }`,
  };
  if (Object.hasOwn(modules, specifier)) return {
    url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true,
  };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: transformSync(await readFile(new URL(url), 'utf8'), { loader: 'ts', format: 'esm' }).code };
  return next(url, context);
}
