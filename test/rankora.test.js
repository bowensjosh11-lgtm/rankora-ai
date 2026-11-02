const test = require('node:test'), assert = require('node:assert'), http = require('http'), os = require('os'), path = require('path');
const { validateUrl, isPrivateIp, safeGet } = require('../lib/safe-fetch');
const { analyzePage, scoreSite } = require('../lib/analyze');
const { scan, parseRobots, toCsv } = require('../lib/scanner');
const { createServer } = require('../server'); const { openDb } = require('../lib/db');

test('validateUrl accepts public and blocks unsafe targets', () => {
  assert.strictEqual(validateUrl('example.com').href, 'https://example.com/');
  for (const bad of ['http://localhost', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:7f00:1]', 'ftp://example.com', 'file:///etc/passwd', 'http://user:pw@example.com', 'http://intranet', 'http://example.com:22', '', 'javascript:alert(1)'])
    assert.throws(() => validateUrl(bad), bad);
});
test('isPrivateIp', () => { for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', 'fd00::1']) assert.ok(isPrivateIp(ip)); assert.ok(!isPrivateIp('93.184.216.34')); });
test('parseRobots', () => { const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 1\nSitemap: https://x.com/s.xml'); assert.ok(!r.allowed('/private/a')); assert.ok(r.allowed('/private/ok')); assert.ok(r.allowed('/')); assert.strictEqual(r.delay, 1); });
test('analyzePage extracts SEO data', () => {
  const p = analyzePage('<html><head><title>T &amp; Co</title><meta name="description" content="d"><meta name="viewport" content="width=device-width"><link rel="canonical" href="/x"><meta name="robots" content="noindex"></head><body><h1>Hi</h1><img src=a.jpg><img src=b.jpg alt="b"><a href="/a">a</a><a href="https://other.com">o</a></body></html>', 'https://s.com/');
  assert.strictEqual(p.title, 'T & Co'); assert.strictEqual(p.h1Count, 1); assert.strictEqual(p.images.missingAlt, 1); assert.ok(p.viewport && p.noindex);
  assert.deepStrictEqual(p.links.internal, ['https://s.com/a']); assert.strictEqual(p.links.external, 1);
});
test('score is out of 100 and transparent', () => {
  const s = scoreSite({ pages: [analyzePage('<title>x</title>', 'https://a.com/')], https: true, robotsTxt: false, sitemap: false, broken: [], checkedLinks: 0 });
  assert.ok(s.total >= 0 && s.total <= 100); assert.strictEqual(s.categories.reduce((a, c) => a + c.max, 0), 100);
});

// Local fixture site (private IPs allowed ONLY via test option)
const long = 'Handmade leather wallets and bags crafted for everyday carry. '.repeat(30);
const pagesMap = {
  '/': `<html><head><title>Leather Goods Store - Handmade Wallets</title><meta name="description" content="Shop handmade leather wallets, bags and belts crafted to last a lifetime with free shipping."><meta name="viewport" content="width=device-width"><link rel="canonical" href="/"></head><body><h1>Leather wallets</h1><p>${long}</p><img src="a.jpg"><a href="/about">About</a><a href="/missing">Gone</a><a href="/secret">Secret</a><a href="/login">Login</a></body></html>`,
  '/about': `<html><head><title>Leather Goods Store - Handmade Wallets</title></head><body><p>short</p></body></html>`
};
const fixture = () => new Promise(ok => { const s = http.createServer((q, r) => {
  if (q.url === '/robots.txt') { r.end('User-agent: *\nDisallow: /secret\nDisallow: /login'); return; }
  if (q.url === '/sitemap.xml') { r.setHeader('content-type', 'application/xml'); r.end('<urlset></urlset>'); return; }
  if (q.url === '/redir') { r.writeHead(302, { Location: 'http://127.0.0.1:1/' }); r.end(); return; }
  if (pagesMap[q.url]) { r.setHeader('content-type', 'text/html'); r.end(pagesMap[q.url]); return; }
  r.statusCode = 404; r.setHeader('content-type', 'text/html'); r.end('nope'); }).listen(0, '127.0.0.1', () => ok(s)); });

test('scanner end-to-end on fixture site', async () => {
  const s = await fixture(), base = `http://127.0.0.1:${s.address().port}/`;
  try {
    const stages = []; const r = await scan(base, { allowPrivate: true, delayMs: 0 }, (p, m) => stages.push(p));
    assert.strictEqual(r.pages.length, 2); assert.ok(r.robotsTxt && r.sitemap && !r.https);
    const titles = r.issues.map(i => i.title);
    for (const t of ['Site is not served over HTTPS', 'Duplicate page titles', 'Missing meta description', 'Missing H1 heading', 'Images missing alt text', 'Broken internal links (4xx/5xx)']) assert.ok(titles.includes(t), t);
    assert.ok(r.brokenLinks.some(b => b.url.endsWith('/missing') && b.status === 404));
    assert.ok(r.skipped.some(x => x.includes('/secret')), 'robots-disallowed page skipped');
    assert.ok(!r.pages.some(p => /login|secret/.test(p.url)));
    assert.ok(r.keywords.some(k => /leather/.test(k.keyword))); assert.ok(r.keywordNote.includes('NOT Google'));
    assert.ok(toCsv(r).includes('SEO score')); assert.ok(stages.length > 3);
  } finally { s.close(); }
});
test('unsafe redirect and private targets are blocked without allowPrivate', async () => {
  await assert.rejects(safeGet('http://127.0.0.1:9/'), /blocked/i);
  const s = await fixture();
  try { await assert.rejects(safeGet(`http://127.0.0.1:${s.address().port}/redir`), /blocked/i); await assert.rejects(safeGet(`http://localhost:${s.address().port}/`), /blocked/i); } finally { s.close(); }
});
test('size limit and API validation', async () => {
  const big = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('x'.repeat(50000)); }).listen(0, '127.0.0.1');
  await new Promise(r => big.on('listening', r));
  const r = await safeGet(`http://127.0.0.1:${big.address().port}/`, { allowPrivate: true, maxBytes: 1000 }); assert.ok(r.truncated); big.close();
  const srv = createServer({ db: openDb(path.join(os.tmpdir(), `r${Date.now()}.sqlite`)) }); await new Promise(r => srv.listen(0, r)); const b = `http://127.0.0.1:${srv.address().port}`;
  for (const url of ['http://localhost', 'http://10.0.0.1', 'nonsense url', '']) { const x = await fetch(b + '/api/scans', { method: 'POST', body: JSON.stringify({ url }) }); assert.strictEqual(x.status, 400, url); }
  assert.strictEqual((await fetch(b + '/api/settings', { method: 'PUT', body: JSON.stringify({ maxPages: 999 }) })).status, 400);
  assert.strictEqual((await fetch(b + '/')).status, 200); srv.close();
});
test('API scan saves history in DB', async () => {
  const s = await fixture(), srv = createServer({ db: openDb(path.join(os.tmpdir(), `h${Date.now()}.sqlite`)), scanOptions: { allowPrivate: true, delayMs: 0 } });
  await new Promise(r => srv.listen(0, r)); const b = `http://127.0.0.1:${srv.address().port}`;
  const { id } = await (await fetch(b + '/api/scans', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${s.address().port}/` }) })).json();
  let row; for (let i = 0; i < 50; i++) { row = await (await fetch(`${b}/api/scans/${id}`)).json(); if (row.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  assert.strictEqual(row.status, 'done'); assert.ok(row.score >= 0); assert.strictEqual((await (await fetch(b + '/api/scans')).json()).length, 1);
  assert.ok((await (await fetch(`${b}/api/scans/${id}/report.csv`)).text()).includes('Summary')); s.close(); srv.close();
});
