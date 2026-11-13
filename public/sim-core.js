/* Gowes simulation core: pure functions (no DOM). Works in the browser (window.SimCore) and in Node tests. */
(function (root) {
  'use strict';

  const G = 9.80665, RHO = 1.2, ETA = 0.975;   // gravity, air density (kg/m3), drivetrain efficiency

  // CdA = drag area (m2, riding position), crr = rolling resistance, mass = default bike + gear (kg),
  // vmax = speed cap on descents (km/h, braking / safety)
  const BIKES = {
    road:   { label: 'Road bike',           cda: 0.38, crr: 0.006, mass: 11, vmax: 55 },
    gravel: { label: 'Gravel / hybrid',     cda: 0.42, crr: 0.009, mass: 13, vmax: 48 },
    mtb:    { label: 'MTB',                 cda: 0.50, crr: 0.013, mass: 15, vmax: 42 },
    city:   { label: 'Sepeda lipat / city', cda: 0.60, crr: 0.008, mass: 17, vmax: 36 }
  };
  // how much harder riders push on climbs than their flat-road effort
  const CLIMB_STYLE = { hemat: 1.0, normal: 1.25, ngotot: 1.5 };
  // share of extra time lost to traffic lights / junctions / slowdowns
  const ROAD_COND = { lancar: 0, normal: 0.06, ramai: 0.12 };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // speed (m/s) for a given pedalling power on a given grade (bisection on the power balance)
  function solveSpeed(powerW, massKg, grade, bike) {
    const th = Math.atan(grade);
    const a = massKg * G * (Math.sin(th) + bike.crr * Math.cos(th));
    const b = 0.5 * RHO * bike.cda;
    const target = powerW * ETA;
    let lo = 0, hi = 30;
    for (let i = 0; i < 48; i++) {
      const v = (lo + hi) / 2;
      if (a * v + b * v * v * v < target) lo = v; else hi = v;
    }
    return (lo + hi) / 2;
  }
  // pedalling power (W) needed to hold a steady speed (km/h) on the flat
  function flatPower(kmh, massKg, bike) {
    const v = kmh / 3.6;
    return (massKg * G * bike.crr * v + 0.5 * RHO * bike.cda * v * v * v) / ETA;
  }

  // ---- elevation gain / loss (one rule for video, stickers and simulation) ----
  // Resample by distance (5 m), smooth +-25 m, then count only rises/falls of at least TH metres.
  // Distance based, so it does not depend on the recording rate. TH is 1 m for clean data (barometer):
  // on a 146 km ride this gives 1010 m, Strava says 1010 m (a fixed 3 m threshold gave only 857 m).
  // For noisy data (GPS-only altitude) TH grows up to 3 m so that noise is not counted as climbing.
  function noiseSigma(ele, cumKm) {
    // only dense recordings (<= 10 m between points) can tell noise from terrain
    const d = [];
    for (let i = 1; i < ele.length - 1; i++) {
      if (cumKm[i + 1] - cumKm[i - 1] > 0.02) continue;
      d.push(Math.abs(ele[i] - (ele[i - 1] + ele[i + 1]) / 2));
    }
    if (d.length < 200) return 0;
    d.sort((a, b) => a - b);
    return d[d.length >> 1] / 0.83;                                   // median |2nd difference| -> sigma
  }
  // ele: elevations (m), cumKm: cumulative distance (km) of each point.
  // returns { gain, loss, perPoint } where perPoint[i] = gain accumulated up to point i.
  function elevationGain(ele, cumKm) {
    const n = ele.length, perPoint = new Float64Array(n);
    const total = cumKm[n - 1];
    if (n < 2 || !(total > 0)) return { gain: 0, loss: 0, perPoint };
    const STEP = 0.005, K = 5;                               // km, samples either side
    const TH = clamp(4 * noiseSigma(ele, cumKm), 1, 3);      // metres
    const m = Math.max(2, Math.round(total / STEP));
    const step = total / m;
    const r = new Float64Array(m + 1);
    let j = 0;
    for (let i = 0; i <= m; i++) {
      const d = step * i;
      while (j < n - 2 && cumKm[j + 1] < d) j++;
      const seg = cumKm[j + 1] - cumKm[j] || 1, t = clamp((d - cumKm[j]) / seg, 0, 1);
      r[i] = ele[j] + (ele[j + 1] - ele[j]) * t;
    }
    const pre = new Float64Array(m + 2);
    for (let i = 0; i <= m; i++) pre[i + 1] = pre[i] + r[i];
    const g = new Float64Array(m + 1);
    let gain = 0, loss = 0, ref = null;
    for (let i = 0; i <= m; i++) {
      const a = Math.max(0, i - K), b = Math.min(m, i + K);
      const v = (pre[b + 1] - pre[a]) / (b - a + 1);
      if (ref === null) ref = v;
      if (v - ref >= TH) { gain += v - ref; ref = v; } else if (ref - v >= TH) { loss += ref - v; ref = v; }
      g[i] = gain;
    }
    for (let i = 0; i < n; i++) perPoint[i] = g[Math.min(m, Math.round(cumKm[i] / step))];
    return { gain, loss, perPoint, threshold: TH };
  }

  // ---- route -> evenly spaced path with smoothed elevation and per-segment grade ----
  function buildPath(coords, cum, total) {
    const ds0 = total > 150 ? 0.1 : 0.05;                     // km
    const n = Math.max(4, Math.round(total / ds0));
    const ds = total / n;
    const raw = new Float64Array(n + 1);
    let j = 0;
    for (let i = 0; i <= n; i++) {
      const d = ds * i;
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1, t = clamp((d - cum[j]) / seg, 0, 1);
      raw[i] = coords[j][2] + (coords[j + 1][2] - coords[j][2]) * t;
    }
    // moving average (about +-75 m): removes GPS / DEM noise that would create fake steep grades
    const w = Math.max(1, Math.round(0.075 / ds));
    const ele = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let a = 0, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n, i + w); k++) { a += raw[k]; c++; }
      ele[i] = a / c;
    }
    const s = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) s[i] = ds * i;
    const grade = new Float64Array(n);
    const dsm = ds * 1000;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 1), hi = Math.min(n, i + 2);
      grade[i] = clamp((ele[hi] - ele[lo]) / ((hi - lo) * dsm), -0.18, 0.25);
    }
    return { n, ds, s, ele, grade, total };
  }

  function routeStats(path) {
    let gain = 0, loss = 0, ref = path.ele[0], maxEle = -Infinity, minEle = Infinity;
    for (let i = 0; i <= path.n; i++) {
      const e = path.ele[i];
      maxEle = Math.max(maxEle, e); minEle = Math.min(minEle, e);
      if (e - ref >= 3) { gain += e - ref; ref = e; } else if (ref - e >= 3) { loss += ref - e; ref = e; }
    }
    let maxGrade = 0;
    for (let i = 0; i < path.n; i++) maxGrade = Math.max(maxGrade, path.grade[i]);
    return { km: path.total, gain, loss, maxEle, minEle, maxGradePct: maxGrade * 100 };
  }

  // ---- simulate one rider group over the path ----
  // grp: { name, weight (kg), flatKmh }   o: { bike, bikeMass, climb, road, restMin }
  function simulate(path, grp, o) {
    const bike = BIKES[o.bike] || BIKES.road;
    const n = path.n, dsm = path.ds * 1000;
    const m = grp.weight + o.bikeMass;
    const P0 = flatPower(grp.flatKmh, m, bike);
    const cf = CLIMB_STYLE[o.climb] || 1.25;
    const rf = ROAD_COND[o.road] != null ? ROAD_COND[o.road] : 0.06;
    const restPerSeg = (o.restMin || 0) * 60 / n;
    const vcap = bike.vmax / 3.6;
    const t = new Float64Array(n + 1), tm = new Float64Array(n + 1), v = new Float64Array(n + 1);
    let moving = 0, stops = 0, rest = 0, work = 0, elapsed = 0, vmaxSeen = 0;
    for (let i = 0; i < n; i++) {
      const g = path.grade[i];
      const fatigue = Math.max(0.78, 1 - 0.045 * Math.max(0, moving / 3600 - 1));
      const k = g > 0.005 ? Math.min(1, (g - 0.005) / 0.025) : 0;       // 0 at 0.5% grade, full at 3%
      const P = P0 * (1 + (cf - 1) * k) * fatigue;
      let vi = solveSpeed(P, m, g, bike), pedal = P;
      if (vi > vcap) {                                                   // braking / coasting at the cap
        vi = vcap;
        const th = Math.atan(g);
        const need = (m * G * (Math.sin(th) + bike.crr * Math.cos(th)) * vi + 0.5 * RHO * bike.cda * vi ** 3) / ETA;
        pedal = clamp(need, 0, P);
      }
      if (vi < 1.0) { vi = 1.0; pedal = 0; }                             // pushing the bike up a wall
      const dt = dsm / vi, stop = dt * rf;
      moving += dt; stops += stop; rest += restPerSeg;
      elapsed += dt + stop + restPerSeg;
      work += pedal * dt;
      t[i + 1] = elapsed; tm[i + 1] = moving; v[i] = vi * 3.6;
      vmaxSeen = Math.max(vmaxSeen, vi * 3.6);
    }
    v[n] = v[n - 1];
    const km = path.total;
    return {
      name: grp.name, weight: grp.weight, flatKmh: grp.flatKmh, flatPowerW: P0,
      t, tm, v, movingSec: moving, stopSec: stops, restSec: rest, totalSec: elapsed,
      avgMovingKmh: km / (moving / 3600), avgOverallKmh: km / (elapsed / 3600),
      maxKmh: vmaxSeen, workKJ: work / 1000, kcal: work / 1000 / (4.184 * 0.24)
    };
  }
  function simulateAll(path, groups, o) { return groups.map(g => simulate(path, g, o)); }

  // ---- climbs ----
  function detectClimbs(path, res) {
    const n = path.n, dsm = path.ds * 1000, out = [];
    let i = 0;
    while (i < n) {
      if (path.grade[i] < 0.03) { i++; continue; }
      const start = i;
      let j = i, last = i, lowRun = 0;
      while (j < n) {
        if (path.grade[j] >= 0.015) { last = j; lowRun = 0; } else { lowRun += dsm; if (lowRun > 300) break; }
        j++;
      }
      const end = last + 1;                                              // node index after the last climbing segment
      const len = (end - start) * dsm, gain = path.ele[end] - path.ele[start];
      if (len >= 300 && gain >= 15) {
        let maxG = 0;
        for (let k = start; k < end; k++) maxG = Math.max(maxG, path.grade[k]);
        const c = { startKm: path.s[start], endKm: path.s[end], lenKm: len / 1000, gain, avgPct: gain / len * 100, maxPct: maxG * 100, startIdx: start, endIdx: end };
        if (res) c.perGroup = res.map(r => {
          let sec = 0;
          for (let k = start; k < end; k++) sec += dsm / (r.v[k] / 3.6);
          return { sec, kmh: len / 1000 / (sec / 3600) };
        });
        out.push(c);
      }
      i = Math.max(j, start + 1);
    }
    return out;
  }

  // ---- checkpoints ----
  function checkpointStep(total) { return total < 30 ? 5 : total < 80 ? 10 : total < 200 ? 20 : 25; }
  function checkpoints(path, results, stepKm) {
    const step = stepKm || checkpointStep(path.total);
    const kms = [0];
    for (let k = step; k < path.total - step * 0.25; k += step) kms.push(k);
    kms.push(path.total);
    return kms.map(km => {
      const idx = Math.min(path.n, Math.round(km / path.ds));
      return { km, ele: path.ele[idx], times: results.map(r => r.t[idx]) };
    });
  }

  // ---- formatting ----
  function fmtDuration(sec) {
    const m = Math.round(sec / 60), h = Math.floor(m / 60);
    return h ? `${h}j ${String(m % 60).padStart(2, '0')}m` : `${m} mnt`;
  }
  function clock(startMin, sec) {
    const tot = Math.round(startMin + sec / 60), day = Math.floor(tot / 1440), mm = ((tot % 1440) + 1440) % 1440;
    return { text: `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`, day };
  }
  const clockText = (startMin, sec) => { const c = clock(startMin, sec); return c.text + (c.day ? ` (+${c.day})` : ''); };

  // ---- text summary (WhatsApp friendly) ----
  function buildSummary(info) {
    const { routeName, stats, results, rows, startMin, restMin, brand, bikeLabel } = info;
    const L = [];
    L.push(`🚴 ${routeName || 'Rute gowes'}`);
    L.push(`${stats.km.toFixed(1)} km · tanjakan ${Math.round(stats.gain)} m · elevasi maks ${Math.round(stats.maxEle)} m`);
    L.push(`Berangkat ${clockText(startMin, 0)} · istirahat ${restMin} mnt · ${bikeLabel}`);
    L.push('');
    L.push('Prediksi:');
    for (const r of results)
      L.push(`• ${r.name} (${r.flatKmh} km/h datar): ${fmtDuration(r.totalSec)} · tiba ${clockText(startMin, r.totalSec)} · rata-rata ${r.avgMovingKmh.toFixed(1)} km/h`);
    L.push('');
    L.push('Jam lewat:');
    for (const row of rows) {
      if (row.km === 0) continue;
      const label = row.km === stats.km ? `finish (${stats.km.toFixed(1)} km)` : `km ${Math.round(row.km)}`;
      L.push(`• ${label} — ${row.times.map(t => clockText(startMin, t)).join(' / ')}`);
    }
    if (results.length > 1) L.push(`  (urutan: ${results.map(r => r.name).join(' / ')})`);
    L.push('');
    L.push(`Perkiraan ±10–15%${brand ? ' · ' + brand : ''}`);
    return L.join('\n');
  }

  const api = { BIKES, CLIMB_STYLE, ROAD_COND, solveSpeed, flatPower, elevationGain, buildPath, routeStats, simulate, simulateAll,
    detectClimbs, checkpointStep, checkpoints, fmtDuration, clock, clockText, buildSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SimCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
