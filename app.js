'use strict';

// ---------- Config ----------

const PSK_URL = 'https://retrieve.pskreporter.info/query';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CACHE_MS = 5 * 60 * 1000;      // PSK Reporter asks for >= 5 min between queries
const REPORT_LIMIT = 20000;

// `always` bands are listed even with no activity; the rest appear only when spotted.
const BANDS = [
  { name: '2200m', lo: 135.7e3, hi: 137.8e3, color: '#7c3aed' },
  { name: '630m', lo: 472e3, hi: 479e3, color: '#9333ea' },
  { name: '160m', lo: 1.8e6, hi: 2.0e6, color: '#be185d', always: true },
  { name: '80m', lo: 3.5e6, hi: 4.0e6, color: '#dc2626', always: true },
  { name: '60m', lo: 5.06e6, hi: 5.45e6, color: '#ea580c', always: true },
  { name: '40m', lo: 7.0e6, hi: 7.3e6, color: '#d97706', always: true },
  { name: '30m', lo: 10.1e6, hi: 10.15e6, color: '#ca8a04', always: true },
  { name: '20m', lo: 14.0e6, hi: 14.35e6, color: '#65a30d', always: true },
  { name: '17m', lo: 18.068e6, hi: 18.168e6, color: '#16a34a', always: true },
  { name: '15m', lo: 21.0e6, hi: 21.45e6, color: '#0d9488', always: true },
  { name: '12m', lo: 24.89e6, hi: 24.99e6, color: '#0891b2', always: true },
  { name: '10m', lo: 28.0e6, hi: 29.7e6, color: '#2563eb', always: true },
  { name: '6m', lo: 50e6, hi: 54e6, color: '#4f46e5', always: true },
  { name: '4m', lo: 70e6, hi: 70.5e6, color: '#6d28d9' },
  { name: '2m', lo: 144e6, hi: 148e6, color: '#a21caf', always: true },
  { name: '1.25m', lo: 222e6, hi: 225e6, color: '#c026d3' },
  { name: '70cm', lo: 420e6, hi: 450e6, color: '#db2777' },
  { name: '23cm', lo: 1240e6, hi: 1300e6, color: '#e11d48' },
];
const OTHER_BAND = { name: 'Other/unknown', color: '#64748b' };

// ---------- State ----------

const els = {};
const state = {
  unit: loadPref('unit', null),
  result: null,        // { area, reports, agg, fetchedAt, query }
  selectedBand: null,
  openDetail: null,
};
let map, areaLayer, markerLayer, refreshTimer;

// ---------- Helpers ----------

function loadPref(key, fallback) {
  try { return localStorage.getItem('bw.' + key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem('bw.' + key, value); } catch { /* storage unavailable */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = n => n.toLocaleString();

function bandFor(hz) {
  return BANDS.find(b => hz >= b.lo && hz <= b.hi) || OTHER_BAND;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function dist(km) {
  if (km == null) return '—';
  return state.unit === 'km' ? `${fmt(Math.round(km))} km` : `${fmt(Math.round(km * 0.621371))} mi`;
}

function ago(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function windowLabel(sec) {
  return sec < 3600 ? `${sec / 60} min` : `${sec / 3600} h`;
}

// ---------- Maidenhead ----------

const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?([0-9]{2})?$/i;

function latLonToGrid(lat, lon) {
  lon = Math.min(179.9999, Math.max(-180, lon)) + 180;
  lat = Math.min(89.9999, Math.max(-90, lat)) + 90;
  const A = 'A'.charCodeAt(0);
  return (
    String.fromCharCode(A + Math.floor(lon / 20)) +
    String.fromCharCode(A + Math.floor(lat / 10)) +
    Math.floor((lon % 20) / 2) +
    Math.floor(lat % 10) +
    String.fromCharCode(A + Math.floor((lon % 2) * 12)).toLowerCase() +
    String.fromCharCode(A + Math.floor((lat % 1) * 24)).toLowerCase()
  );
}

// Returns {lat, lon, s, w, n, e} for a locator of 2–10 chars, or null if unparseable.
function gridToBounds(loc) {
  if (!loc) return null;
  const g = loc.trim().toUpperCase();
  if (!/^[A-R]{2}/.test(g)) return null;
  let lon = -180, lat = -90, dLon = 20, dLat = 10;
  lon += (g.charCodeAt(0) - 65) * dLon;
  lat += (g.charCodeAt(1) - 65) * dLat;
  let i = 2;
  // Alternating pairs: digits (÷10), letters (÷24), digits, letters...
  for (let pair = 0; i + 1 < g.length && pair < 4; pair++, i += 2) {
    const a = g[i], b = g[i + 1];
    if (pair % 2 === 0) {
      if (!/[0-9]/.test(a) || !/[0-9]/.test(b)) break;
      dLon /= 10; dLat /= 10;
      lon += +a * dLon; lat += +b * dLat;
    } else {
      if (!/[A-X]/.test(a) || !/[A-X]/.test(b)) break;
      dLon /= 24; dLat /= 24;
      lon += (a.charCodeAt(0) - 65) * dLon; lat += (b.charCodeAt(0) - 65) * dLat;
    }
  }
  return { lat: lat + dLat / 2, lon: lon + dLon / 2, s: lat, w: lon, n: lat + dLat, e: lon + dLon };
}

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Data sources ----------

let jsonpSeq = 0;
// PSK Reporter sends no CORS headers, but it does support JSONP via `callback`.
function jsonp(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    // PSK Reporter strips non-alphanumerics from the callback name, so keep it plain.
    const name = `bandwatchcb${Date.now()}x${jsonpSeq++}`;
    const script = document.createElement('script');
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window[name] = () => {};          // swallow any late response
      script.remove();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('PSK Reporter took too long to respond. Try a shorter window.')), timeoutMs);
    window[name] = data => finish(resolve, data);
    script.onerror = () => finish(reject, new Error("Couldn't reach PSK Reporter. It may be down or rate-limiting you; wait a few minutes and try again."));
    // Loaded but the callback never ran: the server returned an error page instead of data.
    script.onload = () => setTimeout(() => finish(reject, new Error('PSK Reporter returned an error, possibly rate limiting. Wait a few minutes and try again.')), 0);
    script.src = `${url}&callback=${name}`;
    document.head.appendChild(script);
  });
}

async function resolveLocation(input) {
  const q = input.trim();
  if (GRID_RE.test(q)) {
    const grid = q.slice(0, 2).toUpperCase() + q.slice(2, 4) + q.slice(4).toLowerCase();
    return { grid, label: `Grid ${grid}` };
  }
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '0' });
  if (/^\d{5}(-\d{4})?$/.test(q)) {
    params.set('postalcode', q.slice(0, 5));
    params.set('countrycodes', 'us');
  } else {
    params.set('q', q);
  }
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Location lookup failed (${res.status}).`);
  const hits = await res.json();
  if (!hits.length) throw new Error(`Couldn't find “${q}”. Try a grid square, a ZIP code, or "City, State".`);
  const hit = hits[0];
  return { grid: latLonToGrid(+hit.lat, +hit.lon), label: hit.display_name };
}

async function fetchReports(square, dir, windowSec, { force = false } = {}) {
  const key = `bw.q.${square}.${dir}.${windowSec}`;
  if (!force) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
    } catch { /* ignore */ }
  }
  const params = new URLSearchParams({
    [dir === 'tx' ? 'senderCallsign' : 'receiverCallsign']: square,
    modify: 'grid',
    flowStartSeconds: String(-windowSec),
    rronly: '1',
    noactive: '1',
    rptlimit: String(REPORT_LIMIT),
    appcontact: 'band-watch',
  });
  const data = await jsonp(`${PSK_URL}?${params}`);
  const result = { reports: data.receptionReport || [], fetchedAt: Date.now() };
  try { sessionStorage.setItem(key, JSON.stringify(result)); } catch { /* too big or unavailable */ }
  return result;
}

// ---------- Aggregation ----------

function aggregate(reports, dir) {
  const bands = new Map();
  const allLocal = new Set(), allRemote = new Set(), allCountries = new Set();
  const modeTotals = new Map();

  for (const r of reports) {
    const tx = dir === 'tx';
    const local = tx ? r.senderCallsign : r.receiverCallsign;
    const localLoc = tx ? r.senderLocator : r.receiverLocator;
    const remote = (tx ? r.receiverCallsign : r.senderCallsign) || '(no call)';
    const remoteLoc = tx ? r.receiverLocator : r.senderLocator;
    const country = tx ? r.receiverDXCC : r.senderDXCC;
    const mode = r.mode || 'Unknown';
    const band = bandFor(r.frequency);

    let b = bands.get(band.name);
    if (!b) {
      b = { band, spots: 0, local: new Set(), remote: new Map(), countries: new Set(), modes: new Map(), snr: [] };
      bands.set(band.name, b);
    }
    b.spots++;
    b.local.add(local);
    if (country) b.countries.add(country);
    if (typeof r.sNR === 'number') b.snr.push(r.sNR);

    let m = b.modes.get(mode);
    if (!m) b.modes.set(mode, m = new Set());
    m.add(remote);

    const lp = gridToBounds(localLoc), rp = gridToBounds(remoteLoc);
    const km = lp && rp ? haversineKm(lp, rp) : null;
    const prev = b.remote.get(remote);
    if (!prev || (km ?? -1) > (prev.km ?? -1)) {
      b.remote.set(remote, { call: remote, loc: remoteLoc, pos: rp, km, local, mode, snr: r.sNR, country, t: r.flowStartSeconds, spots: (prev?.spots || 0) + 1 });
    } else {
      prev.spots++;
    }

    allLocal.add(local);
    allRemote.add(remote);
    if (country) allCountries.add(country);
    modeTotals.set(mode, (modeTotals.get(mode) || 0) + 1);
  }

  for (const b of bands.values()) {
    b.remoteList = [...b.remote.values()].sort((a, z) => (z.km ?? -1) - (a.km ?? -1));
    b.best = b.remoteList[0] || null;
    b.medSnr = median(b.snr);
    b.modeList = [...b.modes.entries()].map(([mode, set]) => ({ mode, n: set.size })).sort((a, z) => z.n - a.n);
  }

  const rows = [...BANDS, OTHER_BAND]
    .filter(band => band.always || bands.has(band.name))
    .map(band => bands.get(band.name) || { band, spots: 0, local: new Set(), remote: new Map(), remoteList: [], countries: new Set(), modeList: [], best: null, medSnr: null });

  const modes = [...modeTotals.entries()].sort((a, z) => z[1] - a[1]).map(([m]) => m);
  return { rows, modes, totals: { spots: reports.length, local: allLocal.size, remote: allRemote.size, countries: allCountries.size } };
}

// ---------- Rendering ----------

function setStatus(html, kind = '') {
  els.status.className = 'status' + (kind ? ' ' + kind : '');
  els.status.innerHTML = html;
}

function render() {
  const { result } = state;
  if (!result) return;
  const { area, agg, query } = result;
  const tx = query.dir === 'tx';

  els.results.hidden = false;
  els.gridBadge.textContent = area.square;
  els.place.textContent = area.label;
  els.meta.textContent = `${tx ? 'Transmitting from' : 'Receiving in'} ${area.square} · last ${windowLabel(query.win)} · fetched ${new Date(result.fetchedAt).toLocaleTimeString()}`;

  els.stats.innerHTML = [
    [agg.totals.local, tx ? 'local stations heard' : 'local receivers'],
    [agg.totals.remote, tx ? 'stations hearing them' : 'stations heard'],
    [agg.totals.countries, 'DXCC entities'],
    [agg.totals.spots, 'spots'],
  ].map(([v, k]) => `<div class="stat"><div class="v">${fmt(v)}</div><div class="k">${k}</div></div>`).join('');

  els.hLocal.textContent = tx ? 'Local TX' : 'Local RX';
  els.hRemote.textContent = tx ? 'Heard by' : 'Stns heard';
  els.bandHint.textContent = tx
    ? `“Heard by” is the number of distinct stations worldwide that decoded a transmitter in ${area.square}. Click a band for details.`
    : `“Stns heard” is the number of distinct stations that receivers in ${area.square} decoded. Click a band for details.`;
  if (result.reports.length >= REPORT_LIMIT) {
    els.bandHint.textContent += ` Hit the ${fmt(REPORT_LIMIT)}-report limit; try a shorter window for complete counts.`;
  }

  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));

  renderBandTable();
  renderMatrix();
  renderMap();
}

function renderBandTable() {
  const { agg, query } = state.result;
  const max = Math.max(1, ...agg.rows.map(r => r.remote.size));
  const tbody = els.bandTable.tBodies[0];
  let html = '';
  for (const r of agg.rows) {
    const n = r.remote.size;
    const name = r.band.name;
    const sel = state.selectedBand === name ? ' sel' : '';
    const best = r.best && r.best.km != null
      ? `${dist(r.best.km)}<small><span class="call">${esc(r.best.call)}</span></small>`
      : '—';
    html += `<tr class="band${n ? '' : ' dead'}${sel}" data-band="${esc(name)}" tabindex="0" aria-expanded="${state.openDetail === name}">
      <td class="bandname"><span class="dot" style="background:${r.band.color}"></span>${esc(name)}</td>
      <td class="num">${r.local.size || '—'}</td>
      <td class="num"><div class="remote-cell"><b>${n ? fmt(n) : '—'}</b><span class="bar"><i style="width:${(n / max) * 100}%"></i></span></div></td>
      <td class="num">${r.spots ? fmt(r.spots) : '—'}</td>
      <td class="num">${r.countries.size || '—'}</td>
      <td class="num best">${best}</td>
      <td class="num">${r.medSnr != null ? `${r.medSnr} dB` : '—'}</td>
      <td><div class="chips">${r.modeList.slice(0, 4).map(m => `<span class="chip">${esc(m.mode)} <b>${fmt(m.n)}</b></span>`).join('')}${r.modeList.length > 4 ? `<span class="chip">+${r.modeList.length - 4}</span>` : ''}</div></td>
    </tr>`;
    if (state.openDetail === name && n) html += detailRow(r, query.dir);
  }
  tbody.innerHTML = html;
}

function detailRow(r, dir) {
  const tx = dir === 'tx';
  const top = r.remoteList.slice(0, 15);
  const countries = new Map();
  for (const s of r.remoteList) if (s.country) countries.set(s.country, (countries.get(s.country) || 0) + 1);
  const topCountries = [...countries.entries()].sort((a, z) => z[1] - a[1]).slice(0, 12);
  return `<tr class="detail"><td colspan="8"><div class="cols">
    <div>
      <h3>Farthest ${tx ? 'stations hearing the area' : 'stations heard'} on ${esc(r.band.name)}</h3>
      <div class="scroll"><table>
        <thead><tr><th>${tx ? 'Heard by' : 'Station'}</th><th>Grid</th><th class="num">Distance</th><th>Mode</th>${tx ? '<th class="num">SNR</th>' : ''}<th>${tx ? 'Local TX' : 'Local RX'}</th><th>When</th></tr></thead>
        <tbody>${top.map(s => `<tr>
          <td class="call">${esc(s.call)}</td><td>${esc(s.loc || '')}</td><td class="num">${dist(s.km)}</td>
          <td>${esc(s.mode)}</td>${tx ? `<td class="num">${typeof s.snr === 'number' ? s.snr + ' dB' : '—'}</td>` : ''}
          <td class="call">${esc(s.local)}</td><td>${s.t ? ago(s.t) : ''}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div>
      <h3>Top DXCC entities</h3>
      <table><tbody>${topCountries.map(([c, n]) => `<tr><td>${esc(c)}</td><td class="num">${fmt(n)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table>
    </div>
  </div></td></tr>`;
}

function renderMatrix() {
  const { agg, query } = state.result;
  const modes = agg.modes;
  els.matrixHint.textContent = `Distinct ${query.dir === 'tx' ? 'stations hearing the area' : 'stations heard'} for each band and mode. Darker cells mean more stations.`;
  if (!modes.length) {
    els.matrix.innerHTML = '<tbody><tr><td>No spots in this window.</td></tr></tbody>';
    return;
  }
  let max = 1;
  for (const r of agg.rows) for (const m of r.modeList) max = Math.max(max, m.n);
  let html = `<thead><tr><th>Band</th>${modes.map(m => `<th>${esc(m)}</th>`).join('')}</tr></thead><tbody>`;
  for (const r of agg.rows) {
    const byMode = new Map(r.modeList.map(m => [m.mode, m.n]));
    html += `<tr><td>${esc(r.band.name)}</td>`;
    for (const m of modes) {
      const n = byMode.get(m) || 0;
      if (!n) { html += '<td class="cell zero">·</td>'; continue; }
      const a = 0.12 + 0.78 * Math.sqrt(n / max);
      const strong = a > 0.55;
      html += `<td class="cell" style="background:rgba(var(--heat),${a.toFixed(2)});${strong ? 'color:var(--accent-ink);font-weight:600' : ''}">${fmt(n)}</td>`;
    }
    html += '</tr>';
  }
  els.matrix.innerHTML = html + '</tbody>';
}

function initMap() {
  if (map) return;
  map = L.map('map', { preferCanvas: true, minZoom: 1 }).setView([30, -40], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  areaLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function renderMap() {
  initMap();
  const { agg, area, query } = state.result;
  const tx = query.dir === 'tx';
  areaLayer.clearLayers();
  markerLayer.clearLayers();

  const sq = gridToBounds(area.square);
  L.rectangle([[sq.s, sq.w], [sq.n, sq.e]], { color: '#0f766e', weight: 2, fillOpacity: 0.15 })
    .bindTooltip(`${area.square} (your area)`).addTo(areaLayer);

  const rows = agg.rows.filter(r => r.remoteList.length && (!state.selectedBand || r.band.name === state.selectedBand));
  const pts = [[sq.s, sq.w], [sq.n, sq.e]];
  for (const r of rows) {
    for (const s of r.remoteList) {
      if (!s.pos) continue;
      // Shift by 360° so every station sits within ±180° of the area; keeps the view centered on it.
      const lon = s.pos.lon + 360 * Math.round((sq.lon - s.pos.lon) / 360);
      pts.push([s.pos.lat, lon]);
      L.circleMarker([s.pos.lat, lon], {
        radius: 5, color: r.band.color, weight: 1, fillColor: r.band.color, fillOpacity: 0.75,
      }).bindTooltip(
        `<b>${esc(s.call)}</b> · ${esc(r.band.name)} ${esc(s.mode)}<br>${esc(s.loc || '')} · ${dist(s.km)}` +
        (typeof s.snr === 'number' ? ` · ${s.snr} dB` : '') +
        `<br>${tx ? 'heard' : 'heard by'} ${esc(s.local)}`
      ).addTo(markerLayer);
    }
  }
  // Wait a frame so the container has its final size before fitting the view.
  setTimeout(() => {
    map.invalidateSize({ animate: false });
    if (pts.length > 2) map.fitBounds(pts, { padding: [20, 20], maxZoom: 6, animate: false });
    else map.setView([sq.lat, sq.lon], 5, { animate: false });
  }, 0);

  els.mapTitle.textContent = state.selectedBand
    ? `${state.selectedBand}: ${tx ? 'who hears the area' : 'what the area hears'}`
    : (tx ? 'Who hears the area' : 'What the area hears');
  els.clearBand.hidden = !state.selectedBand;
  els.legend.innerHTML = agg.rows.filter(r => r.remoteList.length)
    .map(r => `<span><i style="background:${r.band.color}"></i>${esc(r.band.name)}</span>`).join('');
}

// ---------- Flow ----------

async function run({ force = false } = {}) {
  const query = { q: els.q.value.trim(), dir: els.dir.value, win: +els.win.value };
  if (!query.q) return;
  els.go.disabled = true;
  try {
    setStatus('<span class="spin"></span>Finding location…');
    const loc = await resolveLocation(query.q);
    const square = loc.grid.slice(0, 4).toUpperCase();
    if (!state.unit) state.unit = /^\d{5}/.test(query.q) || /\b(USA?|United States)\b/i.test(loc.label) ? 'mi' : 'km';

    setStatus(`<span class="spin"></span>Fetching spots for ${esc(square)} from PSK Reporter… big windows can take a while.`);
    const data = await fetchReports(square, query.dir, query.win, { force });
    const area = { square, grid: loc.grid, label: loc.label };
    if (state.result?.area.square !== square || state.result?.query.dir !== query.dir) {
      state.selectedBand = null;
      state.openDetail = null;
    }
    state.result = { area, query, reports: data.reports, fetchedAt: data.fetchedAt, agg: aggregate(data.reports, query.dir) };

    const url = new URL(location.href);
    url.search = new URLSearchParams({ q: query.q, dir: query.dir, win: String(query.win) });
    history.replaceState(null, '', url);

    setStatus(data.reports.length ? '' : `No spots for ${esc(square)} in the last ${windowLabel(query.win)}. Try a longer window or a neighboring area.`);
    render();
    scheduleRefreshUnlock();
  } catch (err) {
    setStatus(esc(err.message || String(err)), 'error');
  } finally {
    els.go.disabled = false;
  }
}

function scheduleRefreshUnlock() {
  clearInterval(refreshTimer);
  const tick = () => {
    const left = CACHE_MS - (Date.now() - state.result.fetchedAt);
    if (left <= 0) {
      els.refresh.disabled = false;
      els.refresh.textContent = 'Refresh';
      clearInterval(refreshTimer);
    } else {
      els.refresh.disabled = true;
      const s = Math.ceil(left / 1000);
      els.refresh.textContent = `Refresh in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
  };
  tick();
  refreshTimer = setInterval(tick, 1000);
}

function toggleBand(name) {
  state.selectedBand = state.selectedBand === name ? null : name;
  state.openDetail = state.selectedBand;
  renderBandTable();
  renderMap();
}

function init() {
  for (const id of ['q', 'dir', 'win', 'go', 'geo', 'status', 'results', 'gridBadge', 'place', 'meta', 'stats', 'refresh',
    'bandTable', 'bandHint', 'hLocal', 'hRemote', 'matrix', 'matrixHint', 'mapTitle', 'clearBand', 'legend']) {
    els[id] = document.getElementById(id);
  }

  els.search = document.getElementById('search');
  els.search.addEventListener('submit', e => { e.preventDefault(); run(); });
  els.refresh.addEventListener('click', () => run({ force: true }));
  els.clearBand.addEventListener('click', () => { state.selectedBand = null; state.openDetail = null; renderBandTable(); renderMap(); });

  els.geo.addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Your browser does not support geolocation.', 'error');
    setStatus('<span class="spin"></span>Getting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => { els.q.value = latLonToGrid(pos.coords.latitude, pos.coords.longitude); run(); },
      err => setStatus(`Couldn't get your location: ${esc(err.message)}`, 'error'),
      { maximumAge: 600000, timeout: 15000 }
    );
  });

  const tbody = els.bandTable.tBodies[0];
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr.band');
    if (tr) toggleBand(tr.dataset.band);
  });
  tbody.addEventListener('keydown', e => {
    const tr = e.target.closest('tr.band');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleBand(tr.dataset.band); }
  });

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    state.unit = b.dataset.unit;
    savePref('unit', state.unit);
    render();
  }));

  const p = new URLSearchParams(location.search);
  if (p.get('dir') === 'rx') els.dir.value = 'rx';
  if (p.get('win') && [...els.win.options].some(o => o.value === p.get('win'))) els.win.value = p.get('win');
  if (p.get('q')) { els.q.value = p.get('q'); run(); }
}

init();

// ---------- Installable app ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  });
}
