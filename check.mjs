// Field check: which Intervals.icu fields actually have data for this account, so the app maps the right names.
// Prints field names + how many records have a value. Never prints values or the key. Run: node check.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)
  .map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
if (!env.INTERVALS_KEY) { console.log("INTERVALS_KEY is empty in .env"); process.exit(1); }
const ath = encodeURIComponent(env.INTERVALS_ATHLETE || "0");
const iso = d => d.toISOString().slice(0, 10), now = new Date(), ago = n => iso(new Date(now - n * 864e5));
const get = async p => {
  const r = await fetch("https://intervals.icu/api/v1" + p, { headers: { Authorization: "Basic " + Buffer.from("API_KEY:" + env.INTERVALS_KEY).toString("base64") } });
  if (!r.ok) throw new Error(p.split("?")[0] + " → HTTP " + r.status);
  return r.json();
};
// Count non-empty values per field across records (0, "", [] and null count as empty).
const coverage = rows => {
  const c = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (v != null && v !== "" && v !== 0 && !(Array.isArray(v) && !v.length)) c[k] = (c[k] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  ");
};
const w = await get(`/athlete/${ath}/wellness?oldest=${ago(365)}&newest=${iso(now)}`);
const withData = w.filter(x => x.restingHR || x.hrv || x.sleepSecs || x.steps);
console.log(`WELLNESS: ${w.length} days returned, ${withData.length} with body data; first ${withData[0]?.id ?? "-"}, last ${withData.at(-1)?.id ?? "-"}`);
console.log(coverage(w), "\n");
const a = await get(`/athlete/${ath}/activities?oldest=${ago(365)}&newest=${iso(now)}`);
const types = {}; a.forEach(x => types[x.type] = (types[x.type] || 0) + 1);
console.log(`ACTIVITIES: ${a.length} in the last year. Types: ${JSON.stringify(types)}`);
console.log(`Sources: ${JSON.stringify(a.reduce((s, x) => (s[x.source || "?"] = (s[x.source || "?"] || 0) + 1, s), {}))}`);
console.log(coverage(a), "\n");
const ride = a.find(x => /Ride/i.test(x.type));
if (ride) {
  const st = await get(`/activity/${encodeURIComponent(ride.id)}/streams?types=time,latlng,heartrate,velocity_smooth,altitude`);
  console.log("LATEST RIDE STREAMS:", (st || []).map(s => `${s.type}(${s.data?.length ?? 0}${s.data2 ? ", has data2" : ""}${Array.isArray(s.data?.[0]) ? ", pairs" : ""})`).join("  "));
}
