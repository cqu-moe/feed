const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const baseText='font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;';

export function renderImmediateMail({from,to,label,title,link,manageUrl,productUrl,messageId}){
  checkSender(from);
  const subject=`${label}：${title}`.replace(/[\r\n]/g,' ').slice(0,200);
  const text=`CQU Feed\n${label}\n${title}\n阅读原版本：${link}\n管理订阅：${manageUrl}\n\n系统通知不支持回复。\n进入 CQU Feed：${productUrl}`;
  return {from,to,subject,text,
    html:document(escape(subject),`
      <p class="mail-muted" style="margin:0 0 8px;font-size:13px;line-height:1.4;color:#576070">${escape(label)}</p>
      <h1 class="mail-title" style="margin:0 0 24px;font-size:24px;line-height:1.35;color:#111827;word-break:break-word">${escape(title)}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="border-radius:6px;background:#2563eb">
        <a href="${escape(link)}" style="display:inline-block;padding:12px 22px;font-size:16px;line-height:1.4;color:#ffffff;text-decoration:none">阅读原版本</a>
      </td></tr></table>
      <p class="mail-body mail-muted" style="margin:0;font-size:16px;line-height:1.6;color:#576070"><a href="${escape(manageUrl)}" style="color:#576070">管理订阅</a></p>
    `,productUrl),
    tags:[{name:'feed_message_id',value:messageId}]};
}

export function renderDigestMail({from,to,date,chunk=0,items,manageUrl,productUrl,messageId}){
  checkSender(from);
  const batch=chunk?` · 第${chunk+1}批`:'', heading=`每日摘要 · ${date}${batch}`;
  const rows=items.map((item,index)=>`
      <div class="mail-item" style="padding:18px 0;${index?'border-top:1px solid #e6e8eb;':''}">
        <p class="mail-muted" style="margin:0 0 6px;font-size:13px;line-height:1.4;color:#576070">${escape(item.label)}</p>
        <p class="mail-body" style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#111827;word-break:break-word">${escape(item.title)}</p>
        <p style="margin:0;font-size:13px;line-height:1.5"><a class="mail-link" href="${escape(item.link)}" style="color:#2563eb">阅读原版本</a></p>
      </div>`.trim()).join('');
  const text=`CQU Feed\n${heading}\n\n${items.map(item=>`【${item.label}】${item.title}\n阅读原版本：${item.link}`).join('\n\n')}\n\n管理订阅：${manageUrl}\n\n系统通知不支持回复。\n进入 CQU Feed：${productUrl}`;
  return {from,to,subject:heading,text,
    html:document(escape(heading),`
      <h1 class="mail-title" style="margin:0 0 8px;font-size:24px;line-height:1.35;color:#111827">每日摘要</h1>
      <p class="mail-muted" style="margin:0 0 24px;font-size:13px;line-height:1.4;color:#576070">${escape(date)}${batch?` · 第${chunk+1}批`:''}</p>${rows}
      <p class="mail-body mail-muted" style="margin:24px 0 0;font-size:16px;line-height:1.6;color:#576070"><a href="${escape(manageUrl)}" style="color:#576070">管理订阅</a></p>
    `,productUrl),
    tags:[{name:'feed_message_id',value:messageId}]};
}

function document(title,body,productUrl){
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${title}</title>
<style>
@media only screen and (max-width:600px){.mail-cell{padding:20px!important}.mail-page{padding:12px 0!important}}
@media (prefers-color-scheme:dark){.mail-page{background:#111827!important}.mail-card{background:#17212b!important}.mail-title{color:#f3f4f6!important}.mail-body{color:#e5e7eb!important}.mail-link{color:#93c5fd!important}.mail-muted,.mail-muted a{color:#c3cad4!important}.mail-item{border-top-color:#374151!important}.mail-rule{background:#374151!important}}
[data-color-scheme=dark] .mail-page{background:#111827!important}[data-color-scheme=dark] .mail-card{background:#17212b!important}[data-color-scheme=dark] .mail-title{color:#f3f4f6!important}[data-color-scheme=dark] .mail-body{color:#e5e7eb!important}[data-color-scheme=dark] .mail-link{color:#93c5fd!important}[data-color-scheme=dark] .mail-muted,[data-color-scheme=dark] .mail-muted a{color:#c3cad4!important}[data-color-scheme=dark] .mail-item{border-top-color:#374151!important}[data-color-scheme=dark] .mail-rule{background:#374151!important}
</style></head>
<body class="mail-page" style="margin:0;padding:24px 12px;background:#f5f6f8;${baseText}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" class="mail-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px">
<tr><td class="mail-cell" style="padding:32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="32" style="padding-right:10px"><img src="https://feed.cqu.moe/brand/icon-192.png" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0"></td>
<td class="mail-title" style="font-size:16px;line-height:32px;font-weight:600;color:#111827">CQU Feed</td>
</tr></table>
<div class="mail-rule" style="height:1px;line-height:1px;margin:24px 0;background:#e6e8eb"></div>
${body}
<div class="mail-rule" style="height:1px;line-height:1px;margin:24px 0;background:#e6e8eb"></div>
<p class="mail-muted" style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#576070">系统通知不支持回复。</p>
<p class="mail-muted" style="margin:0;font-size:13px;line-height:1.5;color:#576070"><a href="${escape(productUrl)}" style="color:#576070">进入 CQU Feed</a></p>
</td></tr></table></td></tr></table></body></html>`;
}

function checkSender(from){
  if(typeof from!=='string'||!from||/[\r\n]/.test(from))throw new Error('mail_sender_missing');
}
