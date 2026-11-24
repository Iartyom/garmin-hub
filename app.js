// Garmin Hub: phone web app over Intervals.icu (which auto-imports from Garmin Connect).
// The API key and all data live only in this browser's localStorage; the only server contacted is intervals.icu
// (plus OpenStreetMap tiles + cdnjs for the ride map). Nothing personal is in the repo.
"use strict";
const API = "https://intervals.icu/api/v1";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// localStorage can throw (private mode, blocked storage): every access is guarded so the app still runs.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
let cfg = LS.get("gh.cfg", { key: "", athlete: "0" });
let db = LS.get("gh.db", null);            // {wellness:[...asc by date], acts:[...desc by date], at, demo}
let tab = LS.get("gh.tab", "today");
let fitRange = 90;

/* ---------- dates & formatting ---------- */
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseDay = s => new Date(s.slice(0, 10) + "T12:00:00");   // noon: immune to DST shifts
const daysAgo = s => Math.round((parseDay(iso(new Date())) - parseDay(s)) / 864e5);
const short = s => parseDay(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dayName = s => parseDay(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const km = m => m == null ? "–" : (m / 1000).toFixed(1);
const kmh = ms => ms == null ? "–" : (ms * 3.6).toFixed(1);
const hm = s => { if (s == null) return "–"; const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };
const r0 = v => v == null || isNaN(v) ? "–" : Math.round(v);
const isRide = a => /Ride/i.test(a.type || "");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : 0; };

/* ---------- Intervals.icu ---------- */
async function api(path) {
  // Intervals.icu personal keys use Basic auth with the literal username "API_KEY".
  const r = await fetch(API + path, { headers: { Authorization: "Basic " + btoa("API_KEY:" + cfg.key) } });
  if (r.status === 401 || r.status === 403) throw new Error("Intervals.icu refused the key or athlete ID. Check Settings.");
  if (!r.ok) throw new Error("Intervals.icu error " + r.status);
  return r.json();
}
// Keep only what the screens use: a year of full wellness objects would blow the ~5MB storage limit.
const slimW = w => ({ d: w.id, ctl: w.ctl, atl: w.atl, rhr: w.restingHR, hrv: w.hrv, sleep: w.sleepSecs, sleepScore: w.sleepScore, steps: w.steps, vo2: w.vo2max, weight: w.weight, floors: w.floorsClimbed });   // Venu 2: no HRV, has floors
const slimA = a => ({
  id: a.id, date: a.start_date_local, type: a.type, name: a.name, dist: a.distance, time: a.moving_time,
  climb: a.total_elevation_gain, spd: a.average_speed, maxSpd: a.max_speed, hr: a.average_heartrate,
  maxHr: a.max_heartrate, load: a.icu_training_load, zones: a.icu_hr_zone_times, drift: a.decoupling,
});

async function sync() {
  if (!cfg.key) { openSettings(); return; }
  status("Syncing…");
  const now = new Date(), ath = encodeURIComponent(cfg.athlete || "0");
  const q = `oldest=${iso(addDays(now, -365))}&newest=${iso(now)}`;
  try {
    const [w, a] = await Promise.all([api(`/athlete/${ath}/wellness?${q}`), api(`/athlete/${ath}/activities?${q}`)]);
    db = {
      wellness: w.map(slimW).sort((x, y) => x.d.localeCompare(y.d)),
      acts: a.map(slimA).sort((x, y) => y.date.localeCompare(x.date)),
      at: Date.now(),
    };
    LS.set("gh.db", db);
    status(`Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    render();
  } catch (e) {
    // A browser network failure surfaces as TypeError; say so instead of a cryptic "Failed to fetch".
    status(e instanceof TypeError ? "No connection to intervals.icu. Showing saved data." : e.message);
  }
}
const streamCache = {};
async function streams(act) {
  if (streamCache[act.id]) return streamCache[act.id];
  let s;
  if (db.demo) s = demoStreams(act);
  else {
    const raw = await api(`/activity/${encodeURIComponent(act.id)}/streams?types=time,latlng,heartrate,velocity_smooth,altitude`);
    s = {};
    for (const x of raw || []) {
      // latlng comes either as [lat,lng] pairs or as data (lat) + data2 (lng): accept both.
      if (x.type === "latlng") s.latlng = x.data2 ? x.data.map((lat, i) => [lat, x.data2[i]]) : x.data;
      else s[x.type] = x.data;
    }
  }
  return (streamCache[act.id] = s);
}

/* ---------- charts (hand-rolled SVG, hover/touch tooltip) ---------- */
const NS = "http://www.w3.org/2000/svg";
function niceRange(vals, padZero) {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (padZero) lo = Math.min(lo, 0);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; return [padZero && lo >= 0 ? 0 : lo - pad, hi + pad];
}
/** lineChart(el, {x:[labels], series:[{name, color, values}], fmt, zero}) — one y-axis, gaps for nulls. */
function lineChart(el, o) {
  const W = el.clientWidth || 320, H = o.height || 170, L = 34, R = o.series.length > 1 ? 44 : 10, T = 8, B = 20;
  const all = o.series.flatMap(s => s.values).filter(v => v != null && !isNaN(v));
  if (!all.length) { el.innerHTML = `<p class="muted">No data yet.</p>`; return; }
  const [lo, hi] = niceRange(all, o.zero);
  const n = o.x.length, xs = i => L + (n < 2 ? 0 : i * (W - L - R) / (n - 1)), ys = v => T + (hi - v) * (H - T - B) / (hi - lo);
  // Narrow ranges (VO2max 48-49) need a decimal or every gridline reads the same number.
  const fmt = o.fmt || (hi - lo < 6 ? v => v.toFixed(1) : v => r0(v));
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3, y = ys(v); g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="axis" x="${L - 4}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`; }
  if (o.zero && lo < 0) g += `<line x1="${L}" x2="${W - R}" y1="${ys(0)}" y2="${ys(0)}" stroke="var(--muted)" stroke-width="1"/>`;
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => g += `<text class="axis" x="${xs(i)}" y="${H - 4}" text-anchor="${["start", "middle", "end"][k]}">${short(o.x[i])}</text>`);
  for (const s of o.series) {
    let d = "", pen = false;
    s.values.forEach((v, i) => { if (v == null || isNaN(v)) { pen = false; return; } d += `${pen ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`; pen = true; });
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 4px ${s.color})"/>`;
    // Direct label at the line's end so identity isn't color-only (multi-series charts).
    if (o.series.length > 1) { const li = s.values.map((v, i) => v == null ? -1 : i).filter(i => i >= 0).pop(); if (li != null) g += `<text class="end" x="${xs(li) + 5}" y="${ys(s.values[li]) + 4}">${esc(s.short || s.name)}</text>`; }
  }
  g += `<line class="xhair" y1="${T}" y2="${H - B}" visibility="hidden"/>` + o.series.map(s => `<circle r="4" fill="${s.color}" stroke="var(--card)" stroke-width="2" visibility="hidden"/>`).join("");
  const legend = o.series.length > 1 ? `<div class="legend">${o.series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  el.innerHTML = `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" height="${H}">${g}</svg><div class="tip"></div></div>`;
  const box = $(".chart", el), svg = $("svg", box), tip = $(".tip", box), xh = $(".xhair", svg), dots = [...svg.querySelectorAll("circle")];
  const show = ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, n - 1)))));
    xh.setAttribute("x1", xs(i)); xh.setAttribute("x2", xs(i)); xh.setAttribute("visibility", "visible");
    o.series.forEach((s, k) => { const v = s.values[i]; if (v == null) dots[k].setAttribute("visibility", "hidden"); else { dots[k].setAttribute("cx", xs(i)); dots[k].setAttribute("cy", ys(v)); dots[k].setAttribute("visibility", "visible"); } });
    tip.innerHTML = `<b>${dayName(o.x[i])}</b>` + o.series.map(s => `<div><i style="background:${s.color}"></i>${esc(s.name)}: ${s.values[i] == null ? "–" : (o.tipFmt || fmt)(s.values[i])}</div>`).join("");
    tip.style.display = "block";
    const left = xs(i) * r.width / W; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + "px"; tip.style.top = "-" + (tip.offsetHeight + 4) + "px";
  };
  const hide = () => { tip.style.display = "none"; xh.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", hide);
}
const barPath = (x, y, w, h, r) => { r = Math.min(r, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
/** barChart(el, {x:[labels], values, color, fmt, label}) — rounded top, 2px gaps, tooltip per bar. */
function barChart(el, o) {
  const W = el.clientWidth || 320, H = o.height || 150, L = 34, R = 6, T = 8, B = 20;
  const vals = o.values.map(v => v || 0); if (!vals.some(v => v)) { el.innerHTML = `<p class="muted">No data yet.</p>`; return; }
  const [, hi] = niceRange(vals, true), n = vals.length, slot = (W - L - R) / n, bw = Math.max(2, slot - 2);
  const ys = v => T + (hi - v) * (H - T - B) / hi, fmt = o.fmt || (v => r0(v));
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = hi * k / 3, y = ys(v); g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="axis" x="${L - 4}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`; }
  vals.forEach((v, i) => { const x = L + i * slot + 1, y = ys(v); g += `<path data-i="${i}" d="${barPath(x, y, bw, H - B - y, 4)}" fill="${o.color}"/><rect data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>`; });
  [0, n - 1].forEach((i, k) => g += `<text class="axis" x="${L + i * slot + slot / 2}" y="${H - 4}" text-anchor="${k ? "end" : "start"}">${esc(o.xLabel ? o.xLabel(o.x[i]) : short(o.x[i]))}</text>`);
  el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" height="${H}">${g}</svg><div class="tip"></div></div>`;
  const svg = $("svg", el), tip = $(".tip", el);
  const show = ev => {
    const i = +ev.target.dataset.i; if (isNaN(i)) return;
    const r = svg.getBoundingClientRect();
    tip.innerHTML = `<b>${esc(o.tipLabel ? o.tipLabel(o.x[i]) : dayName(o.x[i]))}</b><div>${esc(o.label)}: ${o.values[i] == null ? "–" : (o.tipFmt || fmt)(o.values[i])}</div>`;
    tip.style.display = "block";
    const left = (L + i * slot + slot / 2) * r.width / W; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + "px"; tip.style.top = "-" + (tip.offsetHeight + 4) + "px";
  };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", () => tip.style.display = "none");
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------- Today: readiness verdict ---------- */
// Verdict = today's resting HR / HRV / sleep against your own previous 28 days, plus form (fitness − fatigue).
// Thresholds: 1 standard deviation off your baseline counts as a flag; 2+ flags = easy day.
function readiness() {
  const W = db.wellness, last = [...W].reverse().find(w => w.rhr || w.hrv || w.sleep);
  if (!last) return null;
  const i = W.indexOf(last), base = W.slice(Math.max(0, i - 28), i);
  const flags = [], good = [];
  const rhrs = base.map(w => w.rhr).filter(Boolean), hrvs = base.map(w => w.hrv).filter(Boolean);
  if (last.rhr && rhrs.length >= 7) { const m = mean(rhrs), up = Math.max(3, sd(rhrs)); if (last.rhr > m + up) flags.push(`Resting HR ${last.rhr} (usual ${r0(m)})`); else good.push(`Resting HR normal (${last.rhr})`); }
  if (last.hrv && hrvs.length >= 7) { const m = mean(hrvs), dn = sd(hrvs); if (last.hrv < m - dn) flags.push(`HRV ${r0(last.hrv)} is low (usual ${r0(m)})`); else good.push(`HRV normal (${r0(last.hrv)})`); }
  if (last.sleep) { if (last.sleep < 6 * 3600) flags.push(`Short sleep: ${hm(last.sleep)}`); else good.push(`Slept ${hm(last.sleep)}`); }
  const tsb = last.ctl != null && last.atl != null ? last.ctl - last.atl : null;
  if (tsb != null) { if (tsb < -25) flags.push(`Heavy fatigue: form ${r0(tsb)}`); else if (tsb > -10) good.push(`Fresh: form ${r0(tsb)}`); }
  // No baseline yet (new account / no history): don't pretend; say how many days are still needed.
  if (rhrs.length < 7 && hrvs.length < 7) return { last, flags, good, tsb, level: "calib", need: 7 - Math.max(rhrs.length, hrvs.length) };
  const level = flags.length >= 2 ? "easy" : flags.length === 1 || (tsb != null && tsb <= -10) ? "moderate" : "hard";
  // Score 0-100 (my own blend, not Garmin's): each baseline deviation of 1 SD moves it ~8 points,
  // sleep ±6 per hour around 7h, form adds up to +10 / −15. Venu 2 sends no HRV, so RHR carries most weight.
  let score = 70;
  if (last.rhr && rhrs.length >= 7) score -= (last.rhr - mean(rhrs)) / Math.max(2, sd(rhrs)) * 8;
  if (last.hrv && hrvs.length >= 7) score += (last.hrv - mean(hrvs)) / Math.max(1, sd(hrvs)) * 8;
  if (last.sleep) score += (last.sleep / 3600 - 7) * 6;
  if (tsb != null) score += Math.max(-15, Math.min(10, tsb / 2));
  return { last, flags, good, tsb, level, score: Math.round(Math.max(5, Math.min(99, score))) };
}
// Neon progress ring for the readiness score (stroke-dasharray trick: circumference × fraction).
const ring = (val, color, label) => { const c = 2 * Math.PI * 46, f = val == null ? 0 : val / 100;
  return `<div class="ring"><svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="46" fill="none" stroke="rgba(34,227,255,.1)" stroke-width="8"/>
    <circle cx="54" cy="54" r="46" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" style="filter:drop-shadow(0 0 6px ${color})"/></svg>
    <div class="num" style="color:${color};text-shadow:0 0 12px ${color}"><div>${val == null ? "··" : val}<small>${label}</small></div></div></div>`; };
function renderToday(v) {
  const R = readiness(), W = db.wellness, latest = [...W].reverse().find(w => w.rhr || w.hrv || w.sleep || w.steps);
  let h = "";
  // Stale-data nudge: the phone sync is also what refreshes the watch's satellite data (faster GPS lock).
  if (latest && daysAgo(latest.d) >= 2) h += `<div class="warnbar"><b>Watch last synced ${daysAgo(latest.d)} days ago.</b> Open Garmin Connect on your phone and let it sync, which also refreshes GPS satellite data so your next ride locks faster. Then tap Sync here.</div>`;
  if (R) {
    const V = { hard: ["Go hard", css("--good")], moderate: ["Moderate", css("--warn")], easy: ["Take it easy", css("--bad")], calib: ["Calibrating", css("--s1")] }[R.level];
    const notes = R.level === "calib" ? [`<li>Learning your normal: ${R.need} more day${R.need === 1 ? "" : "s"} of watch data needed.</li>`] : [];
    h += `<div class="card"><h2>Readiness · ${short(R.last.d)}</h2><div class="verdict">${ring(R.score ?? null, V[1], R.level === "calib" ? "WAIT" : "READY")}<div><h3 style="color:${V[1]}">${V[0]}</h3>
      <ul>${notes.join("")}${R.flags.map(f => `<li class="flag">${esc(f)}</li>`).join("")}${R.good.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div></div></div>`;
  }
  const w = latest || {}, f = [...W].reverse().find(x => x.ctl != null) || {}, vo = [...W].reverse().find(x => x.vo2) || {};
  const tile = (val, lab, sub) => `<div class="tile"><span>${lab}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  h += `<div class="card"><h2>Body</h2><div class="tiles">
    ${tile(r0(w.rhr), "Resting HR", "bpm")}${W.some(x => x.hrv) ? tile(r0(w.hrv), "HRV", "ms") : tile(w.floors ?? "–", "Floors", "climbed")}${tile(w.sleep ? hm(w.sleep) : "–", "Sleep", w.sleepScore ? `score ${w.sleepScore}` : "")}
    ${tile(r0(f.ctl), "Fitness", "CTL")}${tile(r0(f.atl), "Fatigue", "ATL")}${tile(f.ctl != null ? r0(f.ctl - f.atl) : "–", "Form", "fitness − fatigue")}
    ${tile(w.steps != null ? w.steps.toLocaleString() : "–", "Steps", "")}${tile(vo.vo2 ? vo.vo2.toFixed(0) : "–", "VO2max", "")}${tile(w.weight ? w.weight.toFixed(1) : "–", "Weight", "kg")}
  </div></div>`;
  const ride = db.acts.find(isRide);
  if (ride) h += `<div class="card"><h2>Last ride</h2>${rideButton(ride)}</div>`;
  v.innerHTML = h;
}

/* ---------- Rides ---------- */
const rideButton = a => `<button class="ride" data-ride="${esc(a.id)}"><div class="row"><span class="t">${esc(a.name || a.type)}</span><span class="muted">${dayName(a.date)}</span></div>
  <div class="m">${km(a.dist)} km · ${hm(a.time)} · ${kmh(a.spd)} km/h · ↑${r0(a.climb)} m${a.hr ? ` · ♥ ${r0(a.hr)}` : ""}${a.drift != null ? ` · drift ${a.drift.toFixed(1)}%` : ""}</div></button>`;
function weekStart(s) { const d = parseDay(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); }
function renderRides(v) {
  const rides = db.acts.filter(isRide);
  // Weekly distance, last 12 weeks, Monday-based; empty weeks stay as gaps of zero.
  const wk = [], mon = weekStart(iso(new Date()));
  for (let k = 11; k >= 0; k--) wk.push(iso(addDays(parseDay(mon), -7 * k)));
  const kmBy = Object.fromEntries(wk.map(w => [w, 0]));
  rides.forEach(a => { const w = weekStart(a.date); if (w in kmBy) kmBy[w] += (a.dist || 0) / 1000; });
  const thisWeek = kmBy[mon], avg = mean(wk.slice(0, -1).map(w => kmBy[w]));
  v.innerHTML = `<div class="card"><h2>Weekly distance</h2><p class="muted" style="margin:0 0 6px">This week ${thisWeek.toFixed(0)} km · 11-week average ${avg.toFixed(0)} km</p><div id="wkChart"></div></div>
    <div class="card"><h2>Rides (${rides.length} in the last year)</h2>${rides.slice(0, 60).map(rideButton).join("") || `<p class="muted">No rides synced yet.</p>`}</div>`;
  barChart($("#wkChart"), { x: wk, values: wk.map(w => kmBy[w]), color: css("--s1"), label: "Distance", fmt: v => r0(v), tipFmt: v => v.toFixed(1) + " km",
    xLabel: w => short(w), tipLabel: w => "Week of " + short(w) });
}
// Aerobic decoupling from the streams: speed-per-heartbeat in the first vs second half of moving time.
// Under 5% = solid endurance at that pace; rising drift on the same route = fatigue or heat.
function driftOf(s) {
  const hr = s.heartrate, sp = s.velocity_smooth; if (!hr || !sp) return null;
  const pts = []; for (let i = 0; i < hr.length; i++) if (hr[i] > 60 && sp[i] > 1.5) pts.push([sp[i], hr[i]]);
  if (pts.length < 120) return null;
  const half = pts.length >> 1, ef = a => mean(a.map(p => p[0])) / mean(a.map(p => p[1]));
  const e1 = ef(pts.slice(0, half)), e2 = ef(pts.slice(half));
  return (e1 - e2) / e1 * 100;
}
const down = (arr, n = 400) => { if (!arr || arr.length <= n) return arr; const k = arr.length / n; return Array.from({ length: n }, (_, i) => arr[Math.floor(i * k)]); };
async function openRide(id) {
  const a = db.acts.find(x => String(x.id) === String(id)); if (!a) return;
  $("#rideTitle").textContent = a.name || a.type;
  const body = $("#rideBody"); $("#rideSheet").classList.add("open");
  const tile = (val, lab) => `<div class="tile"><span>${lab}</span><b>${val}</b></div>`;
  body.innerHTML = `<p class="muted">${dayName(a.date)} · ${new Date(a.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
    <div id="map"></div>
    <div class="card"><div class="tiles">${tile(km(a.dist), "km")}${tile(hm(a.time), "Moving")}${tile(kmh(a.spd), "Avg km/h")}
      ${tile(kmh(a.maxSpd), "Max km/h")}${tile(r0(a.climb), "Climb m")}${tile(r0(a.hr), "Avg HR")}${tile(r0(a.maxHr), "Max HR")}${tile(r0(a.load), "Load")}<div class="tile" id="driftTile"><span>HR drift</span><b>…</b></div></div></div>
    <div class="card"><h2>Heart rate</h2><div id="hrC"></div></div>
    <div class="card"><h2>Speed (km/h)</h2><div id="spC"></div></div>
    <div class="card zones"><h2>Time in HR zones</h2><div id="zC"></div></div>`;
  if (a.zones && a.zones.length) {
    const tot = a.zones.reduce((s, x) => s + x, 0) || 1, mx = Math.max(...a.zones);
    $("#zC").innerHTML = a.zones.map((t, i) => `<div class="z"><span>Z${i + 1}</span><div class="bar" style="width:${(t / mx * 100).toFixed(1)}%;opacity:${(0.45 + 0.55 * (i + 1) / a.zones.length).toFixed(2)}"></div><span>${hm(t)}<br><small class="muted">${r0(t / tot * 100)}%</small></span></div>`).join("");
  } else $("#zC").innerHTML = `<p class="muted">No zone data.</p>`;
  let s;
  try { s = await streams(a); } catch (e) { $("#hrC").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const dr = a.drift != null ? a.drift : driftOf(s);
  $("#driftTile").innerHTML = `<span>HR drift</span><b>${dr == null ? "–" : dr.toFixed(1) + "%"}</b><small>${dr == null ? "" : dr < 5 ? "steady" : dr < 10 ? "some fade" : "big fade"}</small>`;
  // Charts are indexed by time; labels show the ride date (single day), so use elapsed minutes in the tooltip.
  const t = down(s.time || (s.heartrate || []).map((_, i) => i));
  const mins = v => Math.round(v / 60) + " min";
  const asLine = (el, vals, name, color, fmt) => {
    if (!vals) { el.innerHTML = `<p class="muted">Not recorded.</p>`; return; }
    lineChart(el, { x: t.map(() => a.date), series: [{ name, color, values: down(vals) }], fmt: v => r0(v), tipFmt: fmt });
    // Replace date labels/tooltips with elapsed time: rebuild axis text after render.
    const ax = el.querySelectorAll("text.axis"); const xl = [...ax].slice(-3);
    [0, Math.floor((t.length - 1) / 2), t.length - 1].forEach((i, k) => xl[k] && (xl[k].textContent = mins(t[i])));
  };
  asLine($("#hrC"), s.heartrate, "Heart rate", css("--bad"), v => r0(v) + " bpm");
  asLine($("#spC"), s.velocity_smooth && s.velocity_smooth.map(x => x * 3.6), "Speed", css("--s1"), v => v.toFixed(1) + " km/h");
  drawMap(s.latlng);
}
let leafletP;
function loadLeaflet() {
  // Leaflet is only fetched when a ride map is opened, so the rest of the app works offline.
  return leafletP ||= new Promise((ok, no) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.append(l);
    const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"; s.onload = ok; s.onerror = no; document.head.append(s);
  });
}
async function drawMap(ll) {
  const el = $("#map"); const pts = (ll || []).filter(p => p && p[0] != null && p[1] != null);
  if (pts.length < 2) { el.style.display = "none"; return; }
  try { await loadLeaflet(); } catch { el.innerHTML = `<p class="muted" style="padding:12px">Map needs a connection.</p>`; return; }
  const m = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(m);
  const line = L.polyline(down(pts, 1500), { color: css("--s2"), weight: 4 }).addTo(m);
  m.fitBounds(line.getBounds(), { padding: [16, 16] });
}

/* ---------- Fitness ---------- */
function renderFitness(v) {
  const W = db.wellness.filter(w => w.ctl != null).slice(-fitRange);
  const last = W[W.length - 1], wk = W[W.length - 8];
  const ramp = last && wk ? last.ctl - wk.ctl : null;
  v.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="muted">Range</span><div class="seg">${[42, 90, 365].map(r => `<button data-range="${r}" class="${r === fitRange ? "on" : ""}">${r === 365 ? "1 year" : r + " days"}</button>`).join("")}</div></div>
    ${ramp != null && ramp > 8 ? `<div class="warnbar"><b>Fitness rose ${ramp.toFixed(1)} in a week.</b> Above ~8/week is the usual path to overtraining or getting sick. Add an easy day.</div>` : ""}
    <div class="card"><h2>Fitness &amp; fatigue</h2><div id="ffC"></div>
      <p class="muted" style="font-size:13px">Fitness = 6-week average training load. Fatigue = last week's. Built from heart rate, since the Venu 2 has no power meter support.</p></div>
    <div class="card"><h2>Form (fitness − fatigue)</h2><div id="formC"></div>
      <p class="muted" style="font-size:13px">Below −25: deep fatigue. −10 to −25: building. Above +5: fresh, a good day to test yourself.</p></div>
    <div class="card"><h2>VO2max</h2><div id="voC"></div></div>
    <details><summary>Show as table</summary><table><tr><th>Date</th><th>Fitness</th><th>Fatigue</th><th>Form</th></tr>
      ${W.slice(-30).reverse().map(w => `<tr><td>${short(w.d)}</td><td>${r0(w.ctl)}</td><td>${r0(w.atl)}</td><td>${r0(w.ctl - w.atl)}</td></tr>`).join("")}</table></details>`;
  const x = W.map(w => w.d);
  lineChart($("#ffC"), { x, series: [{ name: "Fitness", short: "Fit", color: css("--s1"), values: W.map(w => w.ctl) }, { name: "Fatigue", short: "Fat", color: css("--s2"), values: W.map(w => w.atl) }] });
  lineChart($("#formC"), { x, series: [{ name: "Form", color: css("--s1"), values: W.map(w => w.ctl - w.atl) }], zero: true, height: 130 });
  const V = db.wellness.slice(-fitRange);
  lineChart($("#voC"), { x: V.map(w => w.d), series: [{ name: "VO2max", color: css("--s1"), values: V.map(w => w.vo2 || null) }], height: 120 });
}

/* ---------- Sleep ---------- */
function renderSleep(v) {
  const W = db.wellness.slice(-30), S = W.map(w => w.sleep ? w.sleep / 3600 : null);
  const have = S.filter(x => x != null), rh = W.map(w => w.rhr || null), hv = W.map(w => w.hrv || null);
  // Sleep vs next ride: average speed on rides after <6.5h vs ≥7h of sleep, over the whole year.
  const byDay = Object.fromEntries(db.wellness.map(w => [w.d, w.sleep]));
  const shortS = [], longS = [];
  db.acts.filter(isRide).forEach(a => { const sl = byDay[a.date.slice(0, 10)]; if (!sl || !a.spd || !a.hr) return; (sl < 6.5 * 3600 ? shortS : sl >= 7 * 3600 ? longS : []).push(a.spd * 3.6 / a.hr * 100); });
  const cmp = shortS.length >= 3 && longS.length >= 3 ? (() => { const a = mean(shortS), b = mean(longS), d = (a - b) / b * 100;
    return `<p>After short sleep (&lt;6.5h) you rode <b>${Math.abs(d).toFixed(0)}% ${d < 0 ? "less" : "more"} efficiently</b> (km/h per heartbeat) than after 7h+. <span class="muted">${shortS.length} vs ${longS.length} rides.</span></p>`; })()
    : `<p class="muted">Needs at least 3 rides after short sleep and 3 after a full night to compare.</p>`;
  v.innerHTML = `<div class="card"><h2>Sleep, last 30 nights</h2><p class="muted" style="margin:0 0 6px">Average ${have.length ? hm(mean(have) * 3600) : "–"} · under 6h on ${have.filter(x => x < 6).length} nights</p><div id="slC"></div></div>
    <div class="card"><h2>Sleep vs your rides</h2>${cmp}</div>
    <div class="card"><h2>Resting HR (bpm)</h2><div id="rhC"></div></div>
    <div class="card"><h2>HRV (ms)</h2><div id="hvC"></div></div>`;
  barChart($("#slC"), { x: W.map(w => w.d), values: S, color: css("--s1"), label: "Sleep", fmt: v => v.toFixed(0) + "h", tipFmt: v => hm(v * 3600) });
  lineChart($("#rhC"), { x: W.map(w => w.d), series: [{ name: "Resting HR", color: css("--s1"), values: rh }], height: 120 });
  lineChart($("#hvC"), { x: W.map(w => w.d), series: [{ name: "HRV", color: css("--s1"), values: hv }], height: 120 });
}

/* ---------- demo data (so the app can be tried before Intervals.icu is set up) ---------- */
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function demoData() {
  const R = rng(42), W = [], A = []; let ctl = 30, atl = 30;
  for (let k = 364; k >= 0; k--) {
    const d = iso(addDays(new Date(), -k)), dow = parseDay(d).getDay();
    let load = 0;
    if ([2, 4, 6].includes(dow) && R() > 0.15) {
      const dist = 18000 + R() * 45000, spd = 6.2 + R() * 1.6, time = dist / spd, hr = 128 + R() * 22;
      load = time / 3600 * (hr - 90) * 1.1;
      const z = [0.12, 0.38, 0.3, 0.15, 0.05].map(p => Math.round(p * time * (0.8 + R() * 0.4)));
      A.push({ id: "demo" + k, date: d + "T07:30:00", type: "Ride", name: dist > 45000 ? "Long ride" : "Morning ride", dist, time, climb: R() * 600, spd, maxSpd: spd * 1.7, hr, maxHr: hr + 30, load: Math.round(load), zones: z, drift: null });
    }
    ctl += (load - ctl) / 42; atl += (load - atl) / 7;
    W.push({ d, ctl, atl, rhr: Math.round(52 + R() * 6 + (atl - ctl) / 6), hrv: Math.round(62 + R() * 16 - (atl - ctl) / 3), sleep: (5.4 + R() * 3) * 3600, sleepScore: Math.round(60 + R() * 35), steps: Math.round(5000 + R() * 9000), vo2: k % 7 ? null : 46 + (365 - k) / 120, weight: null });
  }
  return { wellness: W, acts: A.reverse(), at: Date.now(), demo: true };
}
function demoStreams(a) {
  const n = Math.round(a.time), R = rng(a.time | 0), time = [], hr = [], sp = [], ll = [];
  let h = 100;
  for (let i = 0; i < n; i += 5) {
    time.push(i); h += ((a.hr + 8 * i / n) - h) * 0.05 + (R() - 0.5) * 3; hr.push(Math.round(h));
    sp.push(Math.max(0, a.spd + Math.sin(i / 300) * 1.5 + (R() - 0.5)));
    const t = i / n * Math.PI * 2; ll.push([32.1 + 0.05 * Math.sin(t), 34.86 + 0.04 * Math.cos(t)]);   // demo loop on land
  }
  return { time, heartrate: hr, velocity_smooth: sp, latlng: ll };
}

/* ---------- shell ---------- */
function status(t) { $("#status").textContent = t || ""; }
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#title").innerHTML = "<small>GARMIN·HUB</small>" + { today: "Today", rides: "Rides", fitness: "Fitness", sleep: "Sleep" }[tab];
  const v = $("#view");
  if (!db) { v.innerHTML = `<div class="card"><h2>Welcome</h2><p>Connect Intervals.icu in Settings (⚙) to see your Garmin data, or try the demo first.</p><button class="primary" id="goSet">Open settings</button> <button id="goDemo">Try demo data</button></div>`; return; }
  if (db.demo) status("Demo data. Add your Intervals.icu key in Settings for your own.");
  ({ today: renderToday, rides: renderRides, fitness: renderFitness, sleep: renderSleep })[tab](v);
}
function openSettings() {
  $("#key").value = cfg.key; $("#ath").value = cfg.athlete;
  $("#dataInfo").textContent = db ? `${db.demo ? "Demo data" : "Synced"}: ${db.wellness.length} days, ${db.acts.length} activities. Last sync ${new Date(db.at).toLocaleString()}.` : "Nothing stored.";
  $("#settings").classList.add("open");
}
function useDemo() { db = demoData(); LS.set("gh.db", db); $("#settings").classList.remove("open"); render(); }
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; LS.set("gh.tab", tab); window.scrollTo(0, 0); render(); }
  else if (t.dataset.ride) openRide(t.dataset.ride);
  else if (t.dataset.range) { fitRange = +t.dataset.range; render(); }
  else if (t.id === "syncBtn") db && db.demo && !cfg.key ? status("Demo mode: add your key in Settings to sync.") : sync();
  else if (t.id === "setBtn" || t.id === "goSet") openSettings();
  else if (t.id === "setClose") $("#settings").classList.remove("open");
  else if (t.id === "rideClose") { $("#rideSheet").classList.remove("open"); $("#rideBody").innerHTML = ""; }
  else if (t.id === "demoBtn" || t.id === "goDemo") useDemo();
  else if (t.id === "saveBtn") {
    cfg = { key: $("#key").value.trim(), athlete: $("#ath").value.trim() || "0" }; LS.set("gh.cfg", cfg);
    $("#settings").classList.remove("open"); if (db && db.demo) db = null; sync();
  } else if (t.id === "clearBtn") { LS.del("gh.db"); db = null; openSettings(); render(); }
});
// Charts are sized from their container width, so redraw on rotation/resize (debounced).
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 200); });
// ?demo loads demo data and #rides/#fitness/#sleep picks a tab: handy links for testing and showing the app.
if (/[?&]demo\b/.test(location.search) && (!db || db.demo)) db = demoData();
if (/^#(today|rides|fitness|sleep)$/.test(location.hash)) tab = location.hash.slice(1);
render();
if (location.hash === "#ride" && db) { const r = db.acts.find(isRide); if (r) openRide(r.id); }
if (db && !db.demo && cfg.key && Date.now() - db.at > 30 * 60e3) sync();   // auto-refresh when opened after 30+ min
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
