/* Route import: Google Maps links, KML files, bike routing, elevation (DEM tiles).
   Browser: window.RouteImport. Pure parts also work in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const MAX_ROUTE_KM = 600;

  function haversineKm(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // =====================================================================
  // Google Maps link parsing
  // =====================================================================
  function extractUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0].replace(/[)\].,;]+$/, '') : null;
  }
  const isShortHost = h => /^(maps\.app\.goo\.gl|goo\.gl)$/i.test(h);
  const isGoogleHost = h => /^((www|maps)\.)?google\.(com|co\.id|co\.uk|com\.au|com\.sg|com\.my|co\.in|de|fr|nl|es|it|ca)$/i.test(h) || isShortHost(h);

  function parseCoord(str) {
    const m = String(str).match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }
  const decodeSeg = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')).trim(); } catch { return s.replace(/\+/g, ' ').trim(); } };

  // returns { kind: 'dir' | 'place' | 'unknown', waypoints: [{lat,lon,name?} | {query}], missing: number }
  function parseGoogleMapsUrl(href) {
    let u;
    try { u = new URL(href); } catch { return { kind: 'unknown', waypoints: [], missing: 0 }; }
    const toWp = raw => {
      const c = parseCoord(raw);
      return c || { query: decodeSeg(raw) };
    };
    const finish = (kind, wps) => ({ kind, waypoints: wps, missing: wps.filter(w => w.lat == null).length });

    // --- query style: ?api=1&origin=..&destination=..&waypoints=a|b  /  saddr + daddr ---
    const q = u.searchParams;
    if (q.get('destination') || q.get('daddr')) {
      const wps = [];
      const origin = q.get('origin') || q.get('saddr');
      if (origin) wps.push(toWp(origin));
      for (const w of (q.get('waypoints') || '').split('|').filter(Boolean)) wps.push(toWp(w));
      const dest = q.get('destination') || q.get('daddr');
      for (const d of dest.split(/\s+to:/i).filter(Boolean)) wps.push(toWp(d));
      return finish('dir', wps);
    }

    // --- path style: /maps/dir/A/B/C/@lat,lng,zoom/data=... ---
    const segs = u.pathname.split('/');
    const iDir = segs.indexOf('dir');
    if (iDir >= 0 && segs[iDir - 1] === 'maps') {
      const names = [];
      let data = '';
      for (let i = iDir + 1; i < segs.length; i++) {
        const sgm = segs[i];
        if (sgm.startsWith('@')) continue;
        if (sgm.startsWith('data=')) { data = sgm; continue; }
        if (sgm === '') continue;                         // empty origin = "my location": cannot be used
        names.push(sgm);
      }
      const wps = names.map(toWp);
      // coordinates that Google already resolved for named places live in the data= blob (lon = !1d, lat = !2d)
      const named = wps.filter(w => w.query != null);
      const found = [...data.matchAll(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)].map(m => ({ lon: +m[1], lat: +m[2] }));
      if (named.length && found.length === named.length) named.forEach((w, i) => { w.lat = found[i].lat; w.lon = found[i].lon; });
      return finish('dir', wps);
    }

    if (/\/maps\/(place|search)\//.test(u.pathname) || q.get('q') || q.get('query')) return finish('place', []);
    return finish('unknown', []);
  }

  // short links (maps.app.goo.gl) cannot be followed from the browser: the server expands them
  async function resolveShortLink(href, fetchImpl) {
    const f = fetchImpl || fetch;
    let r;
    try { r = await f('/api/resolve?url=' + encodeURIComponent(href)); }
    catch { throw new Error('Tidak bisa membuka link pendek. Buka link itu di browser, lalu salin link panjang dari address bar.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error((j && j.error) || 'Link pendek tidak bisa dibuka. Salin link panjang dari address bar.');
    return j.url;
  }

  // =====================================================================
  // geocoding + bike routing
  // =====================================================================
  async function fetchJson(url, ms = 20000, fetchImpl, init) {
    const f = fetchImpl || fetch;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      const r = await f(url, ctl ? { ...(init || {}), signal: ctl.signal } : init);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  async function geocode(query, fetchImpl) {
    const j = await fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query), 15000, fetchImpl);
    if (!j.length) throw new Error(`Tempat "${query}" tidak ditemukan.`);
    return { lat: +j[0].lat, lon: +j[0].lon };
  }

  async function routeBike(wps, fetchImpl) {
    const errors = [];
    // 1) FOSSGIS OSRM with the bicycle profile (OpenStreetMap data)
    try {
      const coords = wps.map(w => `${w.lon},${w.lat}`).join(';');
      const j = await fetchJson(`https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson`, 25000, fetchImpl);
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.code === 'NoRoute' ? 'tidak ada jalur sepeda' : (j.code || 'respons kosong'));
      return { coords: j.routes[0].geometry.coordinates.map(c => [c[0], c[1], 0, null, null]), hasEle: false, via: 'osrm-bike' };
    } catch (e) { errors.push('OSRM: ' + e.message); }
    // 2) BRouter (trekking profile, includes elevation)
    try {
      const lonlats = wps.map(w => `${w.lon},${w.lat}`).join('|');
      const j = await fetchJson(`https://brouter.de/brouter?lonlats=${lonlats}&profile=trekking&alternativeidx=0&format=geojson`, 30000, fetchImpl);
      const g = j.features && j.features[0] && j.features[0].geometry;
      if (!g || !g.coordinates || g.coordinates.length < 2) throw new Error('respons kosong');
      return { coords: g.coordinates.map(c => [c[0], c[1], c[2] || 0, null, null]), hasEle: g.coordinates.some(c => c[2]), via: 'brouter' };
    } catch (e) { errors.push('BRouter: ' + e.message); }
    throw new Error('Layanan rute sepeda tidak merespons (' + errors.join('; ') + '). Coba lagi sebentar lagi, atau upload file GPX.');
  }

  // short readable label from the waypoint names
  function routeLabel(wps) {
    const short = w => w.query ? w.query.split(',')[0].trim() : null;
    const a = short(wps[0]), b = short(wps[wps.length - 1]);
    if (a && b) return a.toLowerCase() === b.toLowerCase() ? `Loop ${a}` : `${a} → ${b}`;
    return 'Rute Google Maps';
  }

  // =====================================================================
  // elevation from terrarium DEM tiles (same tiles the 3D map uses)
  // =====================================================================
  const demCache = new Map();
  async function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (demCache.has(key)) return demCache.get(key);
    const p = (async () => {
      try {
        const r = await fetch(DEM_URL(z, x, y));
        if (!r.ok) return null;
        const blob = await r.blob();
        let bmp;
        try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
        catch { bmp = await createImageBitmap(blob); }
        const cv = document.createElement('canvas'); cv.width = cv.height = 256;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, 256, 256).data;
      } catch { return null; }
    })();
    demCache.set(key, p);
    return p;
  }
  function worldPx(lon, lat, z) {
    const n = 2 ** z * 256, s = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

  // points: [[lon, lat]] -> array of elevations (m)
  async function sampleElevations(points, opts) {
    const o = opts || {};
    const z = o.z || 13;
    const px = points.map(p => worldPx(p[0], p[1], z));
    const need = new Map();
    for (const [x, y] of px) {
      const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
      for (const xx of [x0, x0 + 1]) for (const yy of [y0, y0 + 1]) {
        const tx = Math.floor(xx / 256), ty = Math.floor(yy / 256);
        need.set(`${tx}/${ty}`, [tx, ty]);
      }
    }
    const list = [...need.values()], tiles = new Map();
    let done = 0, failed = 0, next = 0;
    async function worker() {
      while (next < list.length) {
        const [tx, ty] = list[next++];
        const d = await loadTile(z, tx, ty);
        if (d) tiles.set(`${tx}/${ty}`, d); else failed++;
        done++;
        if (o.onProgress) o.onProgress(done, list.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    if (failed > list.length * 0.25) throw new Error('Data elevasi tidak bisa diambil (koneksi?).');
    const at = (xx, yy) => {
      const d = tiles.get(`${Math.floor(xx / 256)}/${Math.floor(yy / 256)}`);
      if (!d) return NaN;
      const i = ((yy - Math.floor(yy / 256) * 256) * 256 + (xx - Math.floor(xx / 256) * 256)) * 4;
      return terrarium(d[i], d[i + 1], d[i + 2]);
    };
    return px.map(([x, y]) => {
      const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), fx = x - 0.5 - x0, fy = y - 0.5 - y0;
      const v = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
      const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let sum = 0, ws = 0;
      v.forEach((e, i) => { if (!isNaN(e)) { sum += e * w[i]; ws += w[i]; } });
      return ws > 0 ? sum / ws : 0;
    });
  }

  function densify(pts, maxStepKm) {
    const out = [pts[0].slice(0, 2)];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = haversineKm(a, b), k = Math.max(1, Math.ceil(d / maxStepKm));
      for (let j = 1; j <= k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    return out;
  }

  // raw: [[lon, lat, ele, time, hr]] -> same shape with elevation from the DEM (smoothed against pixel noise)
  async function withElevation(raw, onStatus) {
    const keep = raw.some(p => p[3] != null);                 // recorded tracks keep their own vertices (times / heart rate)
    const base = keep ? raw : densify(raw, 0.04).map(p => [p[0], p[1], 0, null, null]);
    let total = 0;
    for (let i = 1; i < base.length; i++) total += haversineKm(base[i - 1], base[i]);
    if (total > MAX_ROUTE_KM) throw new Error(`Rute terlalu panjang (${Math.round(total)} km). Maksimal ${MAX_ROUTE_KM} km.`);
    const z = total > 150 ? 12 : 13;
    const el = await sampleElevations(base, { z, onProgress: (d, t) => onStatus && onStatus(`Mengambil data elevasi… ${Math.round(d / t * 100)}%`) });
    const w = 1, sm = el.map((_, i) => { let a = 0, c = 0; for (let j = Math.max(0, i - w); j <= Math.min(el.length - 1, i + w); j++) { a += el[j]; c++; } return a / c; });
    return base.map((p, i) => [p[0], p[1], sm[i], p[3], p[4]]);
  }

  // =====================================================================
  // KML (Google My Maps export)
  // =====================================================================
  function parseKML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('File KML tidak valid.');
    const lines = [];
    for (const el of doc.getElementsByTagName('coordinates')) {
      const pts = el.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(a => a.length >= 2 && isFinite(a[0]) && isFinite(a[1]));
      if (pts.length >= 2) lines.push(pts.map(a => [a[0], a[1], a[2] || 0, null, null]));
    }
    for (const el of doc.getElementsByTagNameNS('*', 'coord')) {   // gx:Track
      const a = el.textContent.trim().split(/\s+/).map(Number);
      if (a.length >= 2 && isFinite(a[0]) && isFinite(a[1]) && el.parentNode) {
        let tr = lines.find(l => l.owner === el.parentNode);
        if (!tr) { tr = []; tr.owner = el.parentNode; lines.push(tr); }
        tr.push([a[0], a[1], a[2] || 0, null, null]);
      }
    }
    const usable = lines.filter(l => l.length >= 2);
    if (!usable.length) throw new Error('Tidak ada garis rute di file KML (hanya titik/penanda).');
    // several contiguous lines (e.g. A->B, B->C from My Maps directions) are joined; otherwise take the longest
    let raw = usable[0].slice();
    let contiguous = true;
    for (let i = 1; i < usable.length; i++) {
      if (haversineKm(raw[raw.length - 1], usable[i][0]) < 0.2) raw = raw.concat(usable[i]); else { contiguous = false; break; }
    }
    if (!contiguous) {
      const len = l => { let d = 0; for (let i = 1; i < l.length; i++) d += haversineKm(l[i - 1], l[i]); return d; };
      raw = usable.reduce((a, b) => len(b) > len(a) ? b : a);
    }
    const nameEl = doc.getElementsByTagName('name')[0];
    return { raw, name: nameEl ? nameEl.textContent.trim() : '' };
  }

  // =====================================================================
  // full pipeline: Google Maps link -> raw track
  // =====================================================================
  async function fromGoogleLink(text, opts) {
    const o = opts || {};
    const say = m => o.onStatus && o.onStatus(m);
    let href = extractUrl(text);
    if (!href) throw new Error('Tempel link Google Maps (diawali https://…).');
    let u;
    try { u = new URL(href); } catch { throw new Error('Link tidak valid.'); }
    if (!isGoogleHost(u.hostname)) throw new Error('Itu bukan link Google Maps.');
    if (isShortHost(u.hostname)) { say('Membuka link pendek…'); href = await resolveShortLink(href, o.fetch); }
    const parsed = parseGoogleMapsUrl(href);
    if (parsed.kind === 'place') throw new Error('Link ini hanya satu lokasi, bukan rute. Di Google Maps pilih "Rute" (Directions) dulu, lalu salin linknya.');
    if (parsed.waypoints.length < 2) throw new Error('Link ini belum berisi rute (butuh titik awal dan tujuan). Pastikan titik awal bukan "lokasi Anda".');
    const wps = parsed.waypoints;
    if (wps.length > 25) throw new Error('Terlalu banyak titik di link (maksimal 25).');
    for (const w of wps) {
      if (w.lat != null) continue;
      say(`Mencari "${w.query}"…`);
      const g = await geocode(w.query, o.fetch);
      w.lat = g.lat; w.lon = g.lon;
      await sleep(1100);                                           // Nominatim usage policy: 1 request / second
    }
    say('Menyusun rute sepeda…');
    const r = await routeBike(wps, o.fetch);
    let raw = r.coords;
    let km = 0;
    for (let i = 1; i < raw.length; i++) km += haversineKm(raw[i - 1], raw[i]);
    if (km > MAX_ROUTE_KM) throw new Error(`Rute terlalu panjang (${Math.round(km)} km). Maksimal ${MAX_ROUTE_KM} km.`);
    let noElevation = false;
    if (!r.hasEle) {
      try { raw = await withElevation(raw, say); } catch (e) { noElevation = true; }
    }
    return { raw, name: routeLabel(wps), via: r.via, noElevation };
  }

  const api = { extractUrl, parseCoord, parseGoogleMapsUrl, resolveShortLink, geocode, routeBike, routeLabel,
    sampleElevations, withElevation, densify, parseKML, fromGoogleLink, haversineKm, worldPx, terrarium, isShortHost, isGoogleHost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RouteImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
