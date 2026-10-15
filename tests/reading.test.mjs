import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingText, readingExcerpt } from '../worker/reading.mjs';

test('reading text and excerpts remove site counters but preserve paragraphs and authored attachment indexes', () => {
  const source = [
    '各学院：',
    '请提交材料。',
    '附件【报名表.doc】已下载 3次',
    '附件【说明.doc】已下载次',
    '上一条：旧通知',
    '下一条：新通知',
    '附件：1. 优异生指标\n2. 优异生申请表',
    '附件【作者保留的说明】',
    '教务处',
  ].join('\n\n');
  assert.equal(readingText(source), '各学院：\n\n请提交材料。\n\n附件：1. 优异生指标\n2. 优异生申请表\n\n附件【作者保留的说明】\n\n教务处');
  assert.equal(readingExcerpt(source), '各学院： 请提交材料。 附件：1. 优异生指标 2. 优异生申请表 附件【作者保留的说明】 教务处');
});
