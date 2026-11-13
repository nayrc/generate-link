// Expands Google Maps short links (maps.app.goo.gl/...) by following redirects server-side.
// Browsers cannot do this (CORS hides the redirect target).
//
// Security: this makes the server fetch a URL chosen by a visitor, so
//  - only https and an exact allowlist of Google hosts is accepted, at EVERY hop,
//  - redirects are followed manually (never to a host outside the allowlist),
//  - only the final URL string is returned, never any response content.

const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl', 'goo.gl',
  'www.google.com', 'google.com', 'maps.google.com',
  'www.google.co.id', 'google.co.id',
  'consent.google.com', 'consent.google.co.id',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function checkAllowed(u) {
  if (u.protocol !== 'https:') throw new Error('Hanya link https yang didukung.');
  if (u.username || u.password) throw new Error('Link tidak valid.');
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error('Hanya link Google Maps yang didukung.');
}

async function resolveRedirects(startUrl, fetchImpl = fetch, { maxHops = 6, totalMs = 8000 } = {}) {
  let u;
  try { u = new URL(startUrl); } catch { throw new Error('Link tidak valid.'); }
  const deadline = Date.now() + totalMs;
  for (let hop = 0; hop <= maxHops; hop++) {
    checkAllowed(u);
    // Google's cookie-consent interstitial carries the real target in ?continue=
    if (/^consent\./i.test(u.hostname)) {
      const next = u.searchParams.get('continue');
      if (!next) throw new Error('Link tidak bisa dibuka.');
      u = new URL(next);
      continue;
    }
    // already a full maps URL: nothing to fetch
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.startsWith('/maps')) return u.href;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Link terlalu lama dibuka.');
    let res;
    try {
      res = await fetchImpl(u.href, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(Math.min(left, 5000)),
      });
    } catch {
      throw new Error('Tidak bisa menghubungi Google. Coba lagi, atau buka link itu di browser lalu salin link panjang dari address bar.');
    }
    const loc = res.headers && res.headers.get && res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); continue; }
    return u.href;
  }
  throw new Error('Terlalu banyak pengalihan.');
}

module.exports = { resolveRedirects, ALLOWED_HOSTS };
