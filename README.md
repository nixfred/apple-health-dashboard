# Apple Health Dashboard

> A self-hosted, single-file Bun + SQLite dashboard for everything your Apple Watch and iPhone collect — sleep stages, heart rate, workouts with GPS routes, recovery scoring, illness prediction, and 13 charts that look better than the iPhone Health app.

![Hero](docs/screenshots/briefing.png)

**Your data stays on your hardware.** Nothing leaves your network. No cloud, no SaaS, no analytics. The entire stack is your iPhone, your Apple Watch, the [Health Auto Export](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069) app, and one Docker container.

---

## What you get

- **Live dashboard** that auto-refreshes every 60 seconds
- **Briefing tab** — recovery score, last night's sleep, latest workout (with inline GPS map), training load, illness prediction, sleep prediction, anomaly alerts, today-so-far, body patterns
- **30-day sleep trend** chart with stage stack, day-of-week pattern, and typical bedtime/wake clock
- **Sleep tab** with seven big visualizations:
  - 12-month heatmap (GitHub-contributions style)
  - Sleep schedule Gantt (last 21 nights on a 24h x-axis)
  - Stage composition rolling 7-day stacked area (deep/REM/core/awake)
  - Quality vs duration scatter with Pearson r and best-fit line
  - Wrist temperature anomaly band (14-day rolling mean ±2σ)
  - HR-during-sleep curve with stage shading (any night, dropdown)
  - Workout strain × next-night sleep correlation
- **Workouts tab** — lifetime stats, personal records, per-workout trend charts, weekly breakdown, full log with GPS routes
- **Calendar** — month view with daily steps/sleep/workout counts; click any day for full detail
- **Trends** — 30-day charts across activity, HR, body, sleep
- **Monthly Report** — stat-packed monthly summary card

## Architecture (it's simpler than you think)

```
   Apple Watch                   iPhone                       Your home server
   ┌─────────┐                  ┌──────────┐                ┌────────────────────┐
   │  HRV /  │   ─── BLE ─→     │  Apple   │                │  Bun + SQLite     │
   │  Sleep  │                  │  Health  │ ─── HTTP POST → │  /health endpoint  │
   │  Steps  │                  │  + HAE   │  every 5min /  │  → SQLite DB      │
   │  GPS    │                  │  app     │  every 1hr     │  → /api/* (JSON)  │
   └─────────┘                  └──────────┘                │  → / (dashboard)  │
                                                            └────────────────────┘
                                                                      │
                                                                      └── browser
```

- **Health Auto Export** (HAE) is a $5 iOS app that ships Apple Health data over HTTP on a schedule
- This server has one POST endpoint `/health` that ingests HAE's JSON
- Everything else is a `GET /api/*` endpoint backed by SQLite, plus a single-file HTML dashboard at `/`
- One Docker container. ~140 MB image. <50 MB RAM at rest.

## Requirements

| Component | Why | Cost |
|-----------|-----|------|
| Apple Watch (any series with sleep tracking) | Source of HRV, sleep stages, wrist temp, etc. | — |
| iPhone running iOS 16+ | Hosts Apple Health + HAE | — |
| **[Health Auto Export](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069)** iOS app | Pushes JSON to your server | $4.99 (one-time, no subscription) |
| Any always-on machine that can run Docker | Receives + serves data | Raspberry Pi 4 is sufficient |
| Docker + docker compose | Container runtime | free |

The server is reachable on your local network — your iPhone needs to be able to POST to it. If both are on the same Wi-Fi, you're done. For external access add a reverse proxy (Traefik, Caddy, nginx).

## Quickstart

```bash
git clone https://github.com/<your-username>/apple-health-dashboard.git
cd apple-health-dashboard
cp docker-compose.example.yml docker-compose.yml   # edit if you need to change ports
cp .env.example .env # edit and add carto.com map api key or leave blank
docker compose up -d --build

# verify
curl http://localhost:8880/health
# → {"status":"ok","uptime":...}
```

Then in **Health Auto Export** on your iPhone:

1. Add an automation → REST API
2. URL: `http://<your-server-lan-ip>:8880/health`
3. Data type: All Health Metrics + Workouts (in two automations works best)
4. Schedule: every 5 min for workouts, every 1 hr for metrics
5. Format: JSON v2

Within an hour you'll have data in the dashboard. Visit `http://<your-server-lan-ip>:8880`.

For deeper setup (HTTPS, reverse proxy, multiple users), see **[INSTALL.md](INSTALL.md)** — written so a Claude / GPT / Gemini can drive the deployment for you end-to-end.

## Screenshots

### Briefing — your morning command center
![Briefing](docs/screenshots/briefing.png)

### Sleep tab — eight charts deep
![Sleep](docs/screenshots/sleep.png)

### Workouts — with inline GPS routes
![Workouts](docs/screenshots/workouts.png)

### Workout route map — click any 🗺️ Map link
![Workout map](docs/screenshots/workout-map.png)

### Calendar — click any day for full detail
![Calendar](docs/screenshots/calendar.png)

### Trends — everything, 30 days
![Trends](docs/screenshots/trends.png)

### Mobile (iPhone Brave)
![Mobile briefing](docs/screenshots/briefing-mobile.png)

## API endpoints (all GET, all return JSON)

| Endpoint | Description |
|----------|-------------|
| `POST /health` | Ingest from HAE (iOS only — don't call by hand) |
| `GET  /health` | Health check + uptime |
| `GET  /api/dashboard` | Today's headline data |
| `GET  /api/briefing` | Full morning briefing (recovery, sleep, training, illness, prediction, anomalies) |
| `GET  /api/recovery` | Today's recovery score (0–100, 4 components) |
| `GET  /api/recovery-history?days=14` | Last N days of recovery scores |
| `GET  /api/anomalies` | Z-score anomaly detection across key metrics |
| `GET  /api/illness` | 3-signal illness early warning |
| `GET  /api/sleep-prediction` | Tonight's predicted sleep duration & quality |
| `GET  /api/correlations` | Pearson correlations between metric pairs |
| `GET  /api/insights` | Combined trends + correlations + anomalies for the briefing |
| `GET  /api/sleep` | Last 6 nights (aggregated per night, includes naps) |
| `GET  /api/sleep-analytics` | Every night ever recorded with full stats |
| `GET  /api/sleep-hr?date=YYYY-MM-DD` | HR samples within that night's sleep window |
| `GET  /api/day?date=YYYY-MM-DD` | Full detail for a specific date |
| `GET  /api/history?days=30` | Daily summaries for last N days |
| `GET  /api/workouts` | All workouts |
| `GET  /api/workout-analytics` | Lifetime stats, PRs, weekly breakdown, per-workout trends |
| `GET  /api/route?id=...` | GPS route + HR timeline for one workout |
| `GET  /api/calendar?year=YYYY&month=M` | Monthly calendar with daily summaries |
| `GET  /api/monthly-report?year=YYYY&month=M` | Full monthly report card |
| `GET  /api/stats` | DB row counts and size |

Every endpoint validates inputs and returns a clean JSON error on bad input.

## Why this exists

The iPhone Health app is fine. It's also a feature-locked black box that won't let you see your trends across years, won't show you correlations, won't predict tonight's sleep from today's behavior, and certainly won't give you a 12-month heatmap of your sleep.

This dashboard is what Apple Health *could* be if it weren't designed by a committee at Cupertino. It's yours, it's fast, and you can hack on it.

## Tech notes

- **Single file backend**: `server.ts` (~1700 lines). One Bun process, one SQLite DB. No async I/O on hot paths because bun:sqlite is synchronous and the DB is tiny.
- **Single file frontend**: `public/index.html` (~1300 lines). No build step, no bundler, no framework. Inline CSS, inline JS, NixVitals cyberpunk theme.
- **Bind-mounted `public/`**: edit the HTML on the host, refresh the browser, no rebuild.
- **Migrations are idempotent** — every CREATE/ALTER is `IF NOT EXISTS`. Restarting the container with a new schema column just works.
- **HAE quirks handled**: nested InBed/Asleep entries, late-evening-nap misclassification, HAE's `date` field semantics, missing `inBed` field — all decoded and tested against an iPhone's "Time Asleep" overview to within ~2 minutes.
- **Sleep aggregation**: `aggregateSleepForDate(day)` is the single source of truth for per-day totals. Used by every endpoint.
- **No tests yet** — PRs welcome.

## Roadmap (open issues for any of these)

- [ ] Multi-user support (one dashboard, several family members' watches)
- [ ] Export to CSV / Parquet / Influx
- [ ] Apple Health import (one-shot bulk import for historical data before HAE was installed)
- [ ] Goals + streaks (replace Apple's three rings with whatever you actually care about)
- [ ] HRV trend chart (the data is there, the chart isn't)
- [ ] Integration with Cronometer / MyFitnessPal (food + sleep correlations)

## License

MIT. Use it, fork it, sell premium hosted versions of it. Just don't sue.

## Credits

Built with [Bun](https://bun.sh), [Leaflet](https://leafletjs.com), and a stubborn refusal to use a JS framework.

The Health Auto Export iOS app is a separate product by [HealthyApps](https://github.com/HealthyApps) — they made the bridge that makes this whole project possible.
