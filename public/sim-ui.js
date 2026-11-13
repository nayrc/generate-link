/* Simulation tab UI. Loaded after the main page script (uses its globals: track, $, status helpers). */
(function () {
  'use strict';
  const C = window.SimCore;
  const el = id => document.getElementById(id);
  const COLORS = ['#cdf227', '#ff9a2e', '#4c8dff'];
  const PRESETS = [{ name: 'Santai', flat: 20 }, { name: 'Sedang', flat: 25 }, { name: 'Cepat', flat: 30 }];
  const STORE = 'gowes-sim-v1';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    bike: 'road', bikeMass: C.BIKES.road.mass, climb: 'normal', road: 'normal', start: '06:00', rest: 30,
    groups: [{ name: 'Sedang', weight: 70, flat: 25 }], sel: 0
  };
  let lastTrack = null, model = null, hoverIdx = null, raf = 0;

  // ---------- persistence (per device) ----------
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!j) return;
      for (const k of ['bike', 'climb', 'road', 'start']) if (typeof j[k] === 'string') state[k] = j[k];
      for (const k of ['bikeMass', 'rest']) if (isFinite(j[k])) state[k] = +j[k];
      if (!C.BIKES[state.bike]) state.bike = 'road';
      if (Array.isArray(j.groups) && j.groups.length) {
        state.groups = j.groups.slice(0, 3).map(g => ({ name: String(g.name || '').slice(0, 24), weight: clamp(+g.weight || 70, 30, 200), flat: clamp(+g.flat || 25, 12, 40) }));
      }
    } catch { /* private mode etc. */ }
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ ...state, sel: undefined })); } catch { /* ignore */ } }

  // ---------- settings -> DOM ----------
  function setSelect(id, value) { const s = el(id); s.value = value; s.dispatchEvent(new Event('change')); }
  function applyStateToDom() {
    setSelect('simBike', state.bike); setSelect('simClimb', state.climb); setSelect('simRoad', state.road);
    el('simBikeMass').value = state.bikeMass; el('simBikeMassVal').textContent = state.bikeMass + ' kg';
    el('simStart').value = state.start;
    el('simRest').value = state.rest; el('simRestVal').textContent = state.rest + ' mnt';
    renderGroups();
  }

  function groupHtml(g, i) {
    return `<div class="gcard" data-i="${i}">
      <div class="ghead"><span class="dot" style="background:${COLORS[i]}"></span>
        <input type="text" class="gname" value="${esc(g.name)}" maxlength="24" placeholder="Nama kelompok" aria-label="Nama kelompok">
        ${state.groups.length > 1 ? '<button class="ghost gdel" aria-label="Hapus kelompok">✕</button>' : ''}</div>
      <div class="grow"><label for="gw${i}">Berat badan</label><input type="number" id="gw${i}" class="gweight" min="30" max="200" step="1" inputmode="numeric" value="${g.weight}"> kg</div>
      <div class="field"><div class="lbl">Kecepatan di jalan datar <b class="gflatv">${g.flat} km/h</b></div>
        <input type="range" class="gflat" min="12" max="40" step="1" value="${g.flat}" aria-label="Kecepatan di jalan datar">
        <div class="qs">${PRESETS.map(p => `<button type="button" data-k="${p.flat}">${p.name} ${p.flat}</button>`).join('')}</div></div>
    </div>`;
  }
  function renderGroups() {
    el('simGroupList').innerHTML = state.groups.map(groupHtml).join('');
    el('simAddGroup').hidden = state.groups.length >= 3;
  }

  // ---------- compute ----------
  function startMinutes() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(state.start || '');
    return m ? clamp(+m[1], 0, 23) * 60 + clamp(+m[2], 0, 59) : 360;
  }
  function compute() {
    if (!lastTrack) return;
    if (!lastTrack.simPath) lastTrack.simPath = C.buildPath(lastTrack.coords, lastTrack.cum, lastTrack.total);
    const path = lastTrack.simPath;
    const o = { bike: state.bike, bikeMass: state.bikeMass, climb: state.climb, road: state.road, restMin: state.rest };
    const groups = state.groups.map((g, i) => ({ name: g.name.trim() || `Kelompok ${i + 1}`, weight: g.weight, flatKmh: g.flat }));
    const results = C.simulateAll(path, groups, o);
    const stats = C.routeStats(path);
    stats.gain = lastTrack.gain; stats.loss = lastTrack.loss;     // same number as the video and stickers
    model = { path, o, groups, results, stats, rows: C.checkpoints(path, results), climbs: C.detectClimbs(path, results), startMin: startMinutes() };
    if (state.sel >= results.length) state.sel = 0;
  }

  // ---------- render ----------
  const fmtKcal = n => Math.round(n).toLocaleString('id-ID');
  function renderCards() {
    const { results, startMin } = model;
    el('simCards').innerHTML = results.map((r, i) => `<div class="scard" style="--c:${COLORS[i]}">
      <div class="nm"><b>${esc(r.name)}</b><span>${r.flatKmh} km/h datar · ${r.weight} kg</span></div>
      <div class="big">${C.fmtDuration(r.totalSec)}</div>
      <div class="eta">Tiba <b>${C.clockText(startMin, r.totalSec)}</b> · berangkat ${C.clockText(startMin, 0)}</div>
      <div class="kv"><div>Rata-rata<b>${r.avgMovingKmh.toFixed(1)} km/h</b></div><div>Waktu gerak<b>${C.fmtDuration(r.movingSec)}</b></div><div>Energi<b>${fmtKcal(r.kcal)} kcal</b></div></div>
    </div>`).join('');
  }
  function renderFacts() {
    const s = model.stats;
    el('simFacts').innerHTML = [['Jarak', `${s.km.toFixed(1)} km`], ['Tanjakan total', `${Math.round(s.gain)} m`],
      ['Elevasi maks', `${Math.round(s.maxEle)} m`], ['Tanjakan terjal', `${s.maxGradePct.toFixed(0)}%`]].map(([l, v]) => `<div>${l}<b>${v}</b></div>`).join('');
  }
  function renderNotice() {
    const lines = [];
    if (lastTrack.noElevation) lines.push('Data elevasi tidak bisa diambil, jadi tanjakan tidak diperhitungkan (rute dianggap datar). Coba muat ulang rute.');
    if (lastTrack.source === 'link') lines.push('Rute disusun dari link Google Maps mengikuti jalan sepeda OpenStreetMap, jadi bisa sedikit berbeda dari rute Google.');
    const n = el('simNotice');
    n.hidden = !lines.length;
    n.innerHTML = lines.map(esc).join('<br>');
  }
  function renderPick() {
    const box = el('simPick');
    box.hidden = model.results.length < 2;
    box.innerHTML = model.results.map((r, i) => `<button class="chip${i === state.sel ? ' on' : ''}" data-i="${i}"><i style="background:${COLORS[i]}"></i>${esc(r.name)}</button>`).join('');
  }
  function renderTable() {
    const { rows, results, startMin, stats } = model, multi = results.length > 1;
    const head = `<tr><th>Titik</th><th class="el">Elev</th>${results.map((r, i) => `<th><span style="color:${COLORS[i]}">●</span> ${esc(r.name)}</th>`).join('')}</tr>`;
    const body = rows.map((row, ri) => {
      const label = ri === 0 ? 'Start' : ri === rows.length - 1 ? `Finish · ${stats.km.toFixed(1)} km` : `${Math.round(row.km)} km`;
      const cells = row.times.map((t, i) => {
        const diff = i > 0 && ri > 0 ? Math.round((t - row.times[0]) / 60) : null;
        return `<td>${C.clockText(startMin, t)}${diff != null ? `<small>${diff >= 0 ? '+' : ''}${diff}</small>` : ''}</td>`;
      }).join('');
      return `<tr${ri === rows.length - 1 ? ' class="fin"' : ''}><td>${label}</td><td class="el">${Math.round(row.ele)} m</td>${cells}</tr>`;
    }).join('');
    el('simTable').innerHTML = head + body;
    el('simTable').parentNode.title = multi ? 'Angka kecil = selisih menit terhadap kelompok pertama' : '';
  }
  function renderClimbs() {
    const top = model.climbs.slice().sort((a, b) => b.gain - a.gain).slice(0, 5).sort((a, b) => a.startKm - b.startKm);
    el('simClimbs').innerHTML = top.length ? top.map(c => `<div class="climb">
      <div class="t">⛰️ km ${c.startKm.toFixed(1)}–${c.endKm.toFixed(1)} · ${c.lenKm.toFixed(1)} km</div>
      <div class="m">Naik ${Math.round(c.gain)} m · rata-rata ${c.avgPct.toFixed(1)}% · terjal ${c.maxPct.toFixed(0)}%</div>
      <div class="m">${c.perGroup.map((g, i) => `${esc(model.results[i].name)} ${Math.max(1, Math.round(g.sec / 60))} mnt (${g.kmh.toFixed(1)} km/h)`).join(' · ')}</div></div>`).join('')
      : '<div class="muted">Tidak ada tanjakan berarti di rute ini.</div>';
  }

  // ---------- charts ----------
  function prepCanvas(cv) {
    const dpr = Math.min(3, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function niceStep(span, target) {
    const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }
  function drawXAxis(ctx, x, h, B, total, w, L, R) {
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    const step = niceStep(total, 5);
    for (let km = 0; km <= total + 1e-6; km += step) ctx.fillText(String(Math.round(km * 10) / 10), x(km), h - 8);
    ctx.textAlign = 'right'; ctx.fillText('km', w - R + 36, h - 8);
  }
  function smooth(arr, k) {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { a += arr[j]; c++; } out[i] = a / c; }
    return out;
  }

  function drawMain() {
    const cv = el('simChart'), pc = prepCanvas(cv);
    if (!pc || !model) return;
    const { ctx, w, h } = pc, { path, results, climbs } = model, r = results[state.sel];
    const L = 40, R = 40, T = 20, B = 24, pw = w - L - R, ph = h - T - B, n = path.n;
    const x = km => L + km / path.total * pw;
    let emin = Infinity, emax = -Infinity;
    for (let i = 0; i <= n; i++) { emin = Math.min(emin, path.ele[i]); emax = Math.max(emax, path.ele[i]); }
    const estep = niceStep(Math.max(20, emax - emin), 4);
    emin = Math.floor((emin - 2) / estep) * estep; emax = Math.max(emin + estep * 2, Math.ceil((emax + 2) / estep) * estep);
    const yE = e => T + ph - (e - emin) / (emax - emin) * ph;
    const vs = smooth(r.v, 3);
    let vmaxS = 0; for (let i = 0; i <= n; i++) vmaxS = Math.max(vmaxS, vs[i]);
    const vtop = Math.max(10, Math.ceil(vmaxS / 10) * 10), yV = v => T + ph - v / vtop * ph;
    ctx.clearRect(0, 0, w, h);
    // grid + axes
    ctx.lineWidth = 1; ctx.font = '11px system-ui, sans-serif';
    for (let k = 0; k <= 4; k++) {
      const y = T + ph * k / 4;
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.textAlign = 'right'; ctx.fillText(Math.round(emax - (emax - emin) * k / 4) + ' m', L - 6, y + 4);
      ctx.fillStyle = 'rgba(255,154,46,.85)'; ctx.textAlign = 'left'; ctx.fillText(Math.round(vtop - vtop * k / 4) + '', w - R + 6, y + 4);
    }
    ctx.fillStyle = 'rgba(255,154,46,.85)'; ctx.textAlign = 'left'; ctx.fillText('km/j', w - R + 6, 11);
    // climbs band
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    for (const c of climbs) ctx.fillRect(x(c.startKm), T, Math.max(2, x(c.endKm) - x(c.startKm)), ph);
    // elevation area
    const stride = Math.max(1, Math.floor(n / 500));
    ctx.beginPath(); ctx.moveTo(x(0), T + ph);
    for (let i = 0; i <= n; i += stride) ctx.lineTo(x(path.s[i]), yE(path.ele[i]));
    ctx.lineTo(x(path.total), yE(path.ele[n])); ctx.lineTo(x(path.total), T + ph); ctx.closePath();
    const g = ctx.createLinearGradient(0, T, 0, T + ph); g.addColorStop(0, 'rgba(205,242,39,.40)'); g.addColorStop(1, 'rgba(205,242,39,.04)');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(205,242,39,.9)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i <= n; i += stride) { const px = x(path.s[i]), py = yE(path.ele[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.stroke();
    // speed line
    ctx.strokeStyle = '#ff9a2e'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = 0; i <= n; i += stride) { const px = x(path.s[i]), py = yV(vs[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.stroke();
    drawXAxis(ctx, x, h, B, path.total, w, L, R);
    // hover marker
    if (hoverIdx != null) {
      const i = clamp(hoverIdx, 0, n), px = x(path.s[i]);
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
      for (const [py, col] of [[yE(path.ele[i]), '#cdf227'], [yV(vs[i]), '#ff9a2e']]) {
        ctx.fillStyle = col; ctx.strokeStyle = '#0e1013'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const gr = path.grade[Math.min(i, n - 1)] * 100;
      el('simTip').innerHTML = `<b>km ${path.s[i].toFixed(1)}</b> · ${Math.round(path.ele[i])} m · kemiringan ${gr >= 0 ? '+' : ''}${gr.toFixed(1)}% · ${vs[i].toFixed(1)} km/j · tiba ${C.clockText(model.startMin, r.t[i])}`;
    } else el('simTip').textContent = 'Sentuh grafik untuk melihat detail di titik itu. Hijau = elevasi, oranye = kecepatan.';
    cv._geom = { L, R, w, path };
  }

  function drawGap() {
    const wrap = el('simGapWrap'), multi = model.results.length > 1;
    wrap.hidden = !multi;
    if (!multi) return;
    const cv = el('simGap'), pc = prepCanvas(cv);
    if (!pc) return;
    const { ctx, w, h } = pc, { path, results } = model;
    const L = 40, R = 40, T = 10, B = 24, pw = w - L - R, ph = h - T - B, n = path.n;
    const x = km => L + km / path.total * pw;
    let ref = 0; results.forEach((r, i) => { if (r.totalSec < results[ref].totalSec) ref = i; });
    const gaps = results.map(r => Array.from(r.t, (t, i) => (t - results[ref].t[i]) / 60));
    let gmax = 0; for (const a of gaps) for (const v of a) gmax = Math.max(gmax, v);
    const gstep = niceStep(Math.max(5, gmax), 4), gtop = Math.max(gstep, Math.ceil(gmax / gstep) * gstep), y = v => T + ph - v / gtop * ph;
    ctx.clearRect(0, 0, w, h); ctx.font = '11px system-ui, sans-serif';
    for (let k = 0; k <= 4; k++) {
      const yy = T + ph * k / 4;
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.textAlign = 'right'; ctx.fillText('+' + Math.round(gtop - gtop * k / 4) + ' mnt', L - 6, yy + 4);
    }
    const stride = Math.max(1, Math.floor(n / 400));
    gaps.forEach((a, gi) => {
      ctx.strokeStyle = COLORS[gi]; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i <= n; i += stride) { const px = x(path.s[i]), py = y(a[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.lineTo(x(path.total), y(a[n])); ctx.stroke();
    });
    drawXAxis(ctx, x, h, B, path.total, w, L, R);
    el('simGapLegend').innerHTML = results.map((r, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(r.name)}${i === ref ? ' (tercepat)' : ` +${Math.round(gaps[i][n])} mnt di finish`}</span>`).join('');
  }

  function renderAll() {
    if (!lastTrack) return;
    compute();
    renderNotice(); renderCards(); renderFacts(); renderPick(); renderTable(); renderClimbs();
    drawMain(); drawGap();
  }
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (visible()) renderAll(); }); }
  const visible = () => !el('tab-sim').hidden;

  // ---------- summary / share ----------
  function summaryText() {
    const brand = (document.getElementById('brand') && document.getElementById('brand').value || '').trim();
    return C.buildSummary({
      routeName: lastTrack.name || el('fiName').textContent, stats: model.stats, results: model.results, rows: model.rows,
      startMin: model.startMin, restMin: state.rest, brand, bikeLabel: C.BIKES[state.bike].label
    });
  }
  const say = t => { el('simMsg').textContent = t; };
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;left:-999px';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }

  // ---------- events ----------
  function bind() {
    const upd = () => { save(); schedule(); };
    el('simBike').addEventListener('change', e => {
      if (state.bike === e.target.value) return;
      state.bike = e.target.value; state.bikeMass = C.BIKES[state.bike].mass;
      el('simBikeMass').value = state.bikeMass; el('simBikeMassVal').textContent = state.bikeMass + ' kg'; upd();
    });
    el('simClimb').addEventListener('change', e => { state.climb = e.target.value; upd(); });
    el('simRoad').addEventListener('change', e => { state.road = e.target.value; upd(); });
    el('simBikeMass').addEventListener('input', e => { state.bikeMass = +e.target.value; el('simBikeMassVal').textContent = state.bikeMass + ' kg'; upd(); });
    el('simStart').addEventListener('input', e => { state.start = e.target.value; upd(); });
    el('simRest').addEventListener('input', e => { state.rest = +e.target.value; el('simRestVal').textContent = state.rest + ' mnt'; upd(); });

    const list = el('simGroupList');
    const idxOf = t => +t.closest('.gcard').dataset.i;
    list.addEventListener('input', e => {
      const t = e.target, i = idxOf(t), g = state.groups[i];
      if (t.classList.contains('gname')) g.name = t.value;
      else if (t.classList.contains('gweight')) { const v = parseFloat(t.value); if (isFinite(v)) g.weight = clamp(v, 30, 200); else return; }
      else if (t.classList.contains('gflat')) { g.flat = +t.value; t.closest('.gcard').querySelector('.gflatv').textContent = g.flat + ' km/h'; }
      upd();
    });
    list.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const card = b.closest('.gcard'), i = +card.dataset.i;
      if (b.classList.contains('gdel')) { state.groups.splice(i, 1); renderGroups(); upd(); }
      else if (b.dataset.k) { state.groups[i].flat = +b.dataset.k; card.querySelector('.gflat').value = b.dataset.k; card.querySelector('.gflatv').textContent = b.dataset.k + ' km/h'; upd(); }
    });
    el('simAddGroup').addEventListener('click', () => {
      if (state.groups.length >= 3) return;
      const used = new Set(state.groups.map(g => g.name.trim().toLowerCase()));
      const p = PRESETS.find(x => !used.has(x.name.toLowerCase())) || PRESETS[state.groups.length % 3];
      state.groups.push({ name: p.name, weight: state.groups[0].weight, flat: p.flat });
      renderGroups(); upd();
    });
    el('simPick').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.sel = +b.dataset.i; hoverIdx = null; renderPick(); drawMain();
    });

    // chart scrubbing (touch: horizontal drag; vertical drag still scrolls the page)
    const cv = el('simChart');
    const at = ev => {
      const g = cv._geom; if (!g) return;
      const rect = cv.getBoundingClientRect(), px = ev.clientX - rect.left;
      const km = clamp((px - g.L) / (g.w - g.L - g.R), 0, 1) * g.path.total;
      hoverIdx = Math.round(km / g.path.ds); drawMain();
    };
    cv.addEventListener('pointerdown', at);
    cv.addEventListener('pointermove', at);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hoverIdx = null; drawMain(); } });

    el('simCopy').addEventListener('click', async () => {
      if (!model) return;
      say(await copyText(summaryText()) ? 'Tersalin ✓ — tempel di grup WhatsApp.' : 'Browser tidak mengizinkan menyalin. Tekan Bagikan.');
    });
    el('simShare').addEventListener('click', async () => {
      if (!model) return;
      const text = summaryText();
      if (navigator.share) { try { await navigator.share({ text }); say(''); } catch { /* cancelled */ } }
      else say(await copyText(text) ? 'Bagikan langsung hanya ada di HP. Ringkasan sudah disalin ✓' : 'Bagikan langsung hanya ada di HP.');
    });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (visible() && model) { drawMain(); drawGap(); } }, 120); });
  }

  // ---------- public API ----------
  window.SimUI = {
    setTrack(t) { lastTrack = t; model = null; hoverIdx = null; state.sel = 0; if (visible()) renderAll(); },
    show() {
      if (typeof track !== 'undefined' && track && track !== lastTrack) { lastTrack = track; model = null; hoverIdx = null; state.sel = 0; }
      if (lastTrack) renderAll();
    },
    _state: state, _model: () => model
  };
  load(); applyStateToDom(); bind();
})();
