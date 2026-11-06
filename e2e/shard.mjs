export function selectShard(items, specification) {
  if (specification === undefined) return items;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(specification);
  if (!match) throw new Error(`Invalid shard ${JSON.stringify(specification)}; use <current>/<total>`);
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(total) || current > total || total > items.length) throw new Error(`Shard ${current}/${total} is out of range`);
  return items.filter((_, index) => index % total === current - 1);
}
