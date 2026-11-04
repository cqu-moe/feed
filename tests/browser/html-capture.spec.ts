import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { makePdf } from './fixtures';

test('a short wrapper with an extensionless embedded PDF keeps its original and snapshot when packing fails',async({page})=>{
  const url='https://school.test/info/123', title='奖学金公示', bytes=makePdf([{text:'SCHOLARSHIP NOTICE'}]);
  await page.route('https://school.test/**',route=>route.request().url().endsWith('/file/42')
    ? route.fulfill({contentType:'application/pdf',body:bytes})
    : route.fulfill({contentType:'text/html; charset=utf-8',body:
      `<title>${title}</title><article><a type="application/pdf" href="/file/42">名单</a><object type="application/pdf" data="/file/42"></object></article>`}));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const {captchaPage}=await import(pathToFileURL(resolve('worker/page-action.mjs')).href);
  const args={title,url,id:'1234567890abcdef12345678',bundle:'throw Error("fixture: offline pack unavailable")',options:{}};
  const report=await page.evaluate<{bodyRecognized:boolean;attachmentCandidates:unknown[];artifacts:{name:string;base64:string}[]}>(`"use strict"; (${captchaPage.toString()})(${JSON.stringify(args)})`);
  expect(report.bodyRecognized).toBe(true);
  expect(report.attachmentCandidates).toMatchObject([{url:'https://school.test/file/42',role:'body-pdf'}]);
  const artifact=(name:string)=>Buffer.from(report.artifacts.find((a:{name:string})=>a.name===name)!.base64,'base64');
  expect(artifact('attachment-1.pdf')).toEqual(bytes);
  const snapshot=artifact('offline.html').toString();
  expect(snapshot).toContain('data-feed-pdf="attachment-1.pdf"');
  expect(snapshot).toContain('部分图片或样式未能离线保存');
});
