export const TEXTIN_MODEL = 'textin-xparse-auto';
export const TEXTIN_CACHE_VERSION = 'v1';

const TEXTIN_PARSE_URL = 'https://api.textin.com/api/v1/xparse/parse/sync';
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180000;
const MAX_SELECTED_PAGES = 20;
const MAX_TABLE_CELLS = 10000;

export function textinConfig(pages) {
  const requestedPages = validatePages(pages);
  return {
    capabilities: {
      include_char_details: true,
      include_table_structure: true,
      pages: true,
      table_view: 'html',
      element_merge_mode: 'separate',
    },
    scope: {page_range: toPageRange(requestedPages)},
    config: {
      force_engine: 'textin',
      engine_params: {parse_mode: 'auto'},
    },
  };
}

export async function textinOcr(env, {bytes, pages, onRawResponse, onRawBody}) {
  if (!env || typeof env.TEXTIN_APP_ID !== 'string' || !env.TEXTIN_APP_ID) throw new Error('TEXTIN_APP_ID is required');
  if (typeof env.TEXTIN_SECRET_CODE !== 'string' || !env.TEXTIN_SECRET_CODE) throw new Error('TEXTIN_SECRET_CODE is required');

  const pdfBytes = asUint8Array(bytes);
  validatePdf(pdfBytes);
  const requestedPages = validatePages(pages);
  if (onRawResponse !== undefined && typeof onRawResponse !== 'function') {
    throw new Error('TextIn OCR onRawResponse must be an async function');
  }
  const config = textinConfig(requestedPages);
  const form = new FormData();
  form.append('file', new Blob([pdfBytes], {type: 'application/pdf'}), 'document.pdf');
  form.append('config', JSON.stringify(config));

  const startedAt = Date.now();
  const response = await fetch(TEXTIN_PARSE_URL, {
    method: 'POST',
    headers: {
      'x-ti-app-id': env.TEXTIN_APP_ID,
      'x-ti-secret-code': env.TEXTIN_SECRET_CODE,
    },
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readBoundedJson(response, onRawBody);
  if (onRawResponse !== undefined) {
    // Persist the paid response before interpretation; parsing may still fail after the provider charge.
    await onRawResponse(payload);
  }
  if (!response.ok || payload?.code !== 200) throw providerError(payload, response.status);
  const result = parseTextinResult(payload, {pages: requestedPages});
  return {...result, elapsedMs: Date.now() - startedAt};
}

export function parseTextinResult(payload, {pages}) {
  const requestedPages = validatePages(pages);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('TextIn OCR returned a non-object response');
  if (payload.code !== 200) throw providerError(payload, null);

  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('TextIn OCR response is missing data');
  if (typeof data.schema_version !== 'string' || !data.schema_version) throw new Error('TextIn OCR response is missing schema_version');
  if (!Array.isArray(data.elements)) throw new Error('TextIn OCR response is missing elements');
  if (!Array.isArray(data.pages)) throw new Error('TextIn OCR response is missing pages');
  const processedPages = data.success_count;
  if (!Number.isSafeInteger(processedPages) || processedPages !== requestedPages.length) {
    throw new Error(`TextIn OCR success_count ${String(processedPages)} does not match ${requestedPages.length} requested pages`);
  }

  const metadata = data.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('TextIn OCR response is missing metadata');
  const totalSourcePages = metadata.page_count;
  if (!Number.isSafeInteger(totalSourcePages) || totalSourcePages <= 0) throw new Error('TextIn OCR metadata.page_count is invalid');
  if (totalSourcePages < Math.max(...requestedPages) + 1) throw new Error('TextIn OCR requested page exceeds metadata.page_count');

  const pageRecords = validateReturnedPages(data.pages, requestedPages);
  const elementsById = validateElements(data.elements, pageRecords);
  validateTableContinuations(data.elements, elementsById);
  const resultPages = requestedPages.map(index => {
    const page = pageRecords.get(index + 1);
    const markdownParts = [];
    for (const elementId of page.element_ids) {
      const element = elementsById.get(elementId);
      if (element.type === 'Table') markdownParts.push(tableToGfm(element.table_structure, elementId));
      else markdownParts.push(elementToMarkdown(element));
    }
    const markdown = markdownParts.filter(Boolean).join('\n\n');
    return {index, markdown, text: markdownToPlainText(markdown)};
  });

  return {
    model: TEXTIN_MODEL,
    requestedModel: TEXTIN_MODEL,
    pages: resultPages,
    usageInfo: {pages_processed: processedPages},
    raw: payload,
    elapsedMs: 0,
    estimatedUsd: 0,
    estimatedCny: null,
    configVersion: TEXTIN_CACHE_VERSION,
  };
}

function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('TextIn OCR pages must be a non-empty zero-based page array');
  if (pages.length > MAX_SELECTED_PAGES) throw new Error(`TextIn OCR selection exceeds ${MAX_SELECTED_PAGES} pages`);
  const seen = new Set();
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 99) throw new Error('TextIn OCR pages must be integers from 0 through 99');
    if (seen.has(page)) throw new Error(`TextIn OCR page ${page} is duplicated`);
    seen.add(page);
  }
  return [...seen].sort((a, b) => a - b);
}

function toPageRange(pages) {
  const ranges = [];
  let start = pages[0];
  let end = pages[0];
  for (const page of pages.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
    start = end = page;
  }
  ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
  return ranges.join(',');
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new Error('TextIn OCR bytes must be an ArrayBuffer or typed array');
}

function validatePdf(bytes) {
  if (bytes.byteLength === 0) throw new Error('TextIn OCR PDF is empty');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('TextIn OCR PDF exceeds 12 MiB');
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    throw new Error('TextIn OCR input must start with %PDF');
  }
}

async function readBoundedJson(response, onRawBody) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('TextIn OCR response exceeds 24 MiB');
  }
  if (!response.body) throw new Error('TextIn OCR response has no body');

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let completed = false;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value?.length) continue;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error('TextIn OCR response exceeds 24 MiB');
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
  // Preserve the original bounded bytes before UTF-8/JSON decoding as well as schema parsing.
  if (onRawBody) await onRawBody(encoded);
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(encoded));
  } catch {
    throw new Error('TextIn OCR returned invalid JSON');
  }
}

function providerError(payload, httpStatus) {
  const code = Number.isSafeInteger(payload?.code) ? payload.code : null;
  // Provider diagnostics can echo request headers. Keep secrets out of persisted workflow errors.
  const detail = code === null ? `HTTP ${httpStatus ?? 'unknown'}` : `provider code ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`;
  const error = new Error(`TextIn OCR failed: ${detail}`);
  if (code !== null) error.code = code;
  return error;
}

function validateReturnedPages(pages, requestedPages) {
  const requested = new Set(requestedPages.map(page => page + 1));
  const records = new Map();
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('TextIn OCR returned an invalid page');
    const pageNumber = page.page_number;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 100) throw new Error('TextIn OCR returned an invalid page_number');
    if (records.has(pageNumber)) throw new Error(`TextIn OCR page ${pageNumber} is duplicated`);
    if (!requested.has(pageNumber)) throw new Error(`TextIn OCR returned out-of-range page ${pageNumber}`);
    if (page.status !== 'Success') throw new Error(`TextIn OCR page ${pageNumber} did not succeed`);
    if (!Array.isArray(page.element_ids) || page.element_ids.some(id => typeof id !== 'string' || !id)) {
      throw new Error(`TextIn OCR page ${pageNumber} has invalid element_ids`);
    }
    records.set(pageNumber, page);
  }
  for (const pageNumber of requested) {
    if (!records.has(pageNumber)) throw new Error(`TextIn OCR response is missing page ${pageNumber}`);
  }
  return records;
}

function validateElements(elements, pageRecords) {
  const elementsById = new Map();
  const idsByPage = new Map();
  for (const [pageNumber, page] of pageRecords) idsByPage.set(pageNumber, new Set(page.element_ids));
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) throw new Error('TextIn OCR returned an invalid element');
    if (typeof element.element_id !== 'string' || !element.element_id) throw new Error('TextIn OCR element is missing element_id');
    if (elementsById.has(element.element_id)) throw new Error(`TextIn OCR element ${element.element_id} is duplicated`);
    if (typeof element.type !== 'string' || !element.type) throw new Error(`TextIn OCR element ${element.element_id} is missing type`);
    if (typeof element.text !== 'string') throw new Error(`TextIn OCR element ${element.element_id} is missing text`);
    const pageNumber = element.page_number;
    if (!Number.isSafeInteger(pageNumber) || !pageRecords.has(pageNumber)) throw new Error(`TextIn OCR element ${element.element_id} has an invalid page_number`);
    const pageIds = idsByPage.get(pageNumber);
    if (!pageIds.has(element.element_id)) throw new Error(`TextIn OCR element ${element.element_id} is not listed on page ${pageNumber}`);
    pageIds.delete(element.element_id);
    elementsById.set(element.element_id, element);
  }
  for (const [pageNumber, remaining] of idsByPage) {
    if (remaining.size) throw new Error(`TextIn OCR page ${pageNumber} references missing element ${[...remaining][0]}`);
  }
  return elementsById;
}

function validateTableContinuations(elements, elementsById) {
  for (const element of elements) {
    if (element.type !== 'Table' || element.metadata?.is_continuation !== true) continue;
    const previousId = element.metadata?.continuation_of;
    if (typeof previousId !== 'string' || !previousId) {
      throw new Error(`TextIn OCR table ${element.element_id} is missing continuation_of`);
    }
    const previous = elementsById.get(previousId);
    // Page subsets and chunks legitimately omit the predecessor page. Validate only returned links.
    if (previous && (previous.type !== 'Table' || previous.page_number >= element.page_number)) {
      throw new Error(`TextIn OCR table ${element.element_id} has an invalid continuation link`);
    }
  }
}

function elementToMarkdown(element) {
  const text = inlineText(element.text);
  if (!text) return '';
  if (element.type === 'Title') {
    const depth = Number(element.metadata?.category_depth);
    if (Number.isSafeInteger(depth) && depth >= 0 && depth < 6) return `${'#'.repeat(depth + 1)} ${text}`;
  }
  if (element.type === 'ListItem') return `- ${text}`;
  return text;
}

function tableToGfm(table, elementId) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`TextIn OCR table ${elementId} is missing table_structure`);
  }
  const rows = table.rows;
  const cols = table.cols;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows <= 0 || cols <= 0 || rows * cols > MAX_TABLE_CELLS) {
    throw new Error(`TextIn OCR table ${elementId} has invalid dimensions`);
  }
  if (!Array.isArray(table.cells) || table.cells.length === 0) throw new Error(`TextIn OCR table ${elementId} has no cells`);
  const grid = Array.from({length: rows}, () => Array.from({length: cols}, () => null));
  for (const cell of table.cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw new Error(`TextIn OCR table ${elementId} has an invalid cell`);
    const row = cell.row;
    const col = cell.col;
    const rowSpan = cell.row_span ?? 1;
    const colSpan = cell.col_span ?? 1;
    if (![row, col, rowSpan, colSpan].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`TextIn OCR table ${elementId} has invalid cell coordinates`);
    }
    if (row + rowSpan - 1 > rows || col + colSpan - 1 > cols) {
      throw new Error(`TextIn OCR table ${elementId} has a cell outside its dimensions`);
    }
    const value = cellContent(cell);
    for (let gridRow = row - 1; gridRow < row - 1 + rowSpan; gridRow++) {
      for (let gridCol = col - 1; gridCol < col - 1 + colSpan; gridCol++) {
        if (grid[gridRow][gridCol] !== null) throw new Error(`TextIn OCR table ${elementId} has overlapping cells`);
        grid[gridRow][gridCol] = value;
      }
    }
  }
  const lines = grid.map((row, index) => `| ${row.map(value => value ?? '').join(' | ')} |`);
  lines.splice(1, 0, `| ${Array.from({length: cols}, () => '---').join(' | ')} |`);
  return lines.join('\n');
}

function cellContent(cell) {
  if (typeof cell.text !== 'string' || cell.text.trim()) return inlineText(cell.text);
  if (cell.content_type && cell.content_type !== 'text') return `[${inlineText(cell.content_type)}]`;
  return '';
}

function inlineText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function markdownToPlainText(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .split('\n')
    .map(line => {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return '';
      return line
        .replace(/^\s{0,3}```.*$/, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-+*]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '');
    })
    .join('\n')
    .replace(/\\([\\|])/g, '$1')
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
