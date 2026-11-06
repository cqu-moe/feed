import { readFileSync } from 'node:fs';

// git diff --no-renames includes both paths when code moves into docs.
const paths = readFileSync(0, 'utf8').split('\0').filter(Boolean);
const docsOnly = paths.length > 0 && paths.every(path => /^[^/]+\.md$/.test(path) || path.startsWith('docs/'));
console.log(`code=${!docsOnly}`);
