export const OCR_MODELS = Object.freeze({
  'mistral-ocr-2512': { label: 'OCR 3', usdPerPage: 0.002 },
  'mistral-ocr-4-1': { label: 'OCR 4.1', usdPerPage: 0.004 },
});

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_SELECTED_PAGES = 100;

export async function mistralOcr(env, { bytes, pages, model }) {
  const modelConfig = Object.hasOwn(OCR_MODELS,model??'') ? OCR_MODELS[model] : null;
  if (!modelConfig) throw new Error(`Unsupported Mistral OCR model: ${String(model)}`);
  if (!env || typeof env.MISTRAL_API_KEY !== 'string' || !env.MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY is required');
  }

  const pdfBytes = asUint8Array(bytes);
  if (pdfBytes.byteLength === 0) throw new Error('OCR PDF is empty');
  if (pdfBytes.byteLength > MAX_PDF_BYTES) throw new Error('OCR PDF exceeds 12 MiB');
  if (pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50 || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46) {
    throw new Error('OCR input must start with %PDF');
  }

  if (!Array.isArray(pages) || pages.length === 0) throw new Error('OCR pages must be a non-empty 0-based page array');
  if (pages.length > MAX_SELECTED_PAGES) throw new Error('OCR selection exceeds 100 pages');
  const seenPages = new Set();
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 0 || page >= 100) throw new Error('OCR pages must be non-negative integers below 100');
    if (seenPages.has(page)) throw new Error(`OCR page ${page} is duplicated`);
    seenPages.add(page);
  }
  const requestedPages = [...seenPages].sort((a, b) => a - b);

  const startedAt = Date.now();
  const response = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      document: {
        type: 'document_url',
        document_url: `data:application/pdf;base64,${base64Encode(pdfBytes)}`,
      },
      pages: requestedPages,
      table_format: null,
      include_image_base64: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await readBoundedJson(response);
  if (!response.ok) {
    throw new Error(`Mistral OCR HTTP ${response.status}: ${providerError(payload).slice(0, 300)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Mistral OCR returned a non-object response');

  const usageInfo = payload.usage_info;
  if (!usageInfo || typeof usageInfo !== 'object' || Array.isArray(usageInfo)) throw new Error('Mistral OCR response is missing usage_info');
  if (!Number.isSafeInteger(usageInfo.pages_processed) || usageInfo.pages_processed <= 0 || usageInfo.pages_processed > 100) {
    throw new Error('Mistral OCR usage_info.pages_processed is invalid');
  }
  if (usageInfo.pages_processed < requestedPages.length) {
    throw new Error(`Mistral OCR processed ${usageInfo.pages_processed} pages, fewer than the ${requestedPages.length} requested`);
  }
  if (usageInfo.doc_size_bytes != null && (!Number.isSafeInteger(usageInfo.doc_size_bytes) || usageInfo.doc_size_bytes < 0)) {
    throw new Error('Mistral OCR usage_info.doc_size_bytes is invalid');
  }
  if (typeof payload.model !== 'string' || !payload.model) throw new Error('Mistral OCR response is missing model');
  if (!Array.isArray(payload.pages)) throw new Error('Mistral OCR response is missing pages');

  const returnedIndices = new Set();
  for (const page of payload.pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('Mistral OCR returned an invalid page');
    if (!Number.isSafeInteger(page.index) || page.index < 0) throw new Error('Mistral OCR returned an invalid page index');
    if (returnedIndices.has(page.index)) throw new Error(`Mistral OCR page ${page.index} is duplicated`);
    if (!seenPages.has(page.index)) throw new Error(`Mistral OCR returned out-of-range page ${page.index}`);
    if (typeof page.markdown !== 'string') throw new Error(`Mistral OCR page ${page.index} is missing markdown`);
    if (page.tables != null && !Array.isArray(page.tables)) throw new Error(`Mistral OCR page ${page.index} has invalid tables`);
    returnedIndices.add(page.index);
  }
  for (const page of requestedPages) {
    if (!returnedIndices.has(page)) throw new Error(`Mistral OCR response is missing page ${page}`);
  }

  const resultPages = payload.pages
    .map((page) => ({
      index: page.index,
      markdown: expandTables(page),
      text: markdownToPlainText(expandTables(page)),
    }))
    .sort((a, b) => a.index - b.index);

  return {
    requestedModel: model,
    model: payload.model,
    pages: resultPages,
    usageInfo,
    raw: payload,
    elapsedMs: Date.now() - startedAt,
    estimatedUsd: roundUsd(usageInfo.pages_processed * modelConfig.usdPerPage),
  };
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new Error('OCR bytes must be an ArrayBuffer or typed array');
}

function base64Encode(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Mistral OCR response exceeds 8 MiB');
  }
  if (!response.body) throw new Error('Mistral OCR response has no body');

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value?.length) continue;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Mistral OCR response exceeds 8 MiB');
      chunks.push(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }

  const encoded = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Mistral OCR returned invalid JSON');
  }
}

function providerError(payload) {
  if (!payload || typeof payload !== 'object') return 'Unknown error';
  for (const key of ['message', 'error', 'detail']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
  }
  return 'Unknown error';
}

function expandTables(page) {
  const tables = Array.isArray(page.tables) ? page.tables : [];
  const tableContents = tables.map((table, index) => {
    if (!table || typeof table !== 'object') throw new Error(`Mistral OCR table ${index} is invalid`);
    if (typeof table.content === 'string') return table.content;
    for (const key of ['markdown', 'html', 'text']) {
      if (typeof table[key] === 'string') return table[key];
    }
    throw new Error(`Mistral OCR table ${index} is missing content`);
  });

  let expanded = page.markdown;
  const usedTables = new Set();
  expanded = expanded.replace(/\[(tbl-[^\]]*)\]\((tbl-[^)]*)\)/g, (match,label,target) => {
    let index=tables.findIndex(table=>table.id===target||table.id===label);
    if(index<0)index=tables.findIndex((table,i)=>!table.id&&!usedTables.has(i));
    if(index<0)throw new Error('Mistral OCR table placeholder has no matching content');
    usedTables.add(index);return tableContents[index];
  });
  const remainingTables = tableContents.filter((value,index)=>!usedTables.has(index));
  if (remainingTables.length) expanded += `\n\n${remainingTables.join('\n\n')}`;
  return expanded;
}

function markdownToPlainText(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .split('\n')
    .map((line) => {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return '';
      return line
        .replace(/^\s{0,3}```.*$/, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-+*]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '');
    })
    .join('\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => safeCodePoint(Number(decimal)))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(codePoint) {
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : ' ';
}

function roundUsd(value) {
  return Math.round(value * 1000000) / 1000000;
}
