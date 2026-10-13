import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../src/lib/csv.js';
import { api, createTestApp, login, pageview, sendEvent, type TestApp } from './helpers.js';

describe('csv escaping', () => {
  it('neutralises formulas and quotes properly', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvRow(['a', null, 3])).toBe('a,,3\r\n');
  });

  it('neutralises full-width formula characters and leading control characters', () => {
    expect(csvCell('\uff1dcmd|calc')).toBe("'\uff1dcmd|calc");
    expect(csvCell('\uff0b1')).toBe("'\uff0b1");
    expect(csvCell('\uff0d1')).toBe("'\uff0d1");
    expect(csvCell('\uff20SUM(A1)')).toBe("'\uff20SUM(A1)");
    expect(csvCell('\u0000=1+1')).toBe("'\u0000=1+1");
    expect(csvCell('\u0001x')).toBe("'\u0001x");
    expect(csvCell('\u007fx')).toBe("'\u007fx");
    expect(csvCell('\nx')).toBe(`"'\nx"`);
    // only a leading character matters
    expect(csvCell('a\uff1db')).toBe('a\uff1db');
  });
});

describe('GET /api/sites/:id/export', () => {
  let t: TestApp;
  let cookie: string;
  let siteId: string;

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await login(t.app);
    siteId = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/=cmd|calc', { referrer: 'https://news.ycombinator.com/' }));
    await sendEvent(t.app, {
      site: siteId,
      type: 'event',
      url: 'https://example.com/x',
      name: '=EVIL()',
      props: { note: 'has "quotes", commas' },
    });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/other'), { ip: '192.0.2.99' });
    // many rows to exercise batching
    for (let i = 0; i < 1100; i++) {
      t.ctx.db
        .prepare(
          `INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES (?, ?, 'pageview', 'v', 's', 'example.com', ?)`,
        )
        .run(siteId, t.clock.t - 1000 - i, `/bulk/${i}`);
    }
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('streams a CSV attachment with escaped cells', async () => {
    const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ptr-analytics-[a-z0-9]{12}-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe(
      'timestamp,type,name,hostname,path,referrer,utm_source,utm_medium,utm_campaign,utm_term,utm_content,country,device,browser,os,props',
    );
    expect(lines).toHaveLength(1 + 1103 + 1); // header + rows + trailing empty
    expect(res.body).toContain(`event,'=EVIL(),example.com,/x`);
    expect(res.body).toContain(`"{""note"":""has \\""quotes\\"", commas""}"`);
    expect(res.body).toContain('ycombinator.com');
    // ordered by time
    const ts = lines.slice(1, -1).map((l) => l.split(',')[0] as string);
    expect([...ts].sort()).toEqual(ts);
  });

  it('respects filters', async () => {
    const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d&referrer=news.ycombinator.com`);
    expect(res.body.trim().split('\r\n')).toHaveLength(2);
    const ev = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d&event=%3DEVIL()`);
    const rows = ev.body.trim().split('\r\n').slice(1);
    // the event itself + the pageview of the same visitor
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.includes(',event,'))).toBe(true);
  });

  it('pages through rows sharing a timestamp exactly once, in order', async () => {
    const tie = t.ctx.sites.create('Ties', ['ties.com'], t.clock.t).id;
    const ins = t.ctx.db.prepare(
      `INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES (?, ?, 'pageview', 'v', 's', 'ties.com', ?)`,
    );
    t.ctx.db.transaction(() => {
      for (let i = 0; i < 2500; i++) ins.run(tie, t.clock.t - 5000 - (i % 3), `/t/${i}`);
    })();
    const res = await api(t.app, cookie, 'GET', `/api/sites/${tie}/export?period=7d`);
    const paths = res.body
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(',')[4] as string);
    expect(paths).toHaveLength(2500);
    expect(new Set(paths).size).toBe(2500);
    // within each timestamp, rows come in insertion (id) order
    const expected = [2, 1, 0].flatMap((r) => Array.from({ length: 2500 }, (_, i) => i).filter((i) => i % 3 === r)).map((i) => `/t/${i}`);
    expect(paths).toEqual(expected);
  });

  it('requires authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/export` })).statusCode).toBe(401);
  });
});
