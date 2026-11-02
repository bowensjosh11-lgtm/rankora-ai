// Safe public-web fetcher: SSRF protection, redirect validation, timeouts, size caps.
const http = require('http'), https = require('https'), dns = require('dns'), net = require('net');
const UA = 'RankoraBot/1.0 (+SEO scanner; respects robots.txt)';

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) {
      const r = l.slice(7);
      if (r.includes(':')) { const [a, b] = r.split(':').map(x => parseInt(x, 16)); return isPrivateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
      return isPrivateIp(r);
    }
    return /^(fc|fd|fe[89ab])/.test(l);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n))) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || a >= 224;
}

function validateUrl(input, { allowPrivate = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Please enter a URL.');
  let s = input.trim();
  if (s.length > 2048) throw new Error('URL is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed.');
  if (allowPrivate) return u;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan'))
    throw new Error('Local and internal hosts are blocked.');
  if (net.isIP(h) && isPrivateIp(h)) throw new Error('Private or reserved IP addresses are blocked.');
  if (!net.isIP(h) && !h.includes('.')) throw new Error('Please enter a full public domain name.');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error('Only standard web ports are allowed.');
  return u;
}

const guardedLookup = allowPrivate => (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate && addrs.some(a => isPrivateIp(a.address))) return cb(new Error('Blocked: host resolves to a private address'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
};

function once(url, { method, timeout, maxBytes, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method, timeout, lookup: guardedLookup(allowPrivate), agent: false,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' }
    }, res => {
      const type = String(res.headers['content-type'] || '');
      if (method === 'HEAD' || (res.statusCode >= 300 && res.statusCode < 400)) { res.resume(); return resolve({ status: res.statusCode, headers: res.headers, body: '', truncated: false }); }
      if (/^(image|video|audio)\/|application\/(pdf|zip|octet-stream)/i.test(type)) { res.destroy(); return resolve({ status: res.statusCode, headers: res.headers, body: '', truncated: false, skippedBinary: true }); }
      const chunks = []; let size = 0, truncated = false, finished = false;
      res.on('data', c => { size += c.length; if (size > maxBytes) { truncated = true; res.destroy(); } else chunks.push(c); });
      const done = () => { if (finished) return; finished = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated }); };
      res.on('end', done); res.on('close', done); res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function safeGet(input, { method = 'GET', timeout = 8000, maxBytes = 1_500_000, maxRedirects = 4, allowPrivate = false } = {}) {
  let url = validateUrl(String(input), { allowPrivate });
  const chain = [];
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await once(url, { method, timeout, maxBytes, allowPrivate });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      let next;
      try { next = validateUrl(new URL(r.headers.location, url).href, { allowPrivate }); }
      catch (e) { throw new Error('Unsafe redirect blocked: ' + e.message); }
      chain.push(url.href); url = next; continue;
    }
    return { ...r, finalUrl: url.href, redirects: chain };
  }
  throw new Error('Too many redirects');
}
module.exports = { isPrivateIp, validateUrl, safeGet, UA };
