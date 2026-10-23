import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderImmediateMail,renderDigestMail} from '../worker/mail-template.mjs';

const from='CQU Feed <noreply@feed.cqu.moe>';
const title=`通知 <b>标题</b> ${'长'.repeat(520)}`;
const link='https://feed.cqu.moe/articles/event?revision=revision';
const common={from,to:'reader@example.test',manageUrl:'https://feed.cqu.moe/subscriptions',
  productUrl:'https://feed.cqu.moe',messageId:'a11111111111111111111111'};

test('immediate mail preserves identity, full title, escaped HTML, and both links',()=>{
  const mail=renderImmediateMail({...common,label:'内容更新',title,link});

  assert.equal(mail.from,from);
  assert.ok(mail.text.includes(title));
  assert.ok(mail.html.includes('&lt;b&gt;标题&lt;/b&gt;'));
  assert.ok(!mail.html.includes('<b>标题</b>'));
  assert.match(mail.html,/src="https:\/\/feed\.cqu\.moe\/brand\/icon-192\.png"/);
  assert.match(mail.html,/width="32" height="32"/);
  assert.match(mail.html,/>CQU Feed<\/td>/);
  assert.match(mail.html,new RegExp(`href="${link.replaceAll('?','\\?')}"`));
  assert.match(mail.html,/href="https:\/\/feed\.cqu\.moe\/subscriptions"/);
  assert.match(mail.text,/系统通知不支持回复/);
  assert.match(mail.text,/进入 CQU Feed：https:\/\/feed\.cqu\.moe/);
});

test('digest mail preserves every complete item and its original version link',()=>{
  const secondTitle='第二条通知';
  const secondLink='https://feed.cqu.moe/articles/second?revision=second';
  const mail=renderDigestMail({...common,date:'2026-10-12',chunk:1,items:[
    {label:'新通知',title,link},
    {label:'内容更新',title:secondTitle,link:secondLink},
  ]});

  assert.equal(mail.subject,'每日摘要 · 2026-10-12 · 第2批');
  assert.match(mail.html,/>每日摘要<\/h1>/);
  assert.match(mail.html,/2026-10-12 · 第2批/);
  assert.ok(mail.text.includes(title));
  assert.ok(mail.text.includes(secondTitle));
  assert.ok(mail.html.includes('&lt;b&gt;标题&lt;/b&gt;'));
  assert.ok(mail.html.includes(secondTitle));
  assert.ok(mail.html.includes(`href="${link}"`));
  assert.ok(mail.html.includes(`href="${secondLink}"`));
  assert.match(mail.text,/管理订阅：https:\/\/feed\.cqu\.moe\/subscriptions/);
});
