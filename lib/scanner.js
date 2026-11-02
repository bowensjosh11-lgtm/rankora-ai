const { safeGet, validateUrl, UA } = require('./safe-fetch');
const { buildFixes } = require('./fixes');
const { analyzePage, suggestKeywords, scoreSite, findIssues } = require('./analyze');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SKIP_PATH = /\/(login|log-in|signin|sign-in|signup|register|account|my-account|cart|basket|checkout|admin|wp-admin|wp-login|customer|password)(\/|$|\?)/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|css|js|json|xml|txt|woff2?|ttf)(\?|$)/i;

function parseRobots(txt) {
  const rules = []; let delay = 0, sitemaps = [], active = false, seen = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') { const a = v.toLowerCase(); const hit = a === '*' || a === 'rankorabot'; if (seen && active === false && !hit) {} active = hit; seen = true; }
    else if (k === 'sitemap') sitemaps.push(v);
    else if (active && k === 'crawl-delay') delay = Math.min(parseFloat(v) || 0, 5);
    else if (active && (k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', path: v });
  }
  const rx = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  const allowed = path => { let best = null; for (const r of rules) if (rx(r.path).test(path) && (!best || r.path.length >= best.path.length)) best = r; return !best || best.allow; };
  return { allowed, delay, sitemaps };
}

async function scan(input, opts = {}, progress = () => {}) {
  const o = { maxPages: 10, delayMs: 300, timeout: 8000, allowPrivate: false, maxBroken: 25, ...opts };
  o.maxPages = Math.max(1, Math.min(25, Math.floor(o.maxPages)));
  const net = { timeout: o.timeout, allowPrivate: o.allowPrivate };
  const start = validateUrl(input, { allowPrivate: o.allowPrivate });
  progress(5, 'Fetching homepage…');
  const home = await safeGet(start.href, net);
  const origin = new URL(home.finalUrl).origin, hostName = new URL(home.finalUrl).hostname;
  if (home.status >= 400) throw new Error(`Homepage returned HTTP ${home.status}.`);
  if ([401, 403].includes(home.status)) throw new Error('The site requires login or blocks scanners.');
  if (!/html/i.test(home.headers['content-type'] || '')) throw new Error('The URL did not return an HTML page.');

  progress(12, 'Checking robots.txt and sitemap.xml…');
  let robots = { allowed: () => true, delay: 0, sitemaps: [] }, robotsTxt = false, sitemap = false;
  try { const r = await safeGet(origin + '/robots.txt', { ...net, maxBytes: 200000 }); if (r.status === 200 && !/<html/i.test(r.body.slice(0, 300))) { robotsTxt = true; robots = parseRobots(r.body); } } catch {}
  for (const s of [origin + '/sitemap.xml', ...robots.sitemaps.slice(0, 1)]) {
    try { const r = await safeGet(s, { ...net, maxBytes: 300000 }); if (r.status === 200 && /<(urlset|sitemapindex)/i.test(r.body)) { sitemap = true; break; } } catch {}
  }
  const delay = Math.max(o.delayMs, robots.delay * 1000), errors = [];
  const pathOf = u => { const x = new URL(u); return x.pathname + x.search; };
  if (!robots.allowed(pathOf(home.finalUrl))) throw new Error('robots.txt disallows scanning this page. Rankora respects robots.txt, so the scan was stopped.');

  const pages = [], known = new Map(), seen = new Set([home.finalUrl]);
  const h = analyzePage(home.body, home.finalUrl, home.headers); h.status = home.status; h.truncated = home.truncated; h.redirects = home.redirects; pages.push(h);
  const queue = h.links.internal.filter(u => !SKIP_EXT.test(u) && !SKIP_PATH.test(new URL(u).pathname));
  const isSite = u => new URL(u).hostname.replace(/^www\./, '') === hostName.replace(/^www\./, '');
  while (queue.length && pages.length < o.maxPages) {
    const u = queue.shift(); if (seen.has(u) || !isSite(u)) continue; seen.add(u);
    if (!robots.allowed(pathOf(u))) { errors.push(`${u} — skipped (disallowed by robots.txt)`); continue; }
    progress(15 + Math.round(55 * pages.length / o.maxPages), `Scanning page ${pages.length + 1} of ${o.maxPages}…`);
    await sleep(delay);
    try {
      const r = await safeGet(u, net);
      if ([401, 403].includes(r.status)) { errors.push(`${u} — skipped (HTTP ${r.status}, protected)`); continue; }
      if (r.status >= 400) { known.set(u, r.status); continue; }
      if (r.skippedBinary || !/html/i.test(r.headers['content-type'] || '')) continue;
      const p = analyzePage(r.body, r.finalUrl, r.headers); p.status = r.status; p.truncated = r.truncated; p.redirects = r.redirects; pages.push(p);
      if (r.status === 404 || r.status === 410) { /* recorded in status */ }
    } catch (e) { errors.push(`${u} — ${e.message}`); }
  }
  // Internal link check: scanned pages use known status; others get a HEAD request (capped).
  progress(75, 'Checking internal links…');
  const status = new Map(pages.map(p => [p.url, p.status])), from = new Map(), broken = [];
  pages.forEach(p => p.links.internal.forEach(l => { if (!from.has(l)) from.set(l, p.url); }));
  let checked = 0;
  for (const [l, f] of from) {
    if (SKIP_PATH.test(new URL(l).pathname) || SKIP_EXT.test(l) || !isSite(l) || !robots.allowed(pathOf(l))) continue;
    let st = status.get(l) ?? known.get(l);
    if (st === undefined) { if (checked >= o.maxBroken) continue; await sleep(Math.min(delay, 300)); try { st = (await safeGet(l, { ...net, method: 'HEAD' })).status; if (st === 405 || st === 501) st = (await safeGet(l, net)).status; } catch { st = 0; } }
    checked++;
    if (st >= 400 && ![401, 403, 429].includes(st)) broken.push({ url: l, status: st, from: f });
    else if (st === 0) broken.push({ url: l, status: 'unreachable', from: f });
  }
  progress(92, 'Scoring and generating findings…');
  const ctx = { pages, https: new URL(home.finalUrl).protocol === 'https:', robotsTxt, sitemap, broken, checkedLinks: checked, errors };
  const score = scoreSite(ctx);
  const fixes = buildFixes({ pages, origin, robotsTxt, sitemap });
  return {
    url: start.href, finalUrl: home.finalUrl, scannedAt: new Date().toISOString(), https: ctx.https, robotsTxt, sitemap, score, issues: findIssues(ctx), fixes,
    keywords: suggestKeywords(pages), keywordNote: 'Suggestions extracted from your page content only. These are NOT Google search volume, rankings or traffic data.',
    brokenLinks: broken, checkedLinks: checked, skipped: errors,
    pages: pages.map(({ text, ...p }) => ({ ...p, links: { internal: p.links.internal.length, external: p.links.external } })),
    limits: { maxPages: o.maxPages, userAgent: UA }
  };
}

function toCsv(r) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Section', 'Item', 'Detail', 'Extra']];
  rows.push(['Summary', 'URL', r.finalUrl, ''], ['Summary', 'SEO score', r.score.total + '/100', '']);
  r.score.categories.forEach(c => rows.push(['Category', c.name, `${c.earned}/${c.max}`, '']));
  r.issues.forEach(i => rows.push(['Issue', `[${i.severity}] ${i.title}`, i.affected.join(' | '), `Impact: ${i.impact} Fix: ${i.fix}`]));
  r.pages.forEach(p => rows.push(['Page', p.url, `HTTP ${p.status}; title="${p.title}"; desc=${p.description.length} chars; H1s=${p.h1Count}; imgs missing alt=${p.images.missingAlt}/${p.images.total}; words=${p.wordCount}`, `canonical=${p.canonical || 'none'}; robots=${p.robots}; viewport=${p.viewport}`]));
  r.keywords.forEach(k => rows.push(['Keyword suggestion (not search volume)', k.keyword, 'occurrences ' + k.occurrences, k.foundIn.join(',')]));
  return rows.map(r => r.map(q).join(',')).join('\r\n');
}
module.exports = { scan, parseRobots, toCsv };
