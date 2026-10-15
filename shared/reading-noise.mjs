// Shared by ingestion and legacy browser reading. Leave paragraph layout and
// authored attachment indexes to the caller; only remove known site scaffolding.
export function removeReadingNoise(text) {
  return text
    .replace(/附件【[^\n】]*】已下载[ \t]*(?:\d+)?次/g, '')
    .replace(/^(?:上一条|下一条)[：:][^\n]*$/gm, '');
}
