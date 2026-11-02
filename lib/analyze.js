// Lightweight HTML analysis (no external deps).
const STOP = new Set('a about above after all also am an and any are as at be because been before being but by can could did do does for from had has have he her here him his how i if in into is it its just like me more most my no not of on one only or our out over own she so some such than that the their them then there these they this those to too under up us was we were what when where which while who will with would you your get new shop buy view cart home menu search free'.split(' '));
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const strip = s => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function attrs(tag) {
  const o = {}; const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let m;
  tag = tag.replace(/^<\w+/, '');
  while ((m = re.exec(tag))) o[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return o;
}
const host = h => h.toLowerCase().replace(/^www\./, '');

function analyzePage(html, pageUrl, headers = {}) {
  const base = new URL(pageUrl);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const metas = (html.match(/<meta\b[^>]*>/gi) || []).map(attrs);
  const meta = n => (metas.find(m => (m.name || '').toLowerCase() === n) || {}).content;
  const linkTags = (html.match(/<link\b[^>]*>/gi) || []).map(attrs);
  const canon = (linkTags.find(l => /\bcanonical\b/i.test(l.rel || '')) || {}).href;
  const headings = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) { const t = strip(m[2]); if (t) headings.push({ level: +m[1], text: t.slice(0, 200) }); }
  const imgs = (html.match(/<img\b[^>]*>/gi) || []).map(attrs);
  const noAlt = imgs.filter(i => !('alt' in i));
  const images = { total: imgs.length, missingAlt: noAlt.length, samples: noAlt.slice(0, 5).map(i => i.src || i['data-src'] || '(no src)') };
  const links = { internal: [], external: 0 };
  for (const a of (html.match(/<a\b[^>]*>/gi) || []).map(attrs)) {
    if (!a.href || /^(#|mailto:|tel:|javascript:|data:)/i.test(a.href)) continue;
    try {
      const u = new URL(a.href, base); if (!/^https?:$/.test(u.protocol)) continue; u.hash = '';
      if (host(u.hostname) === host(base.hostname)) links.internal.push(u.href); else links.external++;
    } catch {}
  }
  links.internal = [...new Set(links.internal)];
  const text = strip(html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' '));
  const robots = [meta('robots'), headers['x-robots-tag']].filter(Boolean).join(', ').toLowerCase();
  return {
    url: pageUrl, title: title ? strip(title) : '', description: (meta('description') || '').trim(), canonical: canon || '',
    headings, h1Count: headings.filter(h => h.level === 1).length, images, links,
    robots: robots || 'none', noindex: /noindex/.test(robots), viewport: !!meta('viewport'),
    wordCount: text ? text.split(' ').length : 0, text: text.slice(0, 20000)
  };
}

function suggestKeywords(pages, limit = 15) {
  const score = new Map();
  const bump = (k, w, where) => { const e = score.get(k) || { keyword: k, score: 0, count: 0, where: new Set() }; e.score += w; e.count++; e.where.add(where); score.set(k, e); };
  const add = (txt, w, where) => {
    const t = (txt || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    t.forEach((w1, i) => {
      if (!STOP.has(w1)) bump(w1, w, where);
      if (i + 1 < t.length && !STOP.has(w1) && !STOP.has(t[i + 1])) bump(w1 + ' ' + t[i + 1], w * 1.5, where);
    });
  };
  for (const p of pages) {
    add(p.title, 5, 'title'); add(p.headings.filter(h => h.level === 1).map(h => h.text).join(' . '), 4, 'h1');
    add(p.headings.filter(h => h.level > 1).map(h => h.text).join(' . '), 2, 'headings'); add(p.description, 2, 'description'); add(p.text, 0.2, 'body');
  }
  return [...score.values()].filter(e => e.count >= 2 || e.where.has('title') || e.where.has('h1')).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(e => ({ keyword: e.keyword, occurrences: e.count, foundIn: [...e.where] }));
}

const clamp = n => Math.max(0, Math.min(1, n));
function scoreSite({ pages, https, robotsTxt, sitemap, broken, checkedLinks }) {
  const n = pages.length || 1, avg = f => pages.reduce((s, p) => s + f(p), 0) / n;
  const dup = key => { const c = {}; pages.forEach(p => p[key] && (c[p[key]] = (c[p[key]] || 0) + 1)); return p => c[p[key]] > 1; };
  const dT = dup('title'), dD = dup('description');
  const imgT = pages.reduce((s, p) => s + p.images.total, 0), imgM = pages.reduce((s, p) => s + p.images.missingAlt, 0);
  const cats = [
    { key: 'technical', name: 'Technical', max: 25, parts: [
      ['HTTPS', 8, https ? 1 : 0], ['robots.txt present', 3, robotsTxt ? 1 : 0], ['sitemap.xml present', 5, sitemap ? 1 : 0],
      ['Mobile viewport tag', 5, avg(p => p.viewport ? 1 : 0)], ['Indexable pages (no noindex)', 4, avg(p => p.noindex ? 0 : 1)]] },
    { key: 'meta', name: 'Titles & Descriptions', max: 25, parts: [
      ['Titles present, 10-70 chars, unique', 12, avg(p => !p.title ? 0 : (dT(p) || p.title.length < 10 || p.title.length > 70) ? 0.5 : 1)],
      ['Descriptions present, 50-170 chars, unique', 13, avg(p => !p.description ? 0 : (dD(p) || p.description.length < 50 || p.description.length > 170) ? 0.5 : 1)]] },
    { key: 'content', name: 'Headings & Content', max: 20, parts: [
      ['Exactly one H1 per page', 10, avg(p => p.h1Count === 1 ? 1 : p.h1Count > 1 ? 0.5 : 0)],
      ['Content depth (300+ words = full credit)', 10, avg(p => clamp(p.wordCount / 300))]] },
    { key: 'images', name: 'Images', max: 15, parts: [['Images with alt attribute', 15, imgT ? 1 - imgM / imgT : 1]] },
    { key: 'links', name: 'Links & Canonicals', max: 15, parts: [
      ['Working internal links', 10, checkedLinks ? 1 - broken.length / checkedLinks : 1], ['Canonical URL present', 5, avg(p => p.canonical ? 1 : 0)]] }
  ].map(c => {
    const parts = c.parts.map(([label, max, r]) => ({ label, max, earned: +(max * clamp(r)).toFixed(1) }));
    return { key: c.key, name: c.name, max: c.max, earned: +parts.reduce((s, p) => s + p.earned, 0).toFixed(1), parts };
  });
  return { total: Math.round(cats.reduce((s, c) => s + c.earned, 0)), categories: cats };
}

function findIssues({ pages, https, robotsTxt, sitemap, broken, errors }) {
  const I = [];
  const add = (severity, category, title, affected, impact, fix) => { if (affected.length) I.push({ severity, category, title, affected, impact, fix }); };
  const urls = f => pages.filter(f).map(p => p.url);
  const dupes = key => { const g = {}; pages.forEach(p => p[key] && (g[p[key]] = g[p[key]] || []).push(p.url)); return Object.values(g).filter(a => a.length > 1).flat(); };
  if (!https) I.push({ severity: 'high', category: 'technical', title: 'Site is not served over HTTPS', affected: [], impact: 'Browsers warn visitors, shoppers lose trust, and HTTPS is a Google ranking signal.', fix: "Install a TLS certificate (free via Let's Encrypt or your host) and 301-redirect all HTTP URLs to HTTPS." });
  if (!robotsTxt) I.push({ severity: 'low', category: 'technical', title: 'robots.txt not found', affected: [], impact: 'Crawlers have no guidance about which areas (cart, checkout, filters) to skip.', fix: 'Add /robots.txt that blocks cart/checkout/account pages and links to your sitemap.' });
  if (!sitemap) I.push({ severity: 'medium', category: 'technical', title: 'sitemap.xml not found', affected: [], impact: 'Search engines may discover new products and collections more slowly.', fix: 'Generate a sitemap.xml (most ecommerce platforms have a setting or app) and submit it in Google Search Console.' });
  add('high', 'meta', 'Missing page title', urls(p => !p.title), 'Search engines show a generic or auto-generated title, hurting rankings and click-through.', 'Add a unique <title> of 30-60 characters that includes the main product or category keyword.');
  add('medium', 'meta', 'Duplicate page titles', dupes('title'), 'Pages compete with each other and are hard to tell apart in search results.', 'Write a unique title for each page.');
  add('low', 'meta', 'Title length outside 10-70 characters', urls(p => p.title && (p.title.length < 10 || p.title.length > 70)), 'Short titles waste ranking space; long ones get truncated in results.', 'Aim for roughly 30-60 characters.');
  add('medium', 'meta', 'Missing meta description', urls(p => !p.description), 'Google will pick random page text for the snippet, which usually lowers click-through.', 'Add a 70-160 character description summarising the page with a reason to click.');
  add('low', 'meta', 'Duplicate meta descriptions', dupes('description'), 'Identical snippets make pages look redundant.', 'Write a unique description per page.');
  add('high', 'content', 'Missing H1 heading', urls(p => p.h1Count === 0), 'The H1 tells users and crawlers what the page is about.', 'Add one clear H1 containing the main topic or product name.');
  add('low', 'content', 'Multiple H1 headings', urls(p => p.h1Count > 1), 'Diluted page focus and unclear structure.', 'Keep a single H1 and use H2/H3 for sub-sections.');
  add('medium', 'content', 'Thin content (under 150 words)', urls(p => p.wordCount < 150), 'Pages with little text give search engines little to rank and shoppers little to read.', 'Add useful descriptions, specs, FAQs or buying guidance.');
  add('high', 'images', 'Images missing alt text', pages.filter(p => p.images.missingAlt).map(p => `${p.url} (${p.images.missingAlt} of ${p.images.total} images)`), 'Hurts accessibility and image search visibility.', 'Add short descriptive alt text to each product/content image (use alt="" only for decorative images).');
  add('medium', 'technical', 'No mobile viewport meta tag', urls(p => !p.viewport), 'Page may render zoomed-out on phones; mobile-friendliness affects rankings.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  add('high', 'technical', 'Page blocked by noindex', urls(p => p.noindex), 'The page will not appear in search results.', 'Remove noindex if the page should rank.');
  add('low', 'links', 'Missing canonical URL', urls(p => !p.canonical), 'Duplicate URL variants (filters, tracking parameters) may split ranking signals.', 'Add <link rel="canonical"> pointing to the preferred URL.');
  add('high', 'links', 'Broken internal links (4xx/5xx)', broken.map(b => `${b.url} → ${b.status} (linked from ${b.from})`), 'Visitors hit dead ends and crawlers waste budget.', 'Fix or redirect the broken URLs, or remove the links.');
  add('medium', 'technical', 'Pages returned an error status', pages.filter(p => p.status >= 400).map(p => `${p.url} → ${p.status}`), 'Error pages cannot rank.', 'Restore the page or 301-redirect it.');
  if ((errors || []).length) I.push({ severity: 'info', category: 'technical', title: 'Some pages were skipped or could not be scanned', affected: errors, impact: 'Findings cover only pages that were reachable and allowed.', fix: 'Check the listed URLs manually.' });
  const o = { high: 0, medium: 1, low: 2, info: 3 };
  return I.sort((a, b) => o[a.severity] - o[b.severity]);
}
module.exports = { analyzePage, suggestKeywords, scoreSite, findIssues };
