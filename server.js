const http = require('http'), fs = require('fs'), path = require('path');
const { openDb } = require('./lib/db'); const { scan, toCsv } = require('./lib/scanner'); const { validateUrl } = require('./lib/safe-fetch');

function createServer({ db = openDb(), scanOptions = {} } = {}) {
  db.failStale(); const progress = new Map(), hits = new Map();
  const send = (res, code, data, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
  const body = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => { s += c; if (s.length > 10000) { bad(new Error('Body too large')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('Invalid JSON')); } }); });
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname; let m;
    try {
      if (p.startsWith('/api/')) {
        if (req.method === 'POST' && p === '/api/scans') {
          const ip = req.socket.remoteAddress, now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
          if (h.length >= 10) return send(res, 429, { error: 'Too many scans. Wait a minute and retry.' }); hits.set(ip, [...h, now]);
          const b = await body(req); let url;
          try { url = validateUrl(b.url, { allowPrivate: scanOptions.allowPrivate }); } catch (e) { return send(res, 400, { error: e.message }); }
          const s = db.settings(), id = db.create(url.href); progress.set(id, { pct: 1, message: 'Starting…' });
          const maxPages = Number.isFinite(+b.maxPages) && b.maxPages ? +b.maxPages : s.maxPages;
          scan(url.href, { maxPages, delayMs: s.delayMs, timeout: s.timeout, ...scanOptions }, (pct, message) => progress.set(id, { pct, message }))
            .then(r => db.finish(id, r)).catch(e => db.fail(id, e.message)).finally(() => progress.delete(id));
          return send(res, 202, { id });
        }
        if (req.method === 'GET' && p === '/api/scans') return send(res, 200, db.list());
        if ((m = p.match(/^\/api\/scans\/(\d+)(\/report\.csv)?$/))) {
          const id = +m[1], row = db.get(id); if (!row) return send(res, 404, { error: 'Not found' });
          if (req.method === 'DELETE') { db.remove(id); return send(res, 200, { ok: true }); }
          if (m[2]) return row.result ? send(res, 200, toCsv(row.result), 'text/csv', { 'Content-Disposition': `attachment; filename="rankora-scan-${id}.csv"` }) : send(res, 409, { error: 'Scan not finished' });
          return send(res, 200, { ...row, progress: progress.get(id) || null });
        }
        if (p === '/api/settings') {
          if (req.method === 'PUT') {
            const b = await body(req), lim = { maxPages: [1, 25], delayMs: [0, 5000], timeout: [2000, 15000] };
            for (const [k, [lo, hi]] of Object.entries(lim)) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) return send(res, 400, { error: `${k} must be between ${lo} and ${hi}` }); db.setSetting(k, Math.round(n)); }
          }
          return send(res, 200, db.settings());
        }
        return send(res, 404, { error: 'Not found' });
      }
      const file = p === '/' ? 'index.html' : p.slice(1), full = path.join(__dirname, 'public', file);
      if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'text/plain');
    } catch (e) { send(res, 400, { error: e.message }); }
  });
}
module.exports = { createServer };
if (require.main === module) { const port = process.env.PORT || 3000; createServer().listen(port, '0.0.0.0', () => console.log(`Rankora AI running on http://localhost:${port}`)); }
