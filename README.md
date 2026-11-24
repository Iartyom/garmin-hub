# Garmin Hub

My own dashboard for Garmin Venu 2 data: the numbers Garmin Connect hides or never calculates.

> **Private data.** Health data never goes into git. `data/` and `.env` are ignored.
> If this repo is ever pushed, push it as a **private** GitHub repo, not GitHub Pages.

## How data gets here (decision)

| Route | Verdict | Why |
|---|---|---|
| Garmin Connect Developer Program (official API) | ❌ | Business-only approval; individuals are usually refused |
| Unofficial `garminconnect` / `garth` login scraping | ❌ (fallback only) | Breaks when Garmin changes things; logging in with your password from a script risks account lockouts |
| **Intervals.icu API** | ✅ **chosen** | Free, official personal API key. Intervals.icu auto-imports from Garmin (activities with full streams + wellness: sleep, resting HR, HRV, weight, steps) |
| Manual FIT export | ✅ backup | Garmin Connect → activity → Export Original. The parser can read FIT files dropped into `data/fit/` |

Flow: **Venu 2 → Garmin Connect app (phone) → Garmin cloud → Intervals.icu (auto) → this web app on the phone**.

It's an installable web app (PWA): no app store, works on iPhone and Android. The phone fetches straight from
the Intervals.icu API (CORS is allowed, checked Nov 24, 2026). The API key and synced data stay in the
phone's browser storage only, so the code can be hosted publicly with no personal data in it.

## Run / install

- Try it: `node serve.mjs` → http://localhost:5174/?demo (demo data, no key needed).
- Phone: host the files on HTTPS (GitHub Pages), open the page, then Share → **Add to Home Screen** (iPhone)
  or ⋮ → **Install app** (Android). Settings (⚙) → paste the Intervals.icu API key.
- Test links: `?demo#rides`, `?demo#fitness`, `?demo#sleep`, `?demo#ride` (opens the latest ride).

## v1 (built)

- **Today**: go hard / moderate / easy verdict from resting HR, HRV, sleep and form against your own 28-day baseline;
  "watch hasn't synced" warning (the phone sync also refreshes GPS satellite data); body tiles; last ride.
- **Rides**: weekly km (12 weeks) and ride list; ride detail with map, HR and speed charts, time in HR zones, HR drift.
- **Fitness**: fitness/fatigue, form, VO2max (42 days / 90 days / 1 year), ramp-rate warning, table view.
- **Sleep**: 30 nights, resting HR, HRV, and sleep vs ride efficiency (km/h per heartbeat).

The original phase plan below is kept for reference; the phone app replaced the local `sync.mjs` + dashboard idea.

## Plan

### Phase 1: plumbing (first session)
1. Create an Intervals.icu account and link Garmin (Settings → Connections → Garmin).
2. Copy the API key (Settings → Developer Settings) into `.env` as `INTERVALS_KEY=` and `INTERVALS_ATHLETE=i12345`.
3. `sync.mjs`: pull activities, streams and wellness for the last 365 days into `data/`; incremental after that.
4. `serve.mjs`: tiny local server; open `http://localhost:5174`.

### Phase 2: dashboard v1
Single static page, no build step, same approach as the WoW site.
Cards: Today, Rides, Fitness trend, Sleep & recovery.

### Phase 3: watch side (optional)
Connect IQ data field for the Venu 2 (Monkey C, needs the Garmin SDK download).

### Phase 4: automation
Windows scheduled task runs `sync.mjs` every morning, like the GrimoireSync watcher.

## Feature ideas (pick what to build first)

### Bike
- **Ride card**: distance, moving time, avg/max speed, climbing, HR zones, with a map from the GPS stream.
- **Aerobic decoupling**: how much HR drifts against speed in the second half. Below 5% = good endurance.
- **Personal bests by distance/climb**: fastest 10/20/40 km, best climb time on repeated routes.
- **Same-route comparison**: detect repeated routes and chart your time on each over months.
- **Weekly volume vs. target**: km and hours against a goal you set.

### Fitness & load (what the Venu 2 lacks)
- **Fitness / fatigue / form** (CTL/ATL/TSB) from heart-rate training load.
- **Ramp-rate warning**: load rising more than ~5–8/week, which is the classic overtraining path.
- **Resting HR + HRV trend** with a "go hard / go easy today" verdict.
- **VO2max history**: a long-term chart, not just today's number.

### Recovery & life
- **Sleep vs. next-day ride**: does a bad night actually cost you speed/HR? Uses your own data.
- **Body Battery / stress pattern by weekday**: when you're actually fresh.
- **Steps & activity streaks**.

### Practical
- **"GPS data is stale" reminder**: last phone sync older than 3 days, so sync before you ride.
- **Gear tracking**: km on the bike chain/tyres, with a reminder to replace them.
- **Weather overlay**: wind/heat for each ride, which explains slow days.

## Layout

```
garmin-hub/
  README.md      this plan
  .env           API key (ignored)
  sync.mjs       Intervals.icu → data/*.json   (phase 1)
  serve.mjs      local server                  (phase 1)
  index.html     dashboard                     (phase 2)
  data/          synced JSON + FIT files (ignored)
  watch/         Connect IQ data field         (phase 3)
```
