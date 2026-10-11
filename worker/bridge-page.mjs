// A separate top-level page under our origin; no school cookies leave Firecrawl.
export function bridgeHTML(grant) {
  const input = JSON.stringify(grant).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Temporary OCR bridge</title><p>Temporary cloud OCR bridge.</p><script>
  const grant = ${input};
  const parentWindow = window.opener;
  const reply = data => parentWindow?.postMessage({ channel: grant.channel, ...data }, grant.origin);
  window.addEventListener('message', async event => {
    if (event.source !== parentWindow || event.origin !== grant.origin || event.data?.channel !== grant.channel || !['solve','upload'].includes(event.data?.type)) return;
    const { slot, image, mime } = event.data;
    try {
      const uploading=event.data.type==='upload';
      const response = await fetch(uploading?'/internal/upload':'/internal/solve', { method:'POST', headers:uploading?{ 'Content-Type':'application/octet-stream', 'X-Grant':grant.token, 'X-Filename':event.data.name }:{ 'Content-Type':'application/json', 'X-Grant':grant.token }, body:uploading?event.data.bytes:JSON.stringify({ slot, image, mime }), signal:AbortSignal.timeout(uploading?60000:45000) });
      const value = await response.json();
      reply({ type:'result', slot, ...value, httpStatus:response.status });
    } catch { reply({ type:'result', slot, error:'Bridge request failed' }); }
  });
  reply({ type:'ready', hasOpener:!!parentWindow });
  </script>`;
}
