import { Fragment } from 'react';
import { removeReadingNoise } from '../shared/reading-noise.mjs';

export type ReadingCell = { text: string; header: boolean; rowSpan: number; colSpan: number };
export type ReadingTable = { start: number; end: number; rows: ReadingCell[][] };

export function readingParagraphs(value: string): string[] {
  return removeReadingNoise(value.replace(/\r\n/g, '\n'))
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph && paragraph !== 'PDF 正文暂未提取到可搜索文字；可在下方阅读原文件。');
}

export function TableProse({ text, tables, tablesOnly = false }: {
  text: string; tables: ReadingTable[]; tablesOnly?: boolean;
}) {
  const prose = (part: string) => !tablesOnly && readingParagraphs(part).map((p, i) => <p key={i}>{p}</p>);
  return <>
    {tables.map(({ start, end, rows }, i) => (
      <Fragment key={end}>
        {prose(text.slice(tables[i - 1]?.end ?? 0, start))}
        <div className="feed-markdown-table feed-source-table" role="region" aria-label={`通知表格 ${i + 1}`} tabIndex={0}>
          <table><tbody>
            {rows.map((row, r) => <tr key={r}>
              {row.map(({ text, header, rowSpan, colSpan }, c) => {
                const Cell = header ? 'th' : 'td';
                return <Cell key={c} rowSpan={rowSpan} colSpan={colSpan}>{text}</Cell>;
              })}
            </tr>)}
          </tbody></table>
        </div>
      </Fragment>
    ))}
    {prose(text.slice(tables.at(-1)?.end ?? 0))}
  </>;
}
