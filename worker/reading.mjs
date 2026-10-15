// Keep the original PDF/HTML in R2; this only removes reader scaffolding from
// the derived, searchable reading text.
export function readingText(value) {
  let text = String(value ?? '');
  const pdfAt = text.search(/^# attachment-\d+\.pdf\s*$/m);
  // Firecrawl's fallback can include site navigation and PDF viewer controls.
  if (pdfAt >= 0 && text.startsWith('[![')) text = text.slice(pdfAt);
  const result = text
    .replace(/^# attachment-\d+\.pdf\s*\n## Metadata\n[\s\S]*?^## Contents\s*$/gm, '')
    .replace(/^### Page \d+\s*$/gm, '')
    .replace(/如果您无法在线浏览此 PDF 文件，则可以[\s\S]*?下载此 PDF 文件/g, '')
    .replace(/附件【[^\n]*?】已下载(?:\d+)?次/g, '')
    .replace(/^(?:上一条|下一条)[：:][^\n]*$/gm, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  return result || (pdfAt >= 0 ? 'PDF 正文暂未提取到可搜索文字；可在下方阅读原文件。' : '');
}
export const readingExcerpt = value => readingText(value).replace(/\s+/g, ' ').slice(0,180);
