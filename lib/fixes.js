// Builds copy-paste fixes from real page content. Suggestions only: review before publishing.
const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => { s = clean(s); if (s.length <= n) return s; const c = s.slice(0, n - 1), i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[,;:\-–|]+$/, '') + '…'; };
const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const siteNameOf = pages => { const t = clean(pages[0].title), m = t.split(/\s[|\-–—]\s/); const h = new URL(pages[0].url).hostname.replace(/^www\./, '').split('.')[0]; return (m.length > 1 ? m[m.length - 1] : h.charAt(0).toUpperCase() + h.slice(1)).slice(0, 30); };
const slugWords = u => decodeURIComponent(new URL(u).pathname).split('/').filter(Boolean).pop()?.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
const altFrom = src => { const f = decodeURIComponent((src.split('?')[0].split('/').pop() || '')).replace(/\.\w+$/, '').replace(/[-_+]+/g, ' ').replace(/\b\d{2,}x\d{2,}\b/g, '').trim(); return /^[\d a-f]{0,}$/i.test(f) || f.length < 3 ? 'Describe this image (e.g. product name and key feature)' : f.charAt(0).toUpperCase() + f.slice(1); };
function descFrom(p) {
  const s = (p.text || '').split(/(?<=[.!?])\s+/).map(clean).find(x => x.split(' ').length >= 8 && x.length >= 40 && x.length <= 220 && !/cookie|javascript|menu|sign in|log in/i.test(x));
  return cut(s || p.text, 155);
}
function buildFixes({ pages, origin, robotsTxt, sitemap }) {
  const site = siteNameOf(pages), count = (k, v) => pages.filter(p => p[k] === v).length, out = [];
  for (const p of pages) {
    const items = [], topic = (p.headings[0] && p.headings[0].text) || slugWords(p.url) || site;
    if (!p.title || p.title.length < 10 || p.title.length > 70 || count('title', p.title) > 1) {
      const t = cut(`${topic} | ${site}`, 60);
      items.push({ type: 'Title', current: p.title || '(missing)', suggested: t, html: `<title>${esc(t)}</title>` });
    }
    if (!p.description || p.description.length < 50 || p.description.length > 170 || count('description', p.description) > 1) {
      const d = descFrom(p);
      if (d) items.push({ type: 'Meta description', current: p.description || '(missing)', suggested: d, html: `<meta name="description" content="${esc(d)}">`, note: 'Taken from your page text. Rewrite it to sell the page.' });
    }
    if (p.h1Count === 0) { const h = cut(clean((p.title || topic).split(/\s[|\-–—]\s/)[0]), 70); items.push({ type: 'H1 heading', current: '(missing)', suggested: h, html: `<h1>${esc(h)}</h1>` }); }
    for (const src of p.images.samples) { const a = altFrom(src); items.push({ type: 'Image alt text', current: src, suggested: a, html: `alt="${esc(a)}"`, note: 'Guessed from the file name. Make it describe the actual image.' }); }
    if (!p.canonical) items.push({ type: 'Canonical', current: '(missing)', suggested: p.url.split('?')[0], html: `<link rel="canonical" href="${esc(p.url.split('?')[0])}">` });
    if (!p.viewport) items.push({ type: 'Mobile viewport', current: '(missing)', suggested: 'width=device-width, initial-scale=1', html: '<meta name="viewport" content="width=device-width, initial-scale=1">' });
    if (items.length) out.push({ url: p.url, items });
  }
  const files = [];
  if (!robotsTxt) files.push({ name: 'robots.txt', where: origin + '/robots.txt', content: `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /login\n${sitemap ? '' : '# '}Sitemap: ${origin}/sitemap.xml\n` });
  if (!sitemap) files.push({ name: 'sitemap.xml', where: origin + '/sitemap.xml', note: 'Only lists the pages scanned. Most ecommerce platforms can generate a full one.', content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter(p => !p.noindex).map(p => `  <url><loc>${esc(p.url.split('?')[0])}</loc></url>`).join('\n')}\n</urlset>\n` });
  return { pages: out, files, note: 'Suggestions generated from your page content. Rankora does not edit your site. Review, then paste them into your site or platform.' };
}
module.exports = { buildFixes };
