import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BASE } from './browser/state.mjs';

export const PRODUCT_PATHS = [
  'src', 'worker', 'migrations', 'e2e', 'public', 'scripts', 'shared', '.design',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
  'tsconfig.browser.json', 'vite.config.ts', 'wrangler.jsonc', 'index.html',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

export async function verifyImmutableProductBase() {
  try {
    git(['merge-base', '--is-ancestor', BASE, 'HEAD']);
  } catch {
    throw new Error('DEPLOYED_BASE_NOT_ANCESTOR');
  }
  try {
    git(['diff', '--exit-code', BASE, '--', ...PRODUCT_PATHS]);
  } catch {
    throw new Error('PRODUCT_PATHS_CHANGED_FROM_DEPLOYED_BASE');
  }
  // Include ignored files: an unreviewed file inside a product path must not be
  // silently admitted merely because a local ignore rule hides it from status.
  const untracked = git(['ls-files', '--others', '--directory', '--', ...PRODUCT_PATHS]).trim();
  if (untracked) throw new Error('UNTRACKED_PRODUCT_PATH');

  const files = git(['ls-files', '--', ...PRODUCT_PATHS]).split('\n').filter(Boolean);
  const hashes = {};
  for (const path of files) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  return { base: BASE, ancestry: true, productPathsUnchanged: PRODUCT_PATHS, fileHashes: hashes };
}
