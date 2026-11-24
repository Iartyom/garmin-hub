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
// Skin = CSS token set on <html data-skin>; ?skin=x in the URL overrides (for previews/screenshots).
const SKIN_BAR = { term: "#0b0d10", game: "#0b0d26", synth: "#0a0218", pro: "#f2f3f5" };
// Per-skin vocabulary: the same screen speaks plain English, shell or RPG. Missing keys fall back to base.
const WORDS = {
  base: { normal: "Today vs your usual", insights: "What your data says", brand: "GARMIN·HUB", today: "Today", rides: "Workouts", fitness: "Fitness", sleep: "Sleep",
    readiness: "Readiness", plan: "Today's plan", engine: "Engine", riding: "Riding", vo2: "VO2max", rhr: "Resting HR", steps: "Steps/day",
    night: "Last night", sleepAvg: "Sleep avg", floors: "Floors", week: "This week", nRides: "Rides", longest: "Longest",
    hard: "Go hard", moderate: "Moderate", easy: "Take it easy", calib: "Calibrating" },
  term: { normal: "diff --usual", insights: "grep --patterns", brand: "user@garmin-hub:~$", today: "./today", rides: "./workouts", fitness: "./fitness", sleep: "./sleep",
    readiness: "readiness --today", plan: "suggested_cmd", engine: "engine --from-body", riding: "rides --summary",
    vo2: "vo2max", rhr: "rest_hr", steps: "steps/day", night: "sleep_last", sleepAvg: "sleep_avg", floors: "floors",
    week: "this_week", nRides: "rides", longest: "longest",
    hard: "STATUS: GO HARD", moderate: "STATUS: MODERATE", easy: "STATUS: REST", calib: "STATUS: CALIBRATING" },
  game: { normal: "Status effects", insights: "Lore unlocked", brand: "PLAYER ONE", today: "Status", rides: "Quests", fitness: "Training", sleep: "Inn",
    readiness: "HP", plan: "Next quest", engine: "Character stats", riding: "Quest log",
    vo2: "STA·VO2max", rhr: "DEF·Rest HR", steps: "AGI·Steps", night: "MANA·Sleep", sleepAvg: "MANA avg", floors: "Floors",
    week: "This week", nRides: "Quests", longest: "Longest",
    hard: "Full HP! Attack!", moderate: "Half HP. Grind.", easy: "Low HP. Rest at the inn.", calib: "Loading save..." },
};
const T = k => (WORDS[skin] && WORDS[skin][k]) || WORDS.base[k];
function setSkin(s) {
  if (!SKIN_BAR[s]) s = "term";   // also migrates removed skins (cyber, belay)
  document.documentElement.dataset.skin = s;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", SKIN_BAR[s]);
  document.querySelectorAll("[data-skin]").forEach(b => b.classList && b.tagName === "BUTTON" && b.classList.toggle("on", b.dataset.skin === s));
  return s;
}
let skin = setSkin((location.search.match(/[?&]skin=(\w+)/) || [])[1] || LS.get("gh.skin", "term"));
let fitRange = 90;

/* ---------- dates & formatting ---------- */
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseDay = s => new Date(s.slice(0, 10) + "T12:00:00");   // noon: immune to DST shifts
const daysAgo = s => Math.round((parseDay(iso(new Date())) - parseDay(s)) / 864e5);
const short = s => parseDay(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dayName = s => parseDay(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const km = m => m == null ? "–" : (m / 1000).toFixed(1);
const pace = ms => { if (!ms) return "–"; const sec = 1000 / ms; return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`; };
const kmh = ms => ms == null ? "–" : (ms * 3.6).toFixed(1);
const hm = s => { if (s == null) return "–"; const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };
const r0 = v => v == null || isNaN(v) ? "–" : Math.round(v);
const isRide = a => /Ride|Cycl|Bike/i.test(a.type || "");   // Intervals says "Ride", Garmin says "cycling"
// Workout families. Intervals passes Garmin's sport type through (Ride, VirtualRide, Run, TrailRun, WeightTraining, Walk, Hike, RockClimbing…).
const KINDS = [["ride", "Ride", /Ride|Cycl|Bike/i], ["run", "Run", /Run/i], ["gym", "Strength", /Weight|Strength|Crossfit|HIIT|Workout|Training|Yoga|Pilates|equipment|cardio|elliptical|stair/i],
  ["climb", "Climb", /Climb|Boulder/i], ["walk", "Walk", /Walk|Hike/i], ["swim", "Swim", /Swim/i]];
const kindOf = a => (KINDS.find(k => k[2].test(a.type || "")) || ["other", "Other"])[0];
const kindName = k => (KINDS.find(x => x[0] === k) || [k, "Other"])[1];
let wkFilter = "all";
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
const slimW = w => ({ d: w.id, ctl: w.ctl, atl: w.atl, rhr: w.restingHR, hrv: w.hrv, sleep: w.sleepSecs, sleepScore: w.sleepScore, sleepQ: w.sleepQuality, steps: w.steps, vo2: w.vo2max, weight: w.weight, floors: w.floorsClimbed });   // Venu 2: no HRV, has floors
const slimA = a => ({
  id: a.id, date: a.start_date_local, type: a.type, name: a.name, dist: a.distance, time: a.moving_time,
  climb: a.total_elevation_gain, spd: a.average_speed, maxSpd: a.max_speed, hr: a.average_heartrate,
  maxHr: a.max_heartrate, kcal: a.calories, load: a.icu_training_load, zones: a.icu_hr_zone_times, drift: a.decoupling,
});

// Garmin extras (Body Battery, stress, intensity minutes, sleep stages, bed/wake times) come from the user's PRIVATE
// repo, filled by garmin-hub-data/pull.py on their PC. Read with a fine-grained, read-only GitHub token kept on the phone.
const GH_DATA = "https://api.github.com/repos/Iartyom/garmin-hub-data/contents/data/daily.json";
let ghTok = LS.get("gh.ghtok", "");
async function ghFile(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${ghTok}`, Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`Garmin extras: GitHub ${r.status}${r.status === 401 || r.status === 404 ? " (check the token)" : ""}`);
  return r.json();
}
async function fetchGarmin() { return ghTok ? ghFile(GH_DATA) : null; }
// Garmin's own activity list (acts.json). Missing file (older puller) just means no extra history.
async function fetchGarminActs() { return ghTok ? ghFile(GH_DATA.replace("daily.json", "acts.json")).catch(() => null) : null; }
// Union of Intervals activities (have streams/maps) and Garmin-only history. Same activity = same type family
// starting within 3 min; then the Intervals copy wins. Garmin-only rows get id "g<id>" and src "garmin".
function mergeActs(iv, ga) {
  if (!ga) return iv;
  const t = a => Date.parse(a.date), extra = ga.filter(g => !iv.some(a => Math.abs(t(a) - t(g)) < 18e4 && kindOf(a) === kindOf(g)))
    .map(g => ({ ...g, id: "g" + g.gid, src: "garmin", spd: g.spd, load: null }));
  return [...iv, ...extra].sort((x, y) => y.date.localeCompare(x.date));
}
// Garmin row for a date (or undefined). Index rebuilt lazily when db changes.
let gIdx = null, gIdxOf = null;
const G = d => { if (!db || !db.garmin) return undefined; if (gIdxOf !== db.garmin) { gIdx = Object.fromEntries(db.garmin.map(r => [r.d, r])); gIdxOf = db.garmin; } return gIdx[d]; };
// Banister TRIMP for activities without a load (all Garmin-history ones): minutes × HR reserve × 0.64·e^(k·HRR),
// k = 1.92 men / 1.67 women. Rest HR = median resting HR, max HR = highest seen in any activity (floor 170).
// When Garmin history is present, fitness (42-day) and fatigue (7-day) are rebuilt from every activity's load,
// replacing Intervals' values, which only knew about the activities it imported.
function deriveLoad(d) {
  const rh = d.wellness.map(w => w.rhr).filter(Boolean).sort((a, b) => a - b); if (!rh.length) return;
  const rest = rh[rh.length >> 1], mx = Math.max(170, ...d.acts.map(a => a.maxHr || 0)), k = profile.sex === "f" ? 1.67 : 1.92;
  d.acts.forEach(a => { if (a.load == null && a.hr && a.time) { const r = Math.max(0, Math.min(1, (a.hr - rest) / (mx - rest))); a.load = Math.round(a.time / 60 * r * .64 * Math.exp(k * r)); } });
  if (!d.acts.some(a => a.src === "garmin")) return;
  const by = {}; d.acts.forEach(a => { const day = a.date.slice(0, 10); by[day] = (by[day] || 0) + (a.load || 0); });
  let ctl = 0, atl = 0; d.wellness.forEach(w => { const l = by[w.d] || 0; ctl += (l - ctl) / 42; atl += (l - atl) / 7; w.ctl = ctl; w.atl = atl; });
}
const APP_VER = "v20";   // keep in step with CACHE in sw.js; shown after sync so it's obvious which build the phone runs
async function sync() {
  if (!cfg.key) { openSettings(); return; }
  status("Syncing…");
  const now = new Date(), ath = encodeURIComponent(cfg.athlete || "0");
  const q = `oldest=${iso(addDays(now, -365))}&newest=${iso(now)}`;
  try {
    let gErr = null;
    const [w, a, me, gx, ga] = await Promise.all([api(`/athlete/${ath}/wellness?${q}`), api(`/athlete/${ath}/activities?${q}`), api(`/athlete/${ath}`).catch(() => null),
      fetchGarmin().catch(e => { gErr = e.message; return db && db.garmin || null; }), fetchGarminActs()]);   // extras failing must not block the main sync
    if (me && me.sex && !profile.sex) { profile.sex = /^f/i.test(me.sex) ? "f" : "m"; LS.set("gh.profile", profile); }
    db = {
      wellness: w.map(slimW).sort((x, y) => x.d.localeCompare(y.d)),
      acts: mergeActs(a.map(slimA), ga ? ga.filter(g => g.date >= iso(addDays(now, -365))) : null),
      garmin: gx, at: Date.now(),
    };
    deriveLoad(db);
    LS.set("gh.db", db);
    status(gErr || `Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${gx ? " · Garmin extras ✓" : ""} · ${APP_VER}`);
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
  // Body Battery at wake is Garmin's own overnight-recovery number (built on HRV the Venu 2 measures but never exports),
  // so it's the best recovery signal available. Under 40 at wake = didn't recharge.
  const gx = G(last.d), bb = gx && gx.bbWake;
  if (bb != null) { if (bb < 40) flags.push(`Body Battery only ${bb} at wake`); else good.push(`Body Battery ${bb} at wake`); }
  if (gx && gx.sleepStress != null && gx.sleepStress > 25) flags.push(`Restless night: sleep stress ${r0(gx.sleepStress)}`);
  // Form only counts LOGGED workouts. Unlogged running/gym made it meaningless, so it's ignored
  // until there are 8+ logged sessions in the last 6 weeks (enough for the 42-day fitness average to mean something).
  const logged = db.acts.filter(a => daysAgo(a.date.slice(0, 10)) <= 42).length;
  const tsb = logged >= 8 && last.ctl != null && last.atl != null ? last.ctl - last.atl : null;
  if (tsb != null) { if (tsb < -25) flags.push(`Heavy fatigue: form ${r0(tsb)}`); else if (tsb > -10) good.push(`Fresh: form ${r0(tsb)}`); }
  // No baseline yet (new account / no history): don't pretend; say how many days are still needed.
  if (rhrs.length < 7 && hrvs.length < 7) return { last, flags, good, tsb, level: "calib", need: 7 - Math.max(rhrs.length, hrvs.length) };
  const level = flags.length >= 2 ? "easy" : flags.length === 1 || (tsb != null && tsb <= -10) ? "moderate" : "hard";
  // Score = 70 + sum of drivers (my own blend, not Garmin's). Each driver is kept so the UI can show WHY:
  // RHR/HRV: ~8 pts per SD from your 28-day baseline; sleep ±6/h around 7h; form +10/−15.
  // With Body Battery the body-signal parts get 55% weight and Battery-at-wake 45% (it already summarises the night).
  const parts = [];
  if (last.rhr && rhrs.length >= 7) parts.push(["Resting HR", -(last.rhr - mean(rhrs)) / Math.max(2, sd(rhrs)) * 8, `${last.rhr} bpm, usual ${r0(mean(rhrs))}`]);
  if (last.hrv && hrvs.length >= 7) parts.push(["HRV", (last.hrv - mean(hrvs)) / Math.max(1, sd(hrvs)) * 8, `${r0(last.hrv)} ms, usual ${r0(mean(hrvs))}`]);
  if (last.sleep) parts.push(["Sleep", (last.sleep / 3600 - 7) * 6, `${hm(last.sleep)} (7h = neutral)`]);
  if (tsb != null) parts.push(["Training form", Math.max(-15, Math.min(10, tsb / 2)), `form ${r0(tsb)}`]);
  const wt = bb != null ? .55 : 1, drivers = parts.map(([k, v, d]) => [k, v * wt, d]);
  if (bb != null) drivers.push(["Body Battery", (bb - 70) * .45, `${bb} at wake (70 = neutral)`]);
  const score = 70 + drivers.reduce((t, d) => t + d[1], 0);
  // Level follows the score so the headline never contradicts the number; 2+ hard flags still force easy.
  const lvl = flags.length >= 2 || score < 55 ? "easy" : score < 68 || flags.length ? "moderate" : "hard";
  return { last, flags, good, tsb, level: lvl, drivers, score: Math.round(Math.max(5, Math.min(99, score))) };
}
// Neon progress ring for the readiness score (stroke-dasharray trick: circumference × fraction).
const ring = (val, color, label) => { const c = 2 * Math.PI * 46, f = val == null ? 0 : val / 100;
  return `<div class="ring"><svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="46" fill="none" stroke="rgba(var(--acc-rgb),.1)" stroke-width="8"/>
    <circle cx="54" cy="54" r="46" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" style="filter:drop-shadow(0 0 6px ${color})"/></svg>
    <div class="num" style="color:${color};text-shadow:0 0 12px ${color}"><div>${val == null ? "··" : val}<small>${label}</small></div></div></div>`; };
function renderToday(v) {
  const R = readiness(), W = db.wellness, latest = [...W].reverse().find(w => w.rhr || w.hrv || w.sleep || w.steps);
  let h = "";
  // Stale-data nudge: the phone sync is also what refreshes the watch's satellite data (faster GPS lock).
  if (latest && daysAgo(latest.d) >= 2) h += `<div class="warnbar"><b>Watch last synced ${daysAgo(latest.d)} days ago.</b> Open Garmin Connect on your phone and let it sync, which also refreshes GPS satellite data so your next ride locks faster. Then tap Sync here.</div>`;
  const rides = db.acts.filter(isRide);
  if (skin === "game") h += xpCard(rides);
  if (R) {
    const col = { hard: css("--good"), moderate: css("--warn"), easy: css("--bad"), calib: css("--s1") }[R.level];
    const notes = R.level === "calib" ? [`<li>Learning your normal: ${R.need} more day${R.need === 1 ? "" : "s"} of watch data needed.</li>`] : [];
    // Readiness widget by skin: ASCII bar (terminal), pixel HP bar (game), neon ring (others).
    const sc = R.score ?? null;
    const widget = skin === "term"
      ? `<pre class="ascii" style="--lvl:${col}" data-fill="${sc ?? 0}">${asciiBar(sc ?? 0)} ${sc == null ? "--" : sc}%<small>readiness score / 100</small></pre>`
      : skin === "game"
      ? `<div style="--lvl:${col}"><div class="barhead"><span>❤ HP</span><b>${sc == null ? "??" : sc}/100</b></div><div class="bar8${R.level === "easy" ? " low" : ""}"><i data-w="${sc ?? 0}" style="width:${sc ?? 0}%"></i></div></div>`
      : ring(sc, col, R.level === "calib" ? "WAIT" : "READY");
    const stack = skin !== "synth" && skin !== "pro";   // ring skins sit side by side; bar/board widgets need full width
    h += `<div class="card"><h2>${T("readiness")} · ${R.last.d === iso(new Date()) ? "this morning" : short(R.last.d)}</h2><div class="verdict${stack ? " stack" : ""}">${widget}<div><h3 class="type" style="color:${col}">${T(R.level)}</h3>
      ${R.drivers && R.drivers.length ? `<p class="muted" style="margin:2px 0 0">${(() => { const w = [...R.drivers].sort((a, b) => a[1] - b[1])[0]; return R.flags.length ? esc(R.flags[0]) : w && w[1] < -3 ? `Main drag: ${esc(w[0].toLowerCase())}` : "Nothing pulling you down."; })()}</p>` : `<ul>${notes.join("")}${R.flags.map(f => `<li class="flag">${esc(f)}</li>`).join("")}${R.good.map(f => `<li>${esc(f)}</li>`).join("")}</ul>`}</div></div>
      ${R.drivers && R.drivers.length ? driversHtml(R.drivers) : ""}
      ${commute.days.includes(new Date().getDay()) ? "" : `<div class="plan"><span>${T("plan")}</span><span class="type" style="all:unset">${esc(suggestion(R.level, rides))}</span></div>`}</div>`;
  }
  // Engine: fitness read from the BODY, so it includes the running/gym that was never logged.
  const vo = W.filter(x => x.vo2), voNow = vo.at(-1), vo90 = vo.find(x => daysAgo(x.d) <= 90);
  const rhr7 = avgDays(W, "rhr", 0, 6), rhr90 = avgDays(W, "rhr", 84, 97), st7 = avgDays(W, "steps", 0, 6), st14 = avgDays(W, "steps", 7, 13);
  const sl7 = avgDays(W, "sleep", 0, 6), sl14 = avgDays(W, "sleep", 7, 13), w = latest || {};
  h += commuteCard(R ? R.level : "calib", rides);
  h += normalCard() + insightsCard();
  v.innerHTML = h;
}
// 20-cell ASCII bar, filled to the score (terminal skin).
const asciiBar = s => "[" + "█".repeat(Math.round(s / 5)) + "░".repeat(20 - Math.round(s / 5)) + "]";
// Player One: XP from everything the watch saw, so unlogged days still level you up.
// 1 XP per 100 steps, 5 per floor, 30 per km ridden. Level L needs 250·L·(L−1) XP total (gentle quadratic curve).
const xpOfDay = (w = {}) => (w.steps || 0) / 100 + (w.floors || 0) * 5;
const levelOf = xp => Math.floor((1 + Math.sqrt(1 + xp / 62.5)) / 2);
const xpForLevel = L => 250 * L * (L - 1);
function xpCard(rides) {
  const xp = Math.round(db.wellness.reduce((s, w) => s + xpOfDay(w), 0) + rides.reduce((s, a) => s + (a.dist || 0) / 1000 * 30, 0));
  const today = iso(new Date()), gain = Math.round(xpOfDay(db.wellness.find(w => w.d === today)) + rides.filter(a => a.date.startsWith(today)).reduce((s, a) => s + (a.dist || 0) / 1000 * 30, 0));
  const L = levelOf(xp), lo = xpForLevel(L), hi = xpForLevel(L + 1), pct = (xp - lo) / (hi - lo) * 100;
  // Level-up fanfare once, when the level is higher than the one seen last time.
  const seen = LS.get("gh.lvl", null); if (seen != null && L > seen) setTimeout(() => levelUp(L), 400); LS.set("gh.lvl", L);
  return `<div class="card xpcard"><div class="row"><div><div class="tile" style="all:unset"><span style="font:400 8px 'Press Start 2P';color:var(--s1)">LEVEL</span></div><div class="lv">${L}</div></div>
    <div style="text-align:right;font:400 9px/1.8 'Press Start 2P'">${xp.toLocaleString()} XP${gain ? `<br><span class="xpgain">+${gain} XP today</span>` : ""}</div></div>
    <div class="bar8" style="margin-top:12px"><i data-w="${pct.toFixed(1)}" style="width:${pct.toFixed(1)}%"></i></div>
    <p class="muted note" style="font-size:11px">${(hi - xp).toLocaleString()} XP to level ${L + 1}. Steps, floors and km all count.</p></div>`;
}
function levelUp(L) {
  const d = document.createElement("div"); d.className = "lvup"; d.textContent = `LEVEL ${L}!`; document.body.append(d);
  buzz([30, 40, 30]); setTimeout(() => d.remove(), 2300);
}
// Mean of a wellness field over days [fromAgo..toAgo] back from today (ignores empty days).
function avgDays(W, f, fromAgo, toAgo) { const v = W.filter(w => { const a = daysAgo(w.d); return a >= fromAgo && a <= toAgo; }).map(w => w[f]).filter(x => x); return v.length ? mean(v) : null; }
// Tile with a change arrow. downIsGood flips the colour (resting HR falling = good). Arrow + words, never colour alone.
function dTile(val, lab, diff, downIsGood, sub, fmt) {
  let ch = sub ? `<small>${sub}</small>` : "";
  if (diff != null && fmt) {
    const flat = Math.abs(diff) < 0.05, good = downIsGood ? diff < 0 : diff > 0;
    ch = `<small class="${flat ? "" : good ? "up-good" : "up-bad"}">${flat ? "■ steady" : (diff > 0 ? "▲ " : "▼ ") + fmt(diff)} ${sub}</small>`;
  }
  return `<div class="tile"><span>${lab}</span><b>${val}</b>${ch}</div>`;
}
// One-line plan for a new rider: build distance ~10-15% at a time, easy when the body says so.
function suggestion(level, rides) {
  const longest = rides.length ? Math.max(...rides.map(a => a.dist || 0)) / 1000 : 0;
  // On commute days the two legs ARE the training; the Commute card has the per-leg plan, so don't stack a 70 km ride on top.
  if (commute.days.includes(new Date().getDay()))
    return level === "easy" ? "Commute day, low battery: ride both legs easy and skip extra training." : "Commute day: the two legs are today's training. Plan for each leg below.";
  if (level === "easy") return "Rest, a walk, or 30 min of very easy spinning. Your body is still recovering.";
  if (level === "moderate") return "Steady 45–60 min ride at a pace where you can still talk (zone 2).";
  if (level === "calib") return "Ride by feel; the app is still learning your normal resting HR.";
  if (!rides.length) return "Good day for a first proper ride: 45–60 min, easy to steady.";
  return `Good day to push: try a ride of ~${Math.round(longest * 1.15)} km (longest so far ${longest.toFixed(1)} km), or add a few hard 3-min efforts.`;
}

/* ---------- Visual building blocks (plain SVG/HTML strings; tooltips via data-tip, see #vtip handler) ---------- */
const tipAttr = t => ` data-tip="${esc(t)}"`;
// Readiness drivers: diverging bars around zero, biggest effect first. Sign is also printed, so colour isn't the only cue.
function driversHtml(D) {
  const mx = Math.max(12, ...D.map(d => Math.abs(d[1])));
  return `<div class="drivers">${[...D].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k, v, det]) => {
    const w = Math.abs(v) / mx * 50, pos = v >= 0;
    return `<div class="drv"${tipAttr(`${k}: ${det} → ${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} pts`)}><span>${esc(k)}<small>${esc(det)}</small></span>
      <div class="dbar"><i class="${pos ? "pos" : "neg"}" style="${pos ? "left:50%" : `left:${50 - w}%`};width:${Math.max(w, .8)}%"></i></div><b class="${pos ? "up-good" : "up-bad"}">${pos ? "+" : "−"}${Math.abs(v).toFixed(0)}</b></div>`; }).join("")}
    </div>`;
}
// "Today vs your usual" row: value, a range strip (shaded = your usual range = mean ± 1 SD of the previous 28 days,
// dot = latest), and a plain-words verdict. A single position on a bar reads faster than a sparkline for "is this normal?".
function normalRow(label, vals, fmt, downGood) {
  const xs = vals.filter(v => v[1] != null); if (xs.length < 5) return "";
  const last = xs[xs.length - 1][1], base = vals.slice(-29, -1).map(v => v[1]).filter(v => v != null);
  if (base.length < 5) return "";
  const m = mean(base), d = Math.max(sd(base), 1e-9), lo = m - d, hi = m + d;
  const a = Math.min(lo, last, ...base), b = Math.max(hi, last, ...base), pad = (b - a) * .08 || 1, A = a - pad, B = b + pad, pos = v => (v - A) / (B - A) * 100;
  const z = (last - m) / d, inside = Math.abs(z) < 1, good = (z < 0) === downGood;
  const word = inside ? "Normal for you" : `${z > 0 ? "Higher" : "Lower"} than usual · ${good ? "good" : "watch"}`;
  return `<div class="nrow"${tipAttr(`${label}: ${fmt(last)} · usual ${fmt(lo)}–${fmt(hi)}`)}><div class="nhead"><span>${esc(label)}</span><b>${fmt(last)}</b></div>
    <div class="rstrip"><i class="rband" style="left:${pos(lo).toFixed(1)}%;width:${(pos(hi) - pos(lo)).toFixed(1)}%"></i><i class="rdot ${inside ? "" : good ? "g" : "b"}" style="left:${pos(last).toFixed(1)}%"></i></div>
    <div class="nfoot"><span>usual ${String(fmt(lo)).replace(/ [^\d\s]+$/, "")} – ${fmt(hi)}</span><em class="${inside ? "muted" : good ? "up-good" : "up-bad"}">${inside ? "" : z > 0 ? "▲ " : "▼ "}${word}</em></div></div>`;
}
const series = (days, f) => { const out = []; for (let i = days - 1; i >= 0; i--) { const d = iso(new Date(Date.now() - i * 864e5)); out.push([d, f(d)]); } return out; };
function normalCard() {
  const byW = Object.fromEntries(db.wellness.map(w => [w.d, w])), n = d => byW[d] || {};
  const rows = [
    db.garmin ? normalRow("Body Battery at wake", series(30, d => G(d)?.bbWake ?? null), v => r0(v), false) : "",
    normalRow("Resting HR", series(30, d => n(d).rhr || null), v => r0(v) + " bpm", true),
    normalRow("Sleep", series(30, d => n(d).sleep ? n(d).sleep / 3600 : null), v => hm(v * 3600), false),
    db.garmin ? normalRow("Stress (day avg)", series(30, d => G(d)?.stress || null), v => r0(v), true) : "",
    normalRow("Steps", series(30, d => n(d).steps || null), v => r0(v).toLocaleString(), false),
  ].join("");
  return rows ? `<div class="card"><h2>${T("normal")}</h2>${rows}<p class="muted note">Shaded = your usual range (last 4 weeks). Dot = today.</p></div>` : "";
}
// Insights: split your own days into two groups and keep only differences that pass a Welch t-test (|t| > 2, n ≥ 6 each).
function welch(a, b) { if (a.length < 6 || b.length < 6) return null; const t = (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length); return Math.abs(t) > 2 ? t : null; }
const bedMin = ts => { const m = (ts / 6e4) % 1440; return m < 720 ? m + 1440 : m; };   // minutes after midnight, wrapped so 01:00 > 23:00
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
function insightsCard() {
  const gx = db.garmin || [], byW = Object.fromEntries(db.wellness.map(w => [w.d, w])), out = [];
  const byG = Object.fromEntries(gx.map(r => [r.d, r]));
  const next = d => iso(addDays(parseDay(d), 1));
  const add = (title, la, a, lb, b, fmt, unit) => { const t = welch(a, b); if (t == null) return;
    const ma = mean(a), mb = mean(b), mx = Math.max(ma, mb) || 1;
    out.push({ t: Math.abs(t), html: `<div class="ins"><p>${title}</p>
      <div class="cmp"${tipAttr(`${la}: ${fmt(ma)}${unit} (${a.length} days) · ${lb}: ${fmt(mb)}${unit} (${b.length} days)`)}>
        <div><span>${la}</span><i style="width:${(ma / mx * 100).toFixed(0)}%"></i><b>${fmt(ma)}${unit}</b></div>
        <div><span>${lb}</span><i class="b" style="width:${(mb / mx * 100).toFixed(0)}%"></i><b>${fmt(mb)}${unit}</b></div></div>
      <small class="muted">${a.length} vs ${b.length} days</small></div>` }); };
  // 1) earlier bedtime → Body Battery at wake
  const bedRows = gx.filter(r => r.bed && r.bbWake != null), med = bedRows.length ? bedRows.map(r => bedMin(r.bed)).sort((x, y) => x - y)[bedRows.length >> 1] : 0;
  add(`Going to bed before <b>${hhmm(med)}</b> (your median) changes how charged you wake up.`, `Before ${hhmm(med)}`, bedRows.filter(r => bedMin(r.bed) < med).map(r => r.bbWake),
    `After ${hhmm(med)}`, bedRows.filter(r => bedMin(r.bed) >= med).map(r => r.bbWake), r0, "");
  // 2) 7h+ sleep → Body Battery at wake
  const sb = gx.filter(r => r.bbWake != null && byW[r.d]?.sleep);
  add(`A full <b>7 h+</b> night vs a short one, measured in Body Battery at wake.`, "7 h+", sb.filter(r => byW[r.d].sleep >= 7 * 3600).map(r => r.bbWake), "Under 7 h", sb.filter(r => byW[r.d].sleep < 7 * 3600).map(r => r.bbWake), r0, "");
  // 3) active day → deep sleep that night (deep is stored on the wake-up date = next day)
  const act = gx.filter(r => byG[next(r.d)]?.deep);
  const im = r => (r.imMod || 0) + 2 * (r.imVig || 0);
  add(`Days with <b>30+ intensity minutes</b> vs quiet days: deep sleep the following night.`, "Active day", act.filter(r => im(r) >= 30).map(r => byG[next(r.d)].deep / 60),
    "Quiet day", act.filter(r => im(r) < 30).map(r => byG[next(r.d)].deep / 60), r0, " min");
  // 4) stressful day → next-morning resting HR
  const st = gx.filter(r => r.stress && byW[next(r.d)]?.rhr), sMed = st.length ? st.map(r => r.stress).sort((x, y) => x - y)[st.length >> 1] : 0;
  add(`A more stressful day than usual (stress over ${sMed}) and your <b>resting HR next morning</b>.`, "Stressful", st.filter(r => r.stress > sMed).map(r => byW[next(r.d)].rhr),
    "Calmer", st.filter(r => r.stress <= sMed).map(r => byW[next(r.d)].rhr), v => v.toFixed(1), " bpm");
  // 5) commute days vs others: day stress
  const cs = gx.filter(r => r.stress);
  add(`Commute days vs other days: average <b>stress</b>.`, "Commute", cs.filter(r => commute.days.includes(parseDay(r.d).getDay())).map(r => r.stress),
    "Other", cs.filter(r => !commute.days.includes(parseDay(r.d).getDay())).map(r => r.stress), r0, "");
  // 6) workout yesterday (walks excluded) vs rest day → Body Battery this morning
  const prevD = d => iso(addDays(parseDay(d), -1)), trainD = new Set(db.acts.filter(a => kindOf(a) !== "walk").map(a => a.date.slice(0, 10)));
  const bbN = gx.filter(r => r.bbWake != null);
  add(`The morning after a <b>workout</b> vs after a rest day: Body Battery at wake.`, "After workout", bbN.filter(r => trainD.has(prevD(r.d))).map(r => r.bbWake),
    "After rest", bbN.filter(r => !trainD.has(prevD(r.d))).map(r => r.bbWake), r0, "");
  // 7) evening workouts (start 18:00+) vs earlier → deep sleep that night (stored on the wake-up date)
  const hourD = h => new Set(db.acts.filter(a => kindOf(a) !== "walk" && h(+a.date.slice(11, 13))).map(a => a.date.slice(0, 10)));
  const lateD = hourD(h => h >= 18), earlyD = hourD(h => h < 18), deepAfter = set => gx.filter(r => set.has(r.d) && byG[next(r.d)]?.deep).map(r => byG[next(r.d)].deep / 60);
  add(`Training <b>in the evening</b> (after 18:00) vs earlier in the day: deep sleep that night.`, "Evening", deepAfter(lateD), "Earlier", deepAfter(earlyD), r0, " min");
  // 8) day after a workout → resting HR (works without Garmin extras too)
  const rhN = db.wellness.filter(w => w.rhr);
  add(`Resting HR the morning <b>after a workout</b> vs after a rest day.`, "After workout", rhN.filter(w => trainD.has(prevD(w.d))).map(w => w.rhr),
    "After rest", rhN.filter(w => !trainD.has(prevD(w.d))).map(w => w.rhr), v => v.toFixed(1), " bpm");
  out.sort((a, b) => b.t - a.t);
  return `<div class="card"><h2>${T("insights")}</h2>${out.length ? out.slice(0, 5).map(o => o.html).join("")
    : `<p class="muted">${db.garmin ? "No pattern strong enough yet." : "Connect Garmin extras in Settings to unlock more."}</p>`}
    <p class="muted note">Only differences unlikely to be chance. Patterns, not proof of cause.</p></div>`;
}
// Sleep timing: one floating bar per night from bedtime to wake on a clock axis (20:00 → 11:00), median bedtime marked.
function sleepTimingCard(n = 21) {
  const rows = (db.garmin || []).filter(r => r.bed && r.wake).slice(-n); if (rows.length < 3) return "";
  const A0 = 20 * 60, A1 = 35 * 60, W = 300, L = 44, rh = 13, H = rows.length * rh + 22, x = m => L + (m - A0) / (A1 - A0) * (W - L - 4);
  const bm = rows.map(r => bedMin(r.bed)), med = [...bm].sort((a, b) => a - b)[bm.length >> 1];
  const ticks = [21, 23, 25, 27, 29, 31, 33].map(h => `<text x="${x(h * 60).toFixed(1)}" y="${H - 6}" class="axis" text-anchor="middle">${String(h % 24).padStart(2, "0")}</text><line x1="${x(h * 60).toFixed(1)}" x2="${x(h * 60).toFixed(1)}" y1="0" y2="${H - 18}" class="grid"/>`).join("");
  const bars = rows.map((r, i) => { const b = bedMin(r.bed), w = b + (r.wake - r.bed) / 6e4, y = i * rh + 2;
    return `<text x="${L - 6}" y="${y + 9}" class="axis" text-anchor="end">${short(r.d)}</text><rect x="${x(b).toFixed(1)}" y="${y}" width="${Math.max(2, x(Math.min(w, A1)) - x(b)).toFixed(1)}" height="${rh - 4}" rx="4" class="sbar"${tipAttr(`${short(r.d)}: ${hhmm(b)} → ${hhmm(w)} · ${hm((r.wake - r.bed) / 1000)}`)}/>`; }).join("");
  const sdv = sd(bm);
  const dur = rows.map(r => (r.wake - r.bed) / 1000);
  return `<div class="card"><h2>Sleep timing</h2><p class="muted" style="margin:0 0 6px">Average ${hm(mean(dur))} · bed ${hhmm(med)} ±${r0(sdv)} min · ${dur.filter(x => x < 6 * 3600).length} short nights</p>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bed and wake times">${ticks}${bars}
      <line x1="${x(med).toFixed(1)}" x2="${x(med).toFixed(1)}" y1="0" y2="${H - 18}" class="medl"/></svg>
    <p class="muted note">One bar per night, bed → wake. Dashed = usual bedtime.</p></div>`;
}
// Sleep stages: stacked columns per night (deep at the base), hours axis, legend + tooltips.
function stagesCard(n = 21) {
  const rows = (db.garmin || []).filter(r => r.deep != null).slice(-n); if (rows.length < 3) return "";
  const S = [["Deep", "deep", "st-deep"], ["REM", "rem", "st-rem"], ["Light", "light", "st-light"], ["Awake", "awake", "st-awake"]];
  const W = 300, H = 150, B = 18, L = 22, mxH = Math.max(9, ...rows.map(r => S.reduce((t, s) => t + (r[s[1]] || 0), 0) / 3600));
  const y = h => H - B - h / mxH * (H - B - 6), bw = (W - L) / rows.length;
  const cols = rows.map((r, i) => { let acc = 0; return S.map(([nm, k, c]) => { const v = (r[k] || 0) / 3600; if (!v) return ""; const y0 = y(acc), y1 = y(acc + v); acc += v;
    return `<rect x="${(L + i * bw + 1).toFixed(1)}" y="${y1.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(0, y0 - y1 - 1).toFixed(1)}" class="${c}"${tipAttr(`${short(r.d)} · ${nm} ${hm(v * 3600)}`)}/>`; }).join(""); }).join("");
  const grid = [0, 4, 8].map(hh => `<line x1="${L}" x2="${W}" y1="${y(hh).toFixed(1)}" y2="${y(hh).toFixed(1)}" class="grid"/><text x="${L - 4}" y="${(y(hh) + 3).toFixed(1)}" class="axis" text-anchor="end">${hh}h</text>`).join("");
  const avg = k => mean(rows.map(r => r[k] || 0)), tot = S.reduce((t, s) => t + avg(s[1]), 0) || 1;
  return `<div class="card"><h2>Sleep stages</h2><div class="legend">${S.map(([nm, k, c]) => `<span><i class="${c}"></i>${nm} ${r0(avg(k) / tot * 100)}%</span>`).join("")}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sleep stages per night">${grid}${cols}
      <text x="${L}" y="${H - 4}" class="axis">${short(rows[0].d)}</text><text x="${W}" y="${H - 4}" class="axis" text-anchor="end">${short(rows[rows.length - 1].d)}</text></svg>
    <p class="muted note">Typical adult: 15–25% deep, 20–25% REM.</p></div>`;
}
// Body Battery: daily low→high range bar with a dot at wake. One axis (0–100).
function batteryCard(n = 30) {
  const rows = (db.garmin || []).filter(r => r.bbHigh != null).slice(-n); if (rows.length < 3) return "";
  const W = 300, H = 140, B = 18, L = 24, y = v => H - B - v / 100 * (H - B - 6), bw = (W - L) / rows.length;
  const grid = [0, 50, 100].map(v => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 3}" class="axis" text-anchor="end">${v}</text>`).join("");
  const marks = rows.map((r, i) => { const cx = L + i * bw + bw / 2;
    return `<rect x="${(cx - Math.min(4, bw / 3)).toFixed(1)}" y="${y(r.bbHigh).toFixed(1)}" width="${Math.min(8, bw / 1.5).toFixed(1)}" height="${Math.max(2, y(r.bbLow ?? r.bbHigh) - y(r.bbHigh)).toFixed(1)}" rx="3" class="bbr"${tipAttr(`${short(r.d)}: ${r.bbLow}–${r.bbHigh}${r.bbWake != null ? ` · wake ${r.bbWake}` : ""}`)}/>
      ${r.bbWake != null ? `<circle cx="${cx.toFixed(1)}" cy="${y(r.bbWake).toFixed(1)}" r="3.2" class="bbw"/>` : ""}`; }).join("");
  const wk = rows.slice(-7).filter(r => r.bbWake != null), pr = rows.slice(-14, -7).filter(r => r.bbWake != null);
  const dlt = wk.length && pr.length ? mean(wk.map(r => r.bbWake)) - mean(pr.map(r => r.bbWake)) : null;
  return `<div class="card"><h2>Body Battery</h2><div class="legend"><span><i class="bbr"></i>Day range (low–high)</span><span><i class="bbw dot"></i>At wake</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Body Battery per day">${grid}${marks}
      <text x="${L}" y="${H - 4}" class="axis">${short(rows[0].d)}</text><text x="${W}" y="${H - 4}" class="axis" text-anchor="end">${short(rows[rows.length - 1].d)}</text></svg>
    ${dlt != null ? `<p class="note">At-wake average this week ${dlt >= 0 ? "▲" : "▼"} ${Math.abs(dlt).toFixed(0)} vs the week before.</p>` : ""}</div>`;
}
// Intensity minutes per week vs the WHO 150-minute line (vigorous counts double, as Garmin and WHO count it).
function intensityCard() {
  if (!db.garmin) return "";
  const mon = weekStart(iso(new Date())), wk = []; for (let k = 11; k >= 0; k--) wk.push(iso(addDays(parseDay(mon), -7 * k)));
  const by = Object.fromEntries(wk.map(w => [w, 0])); db.garmin.forEach(r => { const w = weekStart(r.d); if (w in by) by[w] += (r.imMod || 0) + 2 * (r.imVig || 0); });
  const W = 300, H = 140, B = 18, L = 28, mx = Math.max(200, ...Object.values(by)) * 1.08, y = v => H - B - v / mx * (H - B - 6), bw = (W - L) / wk.length;
  const bars = wk.map((w, i) => `<rect x="${(L + i * bw + 2).toFixed(1)}" y="${y(by[w]).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${(H - B - y(by[w])).toFixed(1)}" rx="3" class="${by[w] >= 150 ? "imok" : "imlo"}"${tipAttr(`Week of ${short(w)}: ${by[w]} min`)}/>`).join("");
  const hit = wk.filter(w => by[w] >= 150).length;
  return `<div class="card"><h2>Intensity minutes / week</h2><p class="muted" style="margin:0 0 6px">WHO target 150 reached in ${hit} of the last 12 weeks</p>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Intensity minutes per week">
      <line x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="grid"/>${bars}
      <line x1="${L}" x2="${W}" y1="${y(150).toFixed(1)}" y2="${y(150).toFixed(1)}" class="medl"/><text x="${L - 4}" y="${(y(150) + 3).toFixed(1)}" class="axis" text-anchor="end">150</text>
      <text x="${L}" y="${H - 4}" class="axis">${short(wk[0])}</text><text x="${W}" y="${H - 4}" class="axis" text-anchor="end">${short(wk[wk.length - 1])}</text></svg>
    <p class="muted note">Everything the watch saw, logged or not. Dashed line = WHO 150.</p></div>`;
}

/* ---------- Garmin extras on Today ---------- */
// Clock time from Garmin's "local timestamp" (ms, local wall-clock encoded as if UTC).
const clock = ts => ts == null ? "–" : new Date(ts).toISOString().slice(11, 16);
// Intensity minutes the way Garmin/WHO count them: vigorous minutes count double. Last 7 days ending today.
const imWeek = () => { let t = 0; for (let i = 0; i < 7; i++) { const g = G(iso(new Date(Date.now() - i * 864e5))); if (g) t += (g.imMod || 0) + 2 * (g.imVig || 0); } return t; };
function recoveryCard() {
  if (!db.garmin || !db.garmin.length) return "";
  const g = [...db.garmin].reverse().find(r => r.bbHigh != null || r.deep != null); if (!g) return "";
  const tile = (val, lab, sub) => `<div class="tile"><span>${lab}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const st = [["Deep", g.deep, "--s1"], ["Light", g.light, "--s2"], ["REM", g.rem, "--good"], ["Awake", g.awake, "--muted"]].filter(x => x[1]);
  const tot = st.reduce((a, x) => a + x[1], 0) || 1, im = imWeek();
  return `<div class="card"><h2>Recovery · Garmin</h2><div class="tiles">
    ${tile(g.bbWake ?? "–", "Battery at wake", g.bbHigh != null ? `range ${g.bbLow}–${g.bbHigh}` : "")}
    ${tile(g.stress ?? "–", "Stress avg", g.stress == null ? "" : g.stress < 26 ? "rest-level" : g.stress < 51 ? "low" : g.stress < 76 ? "medium" : "high")}
    ${tile(im, "Intensity min", `last 7 days · goal 150`)}</div>
    ${st.length ? `<div class="stages" role="img" aria-label="Sleep stages">${st.map(([n, v, c]) => `<i style="flex:${v};background:var(${c})" title="${n} ${hm(v)}"></i>`).join("")}</div>
    <div class="legend">${st.map(([n, v, c]) => `<span><i style="background:var(${c})"></i>${n} ${hm(v)} · ${r0(v / tot * 100)}%</span>`).join("")}</div>
    <p class="muted note">Bed ${clock(g.bed)} → up ${clock(g.wake)}. Adults usually get ~15–25% deep and ~20–25% REM.</p>` : ""}</div>`;
}

/* ---------- Commute ---------- */
// The user's rides are a fixed commute (same route, set days, morning + evening). Settings hold the days/times;
// the Today card says whether today is a commute day, what to do on each leg, and when to start the watch.
let commute = LS.get("gh.commute", { days: [1, 2, 3], am: "07:30", pm: "17:30" });   // JS getDay(): 1=Mon
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toMin = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
// One workout per leg, picked by readiness. Morning stays easier: you arrive at work, not at your own shower.
function commutePlan(level) {
  return {
    hard: ["Easy warm spin, zone 2.", "3 × 3 min hard on the straightest stretch, 2 min easy between."],
    moderate: ["Steady zone 2, you can still talk.", "Zone 2 plus 5 × 20 s fast spin-ups (high cadence, light gear)."],
    easy: ["Very easy, low gear. Recovery ride.", "Same, no efforts. The commute is today's whole workout."],
    calib: ["Ride by feel, steady.", "Ride by feel, steady."],
  }[level] || ["Ride by feel.", "Ride by feel."];
}
// Same-route rides: commute-day rides within ±25% of their median distance (drops weekend long rides).
function commuteRides(rides) {
  const c = rides.filter(a => commute.days.includes(parseDay(a.date.slice(0, 10)).getDay()));
  if (!c.length) return [];
  const ds = c.map(a => a.dist || 0).sort((a, b) => a - b), med = ds[ds.length >> 1];
  return c.filter(a => Math.abs((a.dist || 0) - med) <= med * .25);
}
function commuteCard(level, rides) {
  if (!commute.days.length) return "";
  const now = new Date(), dow = now.getDay(), mins = now.getHours() * 60 + now.getMinutes();
  const isDay = commute.days.includes(dow), P = commutePlan(level), am = toMin(commute.am), pm = toMin(commute.pm);
  // days until the next commute day (today counts only if the evening leg hasn't passed)
  const next = commute.days.map(d => (d - dow + 7) % 7 || (mins > pm + 15 ? 7 : 0)).sort((a, b) => a - b)[0];
  // "Go" window: 30 min before a leg until 15 min after it. That's when to start Bike on the watch.
  const leg = isDay && ((mins >= am - 30 && mins <= am + 15) || (mins >= pm - 30 && mins <= pm + 15));
  const C = commuteRides(rides), best = C.length >= 2 ? C.reduce((b, a) => a.time < b.time ? a : b) : null;
  const avg = C.length >= 2 ? C.reduce((s, a) => s + (a.spd || 0), 0) / C.length : null;
  let h = `<div class="card${leg ? " go" : ""}"><h2>Commute${isDay ? " day" : ""}</h2>`;
  if (leg) h += `<div class="gobar"><b>⏱ Start Bike on your watch now.</b> Step outside first and wait for the GPS ring to go green (about 30 s), then press Start.</div>`;
  if (isDay) h += `<div class="legs"><div class="${mins > am + 15 ? "done" : ""}"><span>Morning · ${esc(commute.am)}</span>${esc(P[0])}</div>
      <div class="${mins > pm + 15 ? "done" : ""}"><span>Evening · ${esc(commute.pm)}</span>${esc(P[1])}</div></div>`;
  else h += `<p>No commute today. Next one ${next === 1 ? "tomorrow" : DAYS[(dow + next) % 7]}. Good slot for 20–30 min of strength (squats, lunges, core): stronger legs push harder on the bike.</p>`;
  if (best) h += `<p class="muted note">${C.length} commute rides · fastest ${hm(best.time)} (${dayName(best.date)}) · average ${kmh(avg)} km/h</p>`;
  return h + `</div>`;
}
// Google Calendar "add event" link with a weekly repeat. The calendar alert pops on the phone and
// Garmin Connect forwards it to the Venu 2 as a notification: the "start the clock" nudge on the wrist.
function calLink(label, time) {
  const by = commute.days.map(d => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d]).join(",");
  const d = new Date(); for (let i = 0; i < 7 && !commute.days.includes(d.getDay()); i++) d.setDate(d.getDate() + 1);
  const [hh, mm] = time.split(":").map(Number), endM = hh * 60 + mm + 45, ymd = iso(d).replace(/-/g, "");
  const p2 = n => String(n).padStart(2, "0");
  const q = new URLSearchParams({ action: "TEMPLATE", text: `${label} commute: start Bike on watch`,
    dates: `${ymd}T${p2(hh)}${p2(mm)}00/${ymd}T${p2(Math.floor(endM / 60) % 24)}${p2(endM % 60)}00`,
    details: "Step outside, wait for GPS lock, press Start on the Venu 2.", recur: `RRULE:FREQ=WEEKLY;BYDAY=${by}` });
  return "https://calendar.google.com/calendar/render?" + q;
}
function fillCommuteSettings() {
  $("#cDays").innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<button data-cday="${d}" class="${commute.days.includes(d) ? "on" : ""}">${DAYS[d]}</button>`).join("");
  $("#cAm").value = commute.am; $("#cPm").value = commute.pm;
  $("#calAm").href = calLink("Morning", commute.am); $("#calPm").href = calLink("Evening", commute.pm);
}
function saveCommute() {
  commute = { days: [...document.querySelectorAll("#cDays .on")].map(b => +b.dataset.cday), am: $("#cAm").value || "07:30", pm: $("#cPm").value || "17:30" };
  LS.set("gh.commute", commute); fillCommuteSettings();
}

/* ---------- Rides ---------- */
const rideButton = a => `<button class="ride" data-ride="${esc(a.id)}"><div class="row"><span class="t">${esc(a.name || a.type)}</span><span class="muted">${dayName(a.date)}</span></div>
  <div class="m">${km(a.dist)} km · ${hm(a.time)} · ${kmh(a.spd)} km/h · ↑${r0(a.climb)} m${a.hr ? ` · ♥ ${r0(a.hr)}` : ""}${a.drift != null ? ` · drift ${a.drift.toFixed(1)}%` : ""}</div></button>`;
function weekStart(s) { const d = parseDay(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); }
// Workouts tab: every activity type. Chips filter by family; the weekly chart shows training TIME (distance means
// nothing for gym or climbing). With Garmin extras, the week's intensity minutes are shown next to logged time, so
// unlogged sessions are visible.
function workoutButton(a) {
  const k = kindOf(a), gps = a.dist > 50;
  const meta = [gps ? `${km(a.dist)} km` : null, hm(a.time), gps && k === "ride" ? `${kmh(a.spd)} km/h` : null,
    gps && k === "run" && a.spd ? `${pace(a.spd)} /km` : null, a.climb > 5 ? `↑${r0(a.climb)} m` : null,
    a.hr ? `♥ ${r0(a.hr)}` : null, !gps && a.kcal ? `${r0(a.kcal)} kcal` : null].filter(Boolean).join(" · ");
  return `<button class="ride" data-ride="${esc(a.id)}"><div class="row"><span class="t"><span class="kind k-${k}">${kindName(k)}</span> ${esc(a.name || a.type)}</span><span class="muted">${dayName(a.date)}</span></div>
    <div class="m">${meta}</div></button>`;
}
// "Getting fitter?" per sport from GPS sessions: pace/speed and efficiency (metres per heartbeat) trends with 95% CI.
// Efficiency is the cleanest fitness signal from a watch: same speed at a lower heart rate = fitter.
// Consistency line: weeks (of the last 12) with 2+ non-walk workouts, and the current streak.
function progressCard(k) {
  const now = Date.now(), x = a => (Date.parse(a.date) - now) / 864e5, rows = [];
  const row = (label, xs, f, fmt, unit, upGood) => {
    const pts = xs.map(a => [x(a), f(a)]).filter(p => isFinite(p[1]) && p[1] > 0), L = linreg(pts); if (!L) return;
    const recent = mean(pts.slice(-5).map(p => p[1])), m = L.b * 30, sig = Math.abs(L.b) > L.ci, good = (m > 0) === upGood;
    rows.push(`<tr><td>${label}</td><td>${fmt(recent)}</td><td>${m >= 0 ? "+" : "−"}${fmt(Math.abs(m), true)}${unit}/mo</td>
      <td class="${sig ? (good ? "up-good" : "up-bad") : "muted"}">${sig ? (good ? "▲ better" : "▼ worse") : "steady"}</td></tr>`);
  };
  const gps = kk => db.acts.filter(a => kindOf(a) === kk && a.dist > 1000 && a.time > 300 && a.spd).sort((a, b) => a.date.localeCompare(b.date));
  const eff = a => a.hr ? a.spd * 60 / a.hr : NaN;   // metres per heartbeat
  const paceS = a => 1000 / a.spd;                      // seconds per km
  const fmtPace = (v, d) => d ? `${r0(v)} s` : `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`;
  const want = kk => k === "all" || k === kk;
  if (want("run")) { const R = gps("run"); row("Run pace /km", R, paceS, fmtPace, "", false); row("Run m / beat", R, eff, v => v.toFixed(2), "", true); }
  if (want("ride")) { const R = gps("ride"); row("Ride km/h", R, a => a.spd * 3.6, v => v.toFixed(1), "", true); row("Ride m / beat", R, eff, v => v.toFixed(2), "", true); }
  if (want("walk")) { const R = gps("walk"); row("Walk pace /km", R, paceS, fmtPace, "", false); }
  const mon = weekStart(iso(new Date())), wks = []; for (let i = 0; i < 12; i++) wks.push(iso(addDays(parseDay(mon), -7 * i)));
  const n = w => db.acts.filter(a => kindOf(a) !== "walk" && weekStart(a.date) === w).length;
  const active = wks.filter(w => n(w) >= 2).length; let streak = 0; for (const w of wks.slice(n(mon) >= 2 ? 0 : 1)) { if (n(w) >= 2) streak++; else break; }
  if (!rows.length && !active) return "";
  return `<div class="card"><h2>Getting fitter?</h2><p class="muted" style="margin:0 0 6px">Active weeks (2+ workouts, walks not counted): ${active} of 12 · streak ${streak}</p>
    ${rows.length ? `<table><tr><th></th><th>Recent</th><th>Trend</th><th></th></tr>${rows.join("")}</table>
    <p class="muted note">m / beat = metres per heartbeat: higher at the same effort = fitter. "Steady" = no change beyond chance.</p>` : ""}</div>`;
}
// List split by month with a session count + total time per header, so a long year stays scannable.
function monthGroups(list) {
  const by = []; list.forEach(a => { const m = a.date.slice(0, 7); if (!by.length || by[by.length - 1][0] !== m) by.push([m, []]); by[by.length - 1][1].push(a); });
  return by.map(([m, xs]) => `<h3 class="mhead"><span>${new Date(m + "-15").toLocaleDateString([], { month: "long", year: "numeric" })}</span><small>${xs.length} · ${hm(xs.reduce((t, a) => t + (a.time || 0), 0))}</small></h3>${xs.map(workoutButton).join("")}`).join("");
}
function renderRides(v) {
  const all = db.acts, present = KINDS.map(k => k[0]).filter(k => all.some(a => kindOf(a) === k)).concat(all.some(a => kindOf(a) === "other") ? ["other"] : []);
  if (wkFilter !== "all" && !present.includes(wkFilter)) wkFilter = "all";
  const list = wkFilter === "all" ? all : all.filter(a => kindOf(a) === wkFilter);
  const wk = [], mon = weekStart(iso(new Date()));
  for (let k = 11; k >= 0; k--) wk.push(iso(addDays(parseDay(mon), -7 * k)));
  const minBy = Object.fromEntries(wk.map(w => [w, 0]));
  list.forEach(a => { const w = weekStart(a.date); if (w in minBy) minBy[w] += (a.time || 0) / 60; });
  const thisWeek = minBy[mon], avg = mean(wk.slice(0, -1).map(w => minBy[w]));
  const nWeek = list.filter(a => weekStart(a.date) === mon).length;
  const im = db.garmin ? imWeek() : null;
  // same window as imWeek(): last 7 days, all workouts regardless of filter
  const log7 = all.filter(a => daysAgo(a.date.slice(0, 10)) <= 6).reduce((t, a) => t + (a.time || 0) / 60, 0);
  const kmW = list.filter(a => weekStart(a.date) === mon).reduce((t, a) => t + (a.dist || 0), 0);
  v.innerHTML = `<div class="chips">${["all", ...present].map(k => `<button data-wk="${k}" class="${k === wkFilter ? "on" : ""}">${k === "all" ? "All" : kindName(k)} <small>${k === "all" ? all.length : all.filter(a => kindOf(a) === k).length}</small></button>`).join("")}</div>
    <div class="card"><h2>Training time per week</h2>
      <p class="muted" style="margin:0 0 6px">This week ${hm(thisWeek * 60)} · ${nWeek} session${nWeek === 1 ? "" : "s"}${kmW ? ` · ${km(kmW)} km` : ""} · usual ${hm(avg * 60)}</p>
      <div id="wkChart"></div>
      ${im != null && im > log7 + 30 ? `<p class="note">Watch counted <b>${im} intensity min</b> this week vs ${r0(log7)} min recorded: some training wasn't saved as an activity.</p>` : ""}</div>
    ${wkFilter === "ride" && list.length ? (() => { const tot = list.reduce((t, a) => t + (a.dist || 0), 0), lg = Math.max(...list.map(a => a.dist || 0)), sp = list.slice(1, 11).filter(a => a.spd), l = list[0];
      const tile = (val, lab) => `<div class="tile"><span>${lab}</span><b>${val}</b></div>`;
      return `<div class="card"><div class="tiles">${tile(km(tot), "km this year")}${tile(km(lg), "Longest km")}${tile(kmh(l.spd), "Last km/h")}${sp.length ? tile(kmh(mean(sp.map(a => a.spd))), "Usual km/h") : ""}</div></div>`; })() : ""}
    ${progressCard(wkFilter)}
    <div class="card"><h2>${wkFilter === "all" ? "All workouts" : kindName(wkFilter)} · ${list.length}</h2>${monthGroups(list.slice(0, 120)) || `<p class="muted">Nothing synced yet. Start an activity on the watch and it shows up here after Garmin Connect syncs.</p>`}</div>`;
  barChart($("#wkChart"), { x: wk, values: wk.map(w => minBy[w]), color: css("--s1"), label: "Time", fmt: v => v >= 60 ? (v / 60).toFixed(v >= 600 ? 0 : 1) + "h" : r0(v) + "m", tipFmt: v => hm(v * 60),
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
  const gps = a.dist > 50;   // indoor/gym sessions: no map, speed or distance
  body.innerHTML = `<p class="muted">${dayName(a.date)} · ${new Date(a.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
    ${gps ? `<div id="map"></div>` : ""}
    <div class="card"><div class="tiles">${gps ? tile(km(a.dist), "km") : ""}${tile(hm(a.time), "Moving")}${gps ? (kindOf(a) === "run" ? tile(pace(a.spd), "Pace /km") : tile(kmh(a.spd), "Avg km/h")) : ""}
      ${gps ? tile(kmh(a.maxSpd), "Max km/h") : ""}${gps ? tile(r0(a.climb), "Climb m") : ""}${tile(r0(a.hr), "Avg HR")}${tile(r0(a.maxHr), "Max HR")}${a.kcal ? tile(r0(a.kcal), "kcal") : ""}${tile(r0(a.load), "Load")}${gps ? `<div class="tile" id="driftTile"><span>HR drift</span><b>…</b></div>` : ""}</div></div>
    <div class="card"><h2>Heart rate</h2><div id="hrC"></div></div>
    ${gps ? `<div class="card"><h2>Speed (km/h)</h2><div id="spC"></div></div>` : ""}
    <div class="card zones"><h2>Time in HR zones</h2><div id="zC"></div></div>`;
  if (a.zones && a.zones.length) {
    const tot = a.zones.reduce((s, x) => s + x, 0) || 1, mx = Math.max(...a.zones);
    $("#zC").innerHTML = a.zones.map((t, i) => `<div class="z"><span>Z${i + 1}</span><div class="bar" style="width:${(t / mx * 100).toFixed(1)}%;opacity:${(0.45 + 0.55 * (i + 1) / a.zones.length).toFixed(2)}"></div><span>${hm(t)}<br><small class="muted">${r0(t / tot * 100)}%</small></span></div>`).join("");
  } else $("#zC").innerHTML = `<p class="muted">No zone data.</p>`;
  let s;
  if (a.src === "garmin") { $("#hrC").innerHTML = `<p class="muted">Imported from Garmin history: summary only. Activities recorded after you linked Intervals.icu get full charts and maps.</p>`; if ($("#driftTile")) $("#driftTile").remove(); if ($("#spC")) $("#spC").closest(".card").remove(); if ($("#map")) $("#map").remove(); return; }
  try { s = await streams(a); } catch (e) { $("#hrC").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const dr = a.drift != null ? a.drift : driftOf(s);
  if ($("#driftTile")) $("#driftTile").innerHTML = `<span>HR drift</span><b>${dr == null ? "–" : dr.toFixed(1) + "%"}</b><small>${dr == null ? "" : dr < 5 ? "steady" : dr < 10 ? "some fade" : "big fade"}</small>`;
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
  if (gps) asLine($("#spC"), s.velocity_smooth && s.velocity_smooth.map(x => x * 3.6), "Speed", css("--s1"), v => v.toFixed(1) + " km/h");
  if (gps) drawMap(s.latlng);
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
  // Fitness/fatigue come from LOGGED training load only; with few logged sessions they're flat lines that mislead, so hide them
  // (same 8-in-42-days rule readiness uses).
  const enough = db.acts.filter(a => a.load && daysAgo(a.date.slice(0, 10)) <= 42).length >= 8;
  const V = db.wellness.slice(-fitRange);
  v.innerHTML = healthReport() + intensityCard() + batteryCard() + `<div class="row" style="margin-bottom:10px"><span class="muted">Range</span><div class="seg">${[42, 90, 365].map(r => `<button data-range="${r}" class="${r === fitRange ? "on" : ""}">${r === 365 ? "1 year" : r + " days"}</button>`).join("")}</div></div>
    ${enough && ramp != null && ramp > 8 ? `<div class="warnbar"><b>Fitness rose ${ramp.toFixed(1)} in a week.</b> Above ~8/week is the usual path to overtraining or getting sick. Add an easy day.</div>` : ""}
    <div class="card"><h2>Resting HR</h2><div id="rhC"></div></div>
    <div class="card"><h2>VO2max</h2><div id="voC"></div></div>
    ${enough ? `<div class="card"><h2>Fitness &amp; fatigue</h2><div id="ffC"></div>
      <p class="muted note">Fitness = 6-week training load, fatigue = 1-week. From recorded workouts only.</p></div>
    <div class="card"><h2>Form (fitness − fatigue)</h2><div id="formC"></div>
      <p class="muted note">Below −25 deep fatigue · above +5 fresh.</p></div>` : ""}
    ${statsCard()}
    ${enough ? `<details><summary>Show as table</summary><table><tr><th>Date</th><th>Fitness</th><th>Fatigue</th><th>Form</th></tr>
      ${W.slice(-30).reverse().map(w => `<tr><td>${short(w.d)}</td><td>${r0(w.ctl)}</td><td>${r0(w.atl)}</td><td>${r0(w.ctl - w.atl)}</td></tr>`).join("")}</table></details>` : ""}`;
  lineChart($("#rhC"), { x: V.map(w => w.d), series: [{ name: "Resting HR", color: css("--s1"), values: V.map(w => w.rhr || null) }], height: 120 });
  // VO2max updates only every few days; nulls between would break the line into invisible dots, so plot measured days only.
  const VV = V.filter(w => w.vo2);
  lineChart($("#voC"), { x: VV.map(w => w.d), series: [{ name: "VO2max", color: css("--s1"), values: VV.map(w => w.vo2) }], height: 120 });
  if (!enough) return;
  const x = W.map(w => w.d);
  lineChart($("#ffC"), { x, series: [{ name: "Fitness", short: "Fit", color: css("--s1"), values: W.map(w => w.ctl) }, { name: "Fatigue", short: "Fat", color: css("--s2"), values: W.map(w => w.atl) }] });
  lineChart($("#formC"), { x, series: [{ name: "Form", color: css("--s1"), values: W.map(w => w.ctl - w.atl) }], zero: true, height: 130 });
}

/* ---------- Health report: your numbers vs published research ---------- */
// Profile is only used for age/sex norms. Stored on the phone like everything else.
let profile = LS.get("gh.profile", { age: null, sex: "" });
const prof = () => db && db.demo && !profile.age ? { age: 32, sex: "m" } : profile;   // demo gets a sample profile
// Cooper Institute VO2max norms as printed in Garmin's manuals: cutoffs for 40th/60th/80th/95th percentile,
// per 10-year age group starting at 20–29. Below the first cutoff = Poor.
const VO2_NORMS = {
  m: [[41.7, 45.4, 51.1, 55.4], [40.5, 44, 48.3, 54], [38.5, 42.4, 46.4, 52.5], [35.6, 39.2, 43.4, 48.9], [32.3, 35.5, 39.5, 45.7], [29.4, 32.3, 36.7, 42.1]],
  f: [[36.1, 39.5, 43.9, 49.6], [34.4, 37.8, 42.4, 47.4], [33, 36.3, 39.7, 45.3], [30.1, 33, 36.7, 41.1], [27.5, 30, 33, 37.8], [25.9, 28.1, 30.9, 36.7]],
};
const SRC = {
  cooper: ["Cooper Institute norms (Garmin manual)", "https://www8.garmin.com/manuals/webhelp/venu/EN-US/GUID-1FBCCD9E-19E1-4E4C-BD60-1793B5B97EB3.html"],
  kodama: ["Kodama 2009, JAMA (33 studies)", "https://doi.org/10.1001/jama.2009.681"],
  zhang: ["Zhang 2016, CMAJ (46 studies, 1.2M people)", "https://www.cmaj.ca/content/188/3/E53"],
  paluch: ["Paluch 2022, Lancet Public Health (15 cohorts)", "https://pubmed.ncbi.nlm.nih.gov/35247352/"],
  watson: ["Watson 2015, AASM/SRS consensus", "https://doi.org/10.5664/jcsm.4758"],
  windred: ["Windred 2024, Sleep (UK Biobank, 61k)", "https://pmc.ncbi.nlm.nih.gov/articles/PMC10782501"],
  who: ["WHO 2020 activity guidelines", "https://www.who.int/publications/i/item/9789240015128"],
  celis: ["Celis-Morales 2017, BMJ (UK Biobank, 263k)", "https://pubmed.ncbi.nlm.nih.gov/28424154/"],
};
const cite = k => `<a class="src" href="${SRC[k][1]}" target="_blank" rel="noopener">${SRC[k][0]}</a>`;
// One benchmark row: banded scale (one hue, darker = better band), "you" marker, verdict text, sources.
// bands = [[upTo, label], ...] ascending; the last band runs to max.
function bench(title, val, shown, min, max, bands, verdict, srcs) {
  const pos = v => Math.max(0, Math.min(100, (v - min) / (max - min) * 100));
  let lo = min;
  const seg = bands.map(([to, lab, strong], i) => { const w = pos(Math.min(to, max)) - pos(lo); lo = to;
    return `<div style="width:${w}%;--o:${strong ? .55 : .14 + i * .06}"><span>${lab}</span></div>`; }).join("");
  return `<div class="bench"><div class="row"><b>${title}</b><span class="bv">${shown}</span></div>
    <div class="scale">${seg}${val == null ? "" : `<i style="left:${pos(val)}%" title="you"></i>`}</div>
    <p>${verdict}</p><p class="cites">${srcs.map(cite).join(" · ")}</p></div>`;
}
// ---- small stats toolkit ----
const tcrit = df => 1.96 + 2.4 / Math.max(1, df);   // ≈ two-sided 95% Student t (within ~2% for df ≥ 3)
// Least-squares slope per day with its 95% CI. pts = [[x, y]...]
function linreg(pts) {
  const n = pts.length; if (n < 10) return null;
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0), b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
  const res = pts.reduce((s, [x, y]) => s + (y - (my + b * (x - mx))) ** 2, 0);
  const se = Math.sqrt(res / (n - 2) / sxx); return { b, ci: tcrit(n - 2) * se, n };
}

function healthReport() {
  const W = db.wellness, P = prof(), last = n => W.slice(-n);
  const vals = (arr, f) => arr.map(f).filter(x => x != null && x > 0);
  let h = `<div class="card"><h2>You vs research</h2>`;
  if (!P.age || !P.sex) h += `<div class="warnbar">Add your <b>age and sex</b> in Settings → Profile. VO2max and step targets depend on both.</div>`;
  // VO2max
  const vo = [...W].reverse().find(w => w.vo2);
  if (vo) {
    const v = vo.vo2, g = P.age ? Math.max(0, Math.min(5, Math.floor((P.age - 20) / 10))) : null, N = g != null && VO2_NORMS[P.sex] ? VO2_NORMS[P.sex][g] : null;
    if (N) {
      const labs = ["Poor", "Fair", "Good", "Excellent", "Superior"], k = N.filter(c => v >= c).length, nextC = N[k];
      h += bench("VO2max", v, v.toFixed(0), N[0] - 8, N[3] + 6, [[N[0], "Poor"], [N[1], "Fair"], [N[2], "Good"], [N[3], "Excel."], [99, "Super.", 1]],
        `<b>${labs[k]}</b> for your age${nextC ? ` · ${(nextC - v).toFixed(1)} to ${labs[k + 1]}` : ""}. Each +3.5 ≈ <b>13% lower</b> all-cause mortality.`, ["cooper", "kodama"]);
    } else h += bench("VO2max", null, v.toFixed(0), 25, 60, [[35, ""], [45, ""], [99, ""]], "Add age in Settings to rank this. Each +3.5 ≈ 13% lower all-cause mortality.", ["kodama"]);
  }
  // Resting HR (30-day mean)
  const rh = vals(last(30), w => w.rhr);
  if (rh.length >= 5) {
    const m = mean(rh);
    h += bench("Resting HR", m, `${m.toFixed(0)} bpm`, 35, 95, [[50, "Athletic", 1], [60, "Low"], [80, "Mid"], [99, "High"]],
      m < 60 ? `<b>Lowest-risk band.</b> 60–80 bpm carries +12%, over 80 +45%.`
        : `Each +10 bpm ≈ <b>+9%</b> all-cause mortality. Regular cardio (your commute) brings it down.`, ["zhang"]);
  }
  // Steps (30-day mean); plateau depends on age
  const st = vals(last(30), w => w.steps);
  if (st.length >= 5) {
    const m = mean(st), old = (P.age || 0) >= 60, a = old ? 6000 : 8000, b = old ? 8000 : 10000;
    h += bench("Steps / day", m, r0(m).toLocaleString(), 0, 14000, [[4000, "Low"], [a, "Gaining"], [b, "Plateau", 1], [99, "Beyond"]],
      m >= a ? `<b>At the plateau</b> (${a / 1000}–${b / 1000}k): more steps add fitness, little longevity.`
        : `Benefit keeps rising to <b>${a / 1000}k</b>: ${r0(a - m).toLocaleString()} more a day.`, ["paluch"]);
  }
  // Sleep duration + regularity (30 nights)
  const sl = vals(last(30), w => w.sleep).map(x => x / 3600);
  if (sl.length >= 7) {
    const m = mean(sl), v = sd(sl) * 60;
    h += bench("Sleep", m, hm(m * 3600), 4, 10, [[6, "Short"], [7, "Below"], [9, "7–9h", 1], [99, "Long"]],
      m >= 7 ? `<b>Meets</b> the 7h+ adult recommendation.` : `<b>Under</b> the recommended 7h+.`, ["watson"]);
    // With Garmin bed times: SD of bedtime (minutes, wrapped around midnight). Otherwise SD of sleep length.
    const beds = (db.garmin || []).slice(-30).map(r => r.bed).filter(Boolean).map(ts => { const m = (ts / 6e4) % 1440; return m < 720 ? m + 1440 : m; });
    const useBed = beds.length >= 7, vv = useBed ? sd(beds) : v;
    h += bench("Sleep regularity", 150 - vv, `±${r0(vv)} min`, 0, 150, [[60, "Irregular"], [90, "Variable"], [120, "Regular"], [999, "Steady", 1]],
      `${useBed ? "Bedtime" : "Sleep length"} varies ±${r0(vv)} min. <b>Regular</b> sleep predicted mortality better than <b>long</b> sleep.`, ["windred"]);
  }
  // Activity minutes per week from logged rides (last 4 weeks)
  const rides = db.acts.filter(isRide), since = iso(new Date(Date.now() - 28 * 864e5));
  // Prefer Garmin intensity minutes (counts ALL activity: unlogged gym, runs, brisk walks); fall back to logged rides.
  const gIM = db.garmin && db.garmin.filter(r => r.d >= since && (r.imMod != null || r.imVig != null));
  const fromG = gIM && gIM.length >= 14;
  const min = fromG ? gIM.reduce((s, r) => s + (r.imMod || 0) + 2 * (r.imVig || 0), 0) / gIM.length * 7
    : rides.filter(a => a.date.slice(0, 10) >= since).reduce((s, a) => s + (a.time || 0), 0) / 60 / 4;
  h += bench("Cardio min / week", Math.min(min, 449), `${r0(min)} min`, 0, 450, [[75, "Low"], [150, "Some"], [300, "WHO target", 1], [999, "Extra"]],
    `WHO: 150–300 min a week${fromG ? " (watch intensity minutes, logged or not)" : " (recorded rides only)"}. Cycle-commuters had <b>41% lower</b> all-cause mortality.`, ["who", "celis"]);
  return h + `<p class="muted note">From observational studies; not medical advice.</p></div>`;
}

// Statistics on your own data: 90-day trends with 95% CIs, correlations, commute vs other days.
function statsCard() {
  const W = db.wellness.slice(-90), t0 = W.length ? parseDay(W[0].d).getTime() : 0, x = w => (parseDay(w.d).getTime() - t0) / 864e5;
  const trend = (lab, f, unit, dec, downGood) => {
    const L = linreg(W.filter(w => f(w) != null && f(w) > 0).map(w => [x(w), f(w)]));
    if (!L) return `<tr><td>${lab}</td><td colspan="2" class="muted">not enough data</td></tr>`;
    const m = L.b * 30, ci = L.ci * 30, sig = Math.abs(m) > ci, good = (m < 0) === downGood;
    return `<tr><td>${lab}</td><td>${m >= 0 ? "+" : "−"}${Math.abs(m).toFixed(dec)} ${unit}/mo <span class="muted">±${ci.toFixed(dec)}</span></td>
      <td class="${sig ? (good ? "up-good" : "up-bad") : "muted"}">${sig ? (good ? "▲ improving" : "▼ worsening") : "no clear change"}</td></tr>`;
  };
  // Commute vs non-commute days (weekday-matched by the user's own commute setting)
  const isC = w => commute.days.includes(parseDay(w.d).getDay());
  const cmp = (f, fmt) => { const a = W.filter(isC).map(f).filter(v => v > 0), b = W.filter(w => !isC(w)).map(f).filter(v => v > 0);
    return a.length >= 4 && b.length >= 4 ? [fmt(mean(a)), fmt(mean(b))] : ["–", "–"]; };
  const cS = cmp(w => w.steps, v => r0(v).toLocaleString()), cR = cmp(w => w.rhr, v => v.toFixed(1)), cL = cmp(w => w.sleep, v => hm(v));
  return `<div class="card"><h2>Trends · 90 days</h2>
    <table><tr><th>Trend</th><th>Change</th><th></th></tr>
      ${trend("Resting HR", w => w.rhr, "bpm", 1, true)}${trend("VO2max", w => w.vo2, "", 2, false)}
      ${trend("Steps", w => w.steps, "", 0, false)}${trend("Sleep", w => w.sleep && w.sleep / 60, "min", 0, false)}</table>
    <p class="muted note">± = 95% confidence. "No clear change" = could be zero.</p>
    <table><tr><th></th><th>Commute days</th><th>Other days</th></tr>
      <tr><td>Steps</td><td>${cS[0]}</td><td>${cS[1]}</td></tr><tr><td>Resting HR</td><td>${cR[0]}</td><td>${cR[1]}</td></tr>
      <tr><td>Sleep</td><td>${cL[0]}</td><td>${cL[1]}</td></tr></table>
</div>`;
}
function fillGh() { $("#ghtok").value = ghTok; }
function fillProfile() { $("#pAge").value = profile.age || ""; $("#pSex").value = profile.sex || ""; }
function saveProfile() { profile = { age: +$("#pAge").value || null, sex: $("#pSex").value }; LS.set("gh.profile", profile); }

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
  // Without Garmin bed times the timing chart is empty, so fall back to a plain duration bar chart.
  const timing = sleepTimingCard();
  v.innerHTML = (timing || `<div class="card"><h2>Sleep, last 30 nights</h2><p class="muted" style="margin:0 0 6px">Average ${have.length ? hm(mean(have) * 3600) : "–"} · under 6h on ${have.filter(x => x < 6).length} nights</p><div id="slC"></div></div>`)
    + stagesCard() + (shortS.length >= 3 && longS.length >= 3 ? `<div class="card"><h2>Sleep vs your rides</h2>${cmp}</div>` : "");
  if (!timing) barChart($("#slC"), { x: W.map(w => w.d), values: S, color: css("--s1"), label: "Sleep", fmt: v => v.toFixed(0) + "h", tipFmt: v => hm(v * 3600) });
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
  const R3 = rng(99);
  for (let k = 0; k < 40; k++) { const d = iso(new Date(Date.now() - (k * 4 + 1) * 864e5)), t = ["Run", "WeightTraining", "Walk", "RockClimbing"][k % 4];
    const time = { Run: 1800 + R3() * 1500, WeightTraining: 2700 + R3() * 1200, Walk: 2400 + R3() * 1800, RockClimbing: 4200 + R3() * 1800 }[t];
    A.push({ id: "d" + t + k, date: d + "T18:10:00", type: t, name: { Run: "Evening run", WeightTraining: "Gym", Walk: "Walk", RockClimbing: "Top rope session" }[t], time,
      dist: t === "Run" ? time * (2.7 + R3() * .4) : t === "Walk" ? time * 1.4 : 0, spd: t === "Run" ? 2.8 + R3() * .4 : t === "Walk" ? 1.4 : 0, climb: t === "Run" ? 40 : 0,
      hr: { Run: 152, WeightTraining: 112, Walk: 98, RockClimbing: 121 }[t] + R3() * 8, maxHr: 175, kcal: time / 60 * (t === "Run" ? 11 : 6), src: "garmin", zones: [] }); }
  A.sort((x, y) => x.date.localeCompare(y.date));
  const garmin = W.map((w, k) => { const R2 = rng(k + 7), bed = Date.parse(w.d + "T00:00:00Z") - (60 + R2() * 90) * 6e4 + Math.max(0, 7 * 3600 - w.sleep) * 600;   // short nights = later bedtimes
    return { d: w.d, bbWake: Math.round(Math.max(15, Math.min(100, 30 + (w.sleep / 3600 - 5) * 14 + (R2() - .5) * 20))), bbHigh: 100, bbLow: Math.round(5 + R2() * 25), stress: Math.round(18 + R2() * 25),
      imMod: Math.round(R2() * 40), imVig: Math.round(R2() * 15), deep: 3600 + R2() * 2400, light: 12000 + R2() * 4000, rem: 4200 + R2() * 2400, awake: 600 + R2() * 1200,
      bed, wake: bed + w.sleep * 1000, sleepStress: Math.round(12 + R2() * 14) }; });
  const out = { wellness: W, acts: A.reverse(), garmin, at: Date.now(), demo: true }; deriveLoad(out); return out;
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
// Short haptic tick (Pixel/Android Chrome support vibrate; iPhone silently ignores it).
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch { } };
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#title").innerHTML = `<small>${esc(T("brand"))}</small>` + esc(T(tab));
  // Nav labels follow the skin's vocabulary: rewrite only the button's trailing text node (the icon stays).
  document.querySelectorAll("#tabs button").forEach(b => { const n = [...b.childNodes].reverse().find(x => x.nodeType === 3 && x.textContent.trim()); if (n) n.textContent = T(b.dataset.tab); });
  const v = $("#view");
  if (!db) { v.innerHTML = `<div class="card"><h2>Welcome</h2><p>Connect Intervals.icu in Settings (⚙) to see your Garmin data, or try the demo first.</p><button class="primary" id="goSet">Open settings</button> <button id="goDemo">Try demo data</button></div>`; return; }
  if (db.demo) status("Demo data. Add your Intervals.icu key in Settings for your own.");
  ({ today: renderToday, rides: renderRides, fitness: renderFitness, sleep: renderSleep })[tab](v);
  animateIn(v);
}
// Shared motion for every skin: numbers count up, the readiness ring fills. Skipped with reduced motion.
function animateIn(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll(".tile b, .ring .num > div").forEach(el => {
    const node = el.firstChild; if (!node || node.nodeType !== 3) return;
    const txt = node.textContent.trim(); if (!/^[\d,.]+$/.test(txt)) return;     // only plain numbers, not "6h 14m"
    const target = parseFloat(txt.replace(/,/g, "")), dec = (txt.split(".")[1] || "").length, comma = txt.includes(",");
    const t0 = performance.now(), dur = 700;
    const step = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - (1 - p) ** 3, v = target * e;
      node.textContent = comma ? Math.round(v).toLocaleString() : v.toFixed(dec); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  root.querySelectorAll(".ring circle + circle").forEach(c => {
    const full = c.getAttribute("stroke-dasharray"); const C = full.split(" ")[1];
    // via style, not the attribute: CSS transitions reliably fire on style changes only
    c.style.strokeDasharray = `0 ${C}`; c.style.transition = "stroke-dasharray 1.1s cubic-bezier(.2,.8,.2,1)";
    requestAnimationFrame(() => requestAnimationFrame(() => c.style.strokeDasharray = full));
  });
  // Terminal: ASCII bar fills cell by cell, then the verdict types itself out.
  root.querySelectorAll(".ascii[data-fill]").forEach(pre => {
    const n = pre.firstChild, end = +pre.dataset.fill, tail = n.textContent.slice(22);   // 22 = "[" + 20 cells + "]"
    let s = 0; const id = setInterval(() => { s = Math.min(end, s + 5); n.textContent = asciiBar(s) + tail; if (s >= end) clearInterval(id); }, 45);
  });
  if (skin === "term") root.querySelectorAll(".type").forEach((el, k) => {
    const full = el.textContent; el.textContent = ""; let i = 0;
    setTimeout(() => { const id = setInterval(() => { el.textContent = full.slice(0, ++i); if (i >= full.length) clearInterval(id); }, 22); }, 400 + k * 500);
  });
  // Player One: HP / XP bars slide from empty.
  root.querySelectorAll(".bar8 i[data-w]").forEach(i => {
    i.style.transition = "none"; i.style.width = "0%";
    requestAnimationFrame(() => requestAnimationFrame(() => { i.style.transition = "width 1.2s steps(16)"; i.style.width = i.dataset.w + "%"; }));
  });
}
// Terminal boot screen: once per app launch, fakes a short BIOS/link sequence over the real data counts.
function bootScreen() {
  if (skin !== "term" || sessionStorage.getItem("gh.boot") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  sessionStorage.setItem("gh.boot", "1");
  const L = ["GARMIN-HUB BIOS v2.0  (c) you", "MEM CHECK ........ <span class=ok>OK</span>", "LINK intervals.icu  <span class=ok>OK</span>",
    db ? `LOAD ${db.wellness.length} days / ${db.acts.length} activities` : "LOAD no data yet", "READY_"];
  const d = document.createElement("div"); d.id = "boot";
  d.innerHTML = L.map((l, k) => `<div style="animation-delay:${(k * .32).toFixed(2)}s">${l}</div>`).join("");
  document.body.append(d); setTimeout(() => d.remove(), 2400);
}
function openSettings() {
  $("#key").value = cfg.key; $("#ath").value = cfg.athlete;
  $("#dataInfo").textContent = db ? `${db.demo ? "Demo data" : "Synced"}: ${db.wellness.length} days, ${db.acts.length} activities. Last sync ${new Date(db.at).toLocaleString()}.` : "Nothing stored.";
  fillCommuteSettings(); fillProfile(); fillGh();
  $("#settings").classList.add("open");
}
function useDemo() { db = demoData(); LS.set("gh.db", db); $("#settings").classList.remove("open"); render(); }
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab) { buzz(8); tab = t.dataset.tab; LS.set("gh.tab", tab); window.scrollTo(0, 0); render(); }
  else if (t.dataset.ride) openRide(t.dataset.ride);
  else if (t.dataset.wk) { wkFilter = t.dataset.wk; buzz(6); render(); }
  else if (t.dataset.range) { fitRange = +t.dataset.range; render(); }
  else if (t.id === "syncBtn") db && db.demo && !cfg.key ? status("Demo mode: add your key in Settings to sync.") : sync();
  else if (t.id === "setBtn" || t.id === "goSet") openSettings();
  else if (t.id === "setClose") $("#settings").classList.remove("open");
  else if (t.id === "rideClose") { $("#rideSheet").classList.remove("open"); $("#rideBody").innerHTML = ""; }
  else if (t.id === "demoBtn" || t.id === "goDemo") useDemo();
  else if (t.dataset.cday) { t.classList.toggle("on"); saveCommute(); render(); }
  else if (t.dataset.skin) { skin = setSkin(t.dataset.skin); LS.set("gh.skin", skin); render(); }   // re-render: chart colours are read from CSS
  else if (t.id === "ghSave") { ghTok = $("#ghtok").value.trim(); LS.set("gh.ghtok", ghTok); $("#settings").classList.remove("open"); if (db && !db.demo) sync(); }
  else if (t.id === "saveBtn") {
    cfg = { key: $("#key").value.trim(), athlete: $("#ath").value.trim() || "0" }; LS.set("gh.cfg", cfg);
    $("#settings").classList.remove("open"); if (db && db.demo) db = null; sync();
  } else if (t.id === "clearBtn") { LS.del("gh.db"); db = null; openSettings(); render(); }
});
document.addEventListener("change", e => { if (e.target.id === "cAm" || e.target.id === "cPm") { saveCommute(); render(); } });
document.addEventListener("change", e => { if (e.target.id === "pAge" || e.target.id === "pSex") { saveProfile(); render(); } });
// Tooltip for [data-tip] marks: follows the pointer on desktop; on touch, tap a mark to show it (tap elsewhere hides).
function showTip(e) {
  const el = e.target.closest && e.target.closest("[data-tip]"), tp = $("#vtip"); if (!tp) return;
  if (!el) { tp.style.display = "none"; return; }
  tp.textContent = el.dataset.tip; tp.style.display = "block";
  const x = Math.min(innerWidth - tp.offsetWidth - 8, Math.max(8, e.clientX - tp.offsetWidth / 2)), y = e.clientY - tp.offsetHeight - 14;
  tp.style.left = x + "px"; tp.style.top = (y < 8 ? e.clientY + 18 : y) + "px";
}
addEventListener("pointermove", showTip, { passive: true }); addEventListener("pointerdown", showTip, { passive: true });
addEventListener("scroll", () => { const tp = $("#vtip"); if (tp) tp.style.display = "none"; }, { passive: true });
// Charts are sized from their container width, so redraw on rotation/resize (debounced).
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 200); });
// ?demo loads demo data and #rides/#fitness/#sleep picks a tab: handy links for testing and showing the app.
if (/[?&]demo\b/.test(location.search) && (!db || db.demo)) db = demoData();
if (/^#(today|rides|fitness|sleep)$/.test(location.hash)) tab = location.hash.slice(1);
render(); bootScreen();
if (location.hash === "#ride" && db) { const r = db.acts.find(isRide); if (r) openRide(r.id); }
// Auto-sync: every time the app opens, and when it comes back to the foreground (Android keeps PWAs alive
// in the background, so "open" is often a resume). 2-minute floor so app-switching doesn't hammer the API.
let syncing = false;
const autoSync = () => { if (cfg.key && !(db && db.demo) && !syncing && (!db || Date.now() - db.at > 2 * 60e3)) { syncing = true; sync().finally(() => syncing = false); } };
autoSync();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") autoSync(); });
// Pull down from the top to force a sync (installed PWAs have no browser pull-to-refresh).
let pullY = null;
addEventListener("touchstart", e => { pullY = scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
addEventListener("touchend", e => {
  if (pullY != null && e.changedTouches[0].clientY - pullY > 90 && cfg.key && !(db && db.demo) && !syncing) { buzz(15); syncing = true; sync().finally(() => syncing = false); }
  pullY = null;
}, { passive: true });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
