import { readFile } from 'node:fs/promises';
import { parseSources } from '../src/api.ts';
import { sourceStatus } from '../src/source-status.ts';

const usage = '用法：pnpm run check:release:sources <来源快照.json> <带时区的采样时间> <预期启用栏目数>';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (args.length !== 3) throw new Error(usage);
  const [snapshot, observedAt, expectedArg] = args;
  const now = Date.parse(observedAt);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(observedAt) || !Number.isFinite(now)) {
    throw new Error('快照时间须包含日期、时间和时区；使用采样时刻，而非当前时间。');
  }
  const expected = Number(expectedArg);
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('请提供本次核验应覆盖的启用栏目数。');
  const payload = JSON.parse(await readFile(snapshot, 'utf8'));
  const sources = parseSources(payload);
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('快照中出现重复栏目 ID。');
  if (sources.some(s => typeof s.enabled !== 'boolean' || typeof s.siteEnabled !== 'boolean')) {
    throw new Error('缺少明确的站点或栏目启用状态，无法确定覆盖范围。');
  }
  const enabled = sources.filter(s => s.enabled && s.siteEnabled);
  if (enabled.length !== expected) throw new Error(`实有 ${enabled.length} 个启用栏目，预期 ${expected} 个。`);
  if (payload.sources.some(s => s.enabled && s.siteEnabled && s.error !== null && typeof s.error !== 'string')) {
    throw new Error('启用栏目缺少明确的错误状态。');
  }
  const problems = [];
  for (const s of enabled) {
    if (!(s.refreshIntervalSec > 0) || !s.validationState ||
        (s.lastRunAt !== null && (!Number.isFinite(Date.parse(s.lastRunAt)) || Date.parse(s.lastRunAt) > now))) {
      throw new Error(`${s.id} 的检查周期、验证状态或时间戳不可用于本次验收。`);
    }
    const status = sourceStatus(s, now);
    if (status.tone !== 'is-ok') problems.push({ source: s, status });
  }
  console.log(`${problems.length ? 'FAIL' : 'PASS'} 栏目检查：${enabled.length - problems.length}/${enabled.length} 个启用栏目正常；${sources.length - enabled.length} 个暂停。采样时间 ${observedAt}。`);
  for (const { source: s, status } of problems) {
    console.log(`  ${s.id}（${s.name}）：${status.label}；最近检查：${s.lastRunAt ?? '无'}`);
  }
  console.log('此结果仅覆盖栏目列表检查；未核验文章正文、附件或快照。');
  return problems.length ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error('无法验收：' + err.message);
  process.exitCode = 2;
}
