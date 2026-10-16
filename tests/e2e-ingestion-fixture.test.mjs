import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionFixture } from '../e2e/ingestion-runtime.mjs';

test('external ingestion dates follow the Shanghai source calendar across UTC midnight boundaries', async t => {
  for (const { instant, today, historical } of [
    { instant: '2026-10-15T15:59:59Z', today: '2026-10-15', historical: '2026-10-05' },
    { instant: '2026-10-15T16:05:42Z', today: '2026-10-16', historical: '2026-10-06' },
    { instant: '2026-12-31T16:00:00Z', today: '2027-01-01', historical: '2026-12-22' },
  ]) {
    const clock = t.mock.method(Date, 'now', () => Date.parse(instant));
    try {
      const fixture = createIngestionFixture();
      const list = async path => {
        const response = await fixture.outbound(new Request('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST', body: JSON.stringify({ url: `https://school.example.test${path}`, formats: ['links'] }),
        }));
        assert.equal(response.status, 200);
        const { data } = await response.json();
        return JSON.parse(data.actions.javascriptReturns[0].value);
      };
      const first = await list('/lists/a');
      const second = await list('/lists/a/page2');
      assert.deepEqual(first.articles.map(article => article.publishedAt), [`${today} 09:01`, `${historical} 09:03`], instant);
      assert.equal(second.articles[0].publishedAt, `${today} 09:02`, instant);
    } finally {
      clock.mock.restore();
    }
  }
});
