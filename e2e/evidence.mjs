import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertSelectedAttemptCleanup(report) {
  if (report.run.results.some(result => result.selected && result.attempts.some(attempt =>
    attempt.cleanup === 'failed' || attempt.secondaryErrors?.some(error => error.phase === 'cleanup')))) {
    throw new Error('Selected browser attempt cleanup failed; original details remain in report.json');
  }
}

export function redact(input, values) {
  let text = input;
  for (const value of values) {
    text = text.replaceAll(value, '[redacted]').replaceAll(encodeURIComponent(value), '[redacted]');
  }
  return text
    .replace(/([?&])(?:token|state|code|nonce)=[^&\s"'<>]+/g, '$1redacted')
    .replace(/(?:token|state|code|nonce)%3D[^%\s"'<>]+/gi, 'redacted')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._+/=-]+/gi, '$1[redacted]')
    .replace(/__(?:Host-)?feed_(?:session|login)=[^;\s"']+/gi, '__Host-feed_session=[redacted]');
}
export async function exportPublic(source, destination, values) {
  await mkdir(destination, { recursive: true });
  async function copy(from, to) {
    await mkdir(to, { recursive: true });
    const names = new Set();
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'public') continue;
      const name = redact(entry.name, values);
      if (names.has(name)) throw new Error('Redacted artifact filenames collide');
      names.add(name);
      const src = join(from, entry.name), dst = join(to, name);
      if (entry.isDirectory()) await copy(src, dst);
      else if (entry.name.endsWith('.json')) {
        const parsed = JSON.parse(await readFile(src, 'utf8'));
        const clean = (value) => typeof value === 'string' ? redact(value, values)
          : Array.isArray(value) ? value.map(clean)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v)]))
          : value;
        await writeFile(dst, JSON.stringify(clean(parsed), null, 2) + '\n');
      } else if (/\.(txt|md|log)$/.test(entry.name)) await writeFile(dst, redact(await readFile(src, 'utf8'), values));
      // This suite never restores cookies: e2e withholds pixels after the first credential fill.
      else if (entry.name.endsWith('.png')) await copyFile(src, dst);
    }
  }
  await copy(source, destination);
  // Text redaction changes byte counts; exported artifact metadata must describe exported bytes.
  const reportPath = join(destination, 'report.json');
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function update(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.artifacts)) {
      const artifacts = [];
      for (const artifact of value.artifacts) {
        // Step artifacts are IDs; only attempt artifacts describe files.
        if (typeof artifact === 'string') { artifacts.push(artifact); continue; }
        try {
          const bytes = await readFile(join(destination, 'results', artifact.path));
          artifacts.push({ ...artifact, size: bytes.byteLength, sha256: sha(bytes) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      value.artifacts = artifacts;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) { for (const item of child) await update(item); }
      else if (child && typeof child === 'object') await update(child);
    }
  }
  if (report) {
    await update(report);
    const exportedIds = new Set(report.run.results.flatMap(result => result.attempts ?? []).flatMap(attempt => attempt.artifacts.map(artifact => artifact.id)));
    for (const result of report.run.results) for (const attempt of result.attempts ?? []) {
      for (const step of attempt.steps) {
        step.artifacts = step.artifacts.filter(id => exportedIds.has(id));
      }
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(json|txt|md|log)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        if (values.some(value => value && (text.includes(value) || text.includes(encodeURIComponent(value))))) throw new Error('Sensitive synthetic value in public evidence');
      }
    }
  }
  await inspect(destination);
}
