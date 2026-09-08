#!/usr/bin/env bun
/**
 * Apple Health dashboard server — receives data from Health Auto Export (iOS) and serves a self-contained web dashboard
 * Receives JSON from Health Auto Export (iOS), stores to SQLite + JSONL backup.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";

const PORT = 8880;
const DATA_DIR = join(import.meta.dir, "data");
const PUBLIC_DIR = join(import.meta.dir, "public");
const RAW_LOG = join(DATA_DIR, "raw-payloads.jsonl");
const DB_PATH = join(DATA_DIR, "health.db");
const MAX_POST_BYTES = 25 * 1024 * 1024; // 25 MB — largest real HAE push ~1.5 MB

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────
const round = (v: number, d = 2) => { const p = 10 ** d; return Math.round(v * p) / p; };
const isValidDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isValidYearMonth = (y: number, m: number) => Number.isInteger(y) && y >= 2020 && y <= 2100 && Number.isInteger(m) && m >= 1 && m <= 12;

// Add days to a YYYY-MM-DD string (positive or negative)
function dayShift(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// ─── SQLite Setup ─────────────────────────────────────────

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=DELETE");      // WAL causes Bun 1.x to busy-loop on pread64
db.run("PRAGMA synchronous=NORMAL");
db.run("PRAGMA busy_timeout=5000");
db.run("PRAGMA cache_size=-8000");

db.run(`CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  qty REAL,
  units TEXT,
  source TEXT,
  UNIQUE(name, date)
)`);

db.run(`CREATE TABLE IF NOT EXISTS hr_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  avg REAL, min REAL, max REAL,
  source TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  name TEXT, start TEXT, end TEXT,
  duration REAL, distance_km REAL,
  calories REAL, avg_hr REAL, max_hr REAL,
  steps INTEGER, elevation_m REAL,
  temperature_c REAL, humidity REAL,
  speed_kmh REAL, cadence REAL, intensity REAL,
  is_indoor INTEGER DEFAULT 0,
  hr_data TEXT
)`);
// route_data column added after initial schema — ignore "duplicate column" on upgrade
try { db.run("ALTER TABLE workouts ADD COLUMN route_data TEXT"); } catch {}

db.run(`CREATE TABLE IF NOT EXISTS sleep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  total_sleep REAL, deep REAL, rem REAL, core REAL, awake REAL,
  sleep_start TEXT NOT NULL UNIQUE,
  sleep_end TEXT,
  source TEXT
)`);

db.run("CREATE INDEX IF NOT EXISTS idx_metrics_name_date ON metrics(name, date)");
db.run("CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(date)");
db.run("CREATE INDEX IF NOT EXISTS idx_hr_date ON hr_readings(date)");
db.run("CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start)");
db.run("CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep(date)");

// Prepared statements for fast inserts
const insertMetric = db.prepare("INSERT OR REPLACE INTO metrics (name, date, qty, units, source) VALUES (?, ?, ?, ?, ?)");
const insertHR = db.prepare("INSERT OR REPLACE INTO hr_readings (date, avg, min, max, source) VALUES (?, ?, ?, ?, ?)");
const insertWorkout = db.prepare("INSERT OR REPLACE INTO workouts (id, name, start, end, duration, distance_km, calories, avg_hr, max_hr, steps, elevation_m, temperature_c, humidity, speed_kmh, cadence, intensity, is_indoor, hr_data, route_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertSleep = db.prepare("INSERT OR REPLACE INTO sleep (date, total_sleep, deep, rem, core, awake, sleep_start, sleep_end, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

// Track last time iPhone app actually synced data (from SQLite, not 92MB JSONL)
let lastSyncTime: string = (() => {
  try {
    const r = db.query("SELECT date FROM metrics ORDER BY rowid DESC LIMIT 1").get() as any;
    return r?.date || "";
  } catch { return ""; }
})();

// ─── Data Ingestion ───────────────────────────────────────

function extractQty(val: any): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && "qty" in val) return val.qty;
  if (Array.isArray(val)) return val.reduce((s: number, e: any) => s + (e.qty || 0), 0);
  return 0;
}

function ingestPayload(payload: any) {
  const data = payload?.data;
  if (!data) return;

  const ingestTx = db.transaction(() => {
    // Metrics
    if (data.metrics) {
      for (const m of data.metrics) {
        if (m.name === "heart_rate") {
          for (const entry of m.data || []) {
            const bpm = entry.Avg || entry.qty || entry.Max || 0;
            if (bpm > 0) insertHR.run(entry.date, entry.Avg || bpm, entry.Min || bpm, entry.Max || bpm, entry.source || "");
          }
        } else if (m.name === "sleep_analysis") {
          for (const entry of m.data || []) {
            insertSleep.run(
              entry.date, entry.totalSleep || entry.qty || 0,
              entry.deep || 0, entry.rem || 0, entry.core || 0, entry.awake || 0,
              entry.sleepStart || "", entry.sleepEnd || "",
              entry.source || ""
            );
          }
        } else {
          for (const entry of m.data || []) {
            if (entry.qty !== undefined) {
              insertMetric.run(m.name, entry.date, entry.qty, m.units || "", entry.source || "");
            }
          }
        }
      }
    }

    // Workouts
    if (data.workouts) {
      for (const w of data.workouts) {
        const id = w.id || `${w.start}-${w.name}`;
        // Route data: compact lat/lon/alt/ts so playback works without re-scanning JSONL
        const routeJson = w.route && Array.isArray(w.route) && w.route.length > 0
          ? JSON.stringify(w.route.map((p: any) => ({
              lat: p.latitude ?? p.lat,
              lon: p.longitude ?? p.lon,
              alt: p.altitude ?? p.alt,
              ts: p.timestamp,
            })))
          : null;
        insertWorkout.run(
          id, w.name || "", w.start || "", w.end || "",
          w.duration || 0,
          extractQty(w.distance) || extractQty(w.walkingAndRunningDistance) || 0,
          extractQty(w.activeEnergyBurned) || 0,
          extractQty(w.avgHeartRate) || 0,
          extractQty(w.maxHeartRate) || 0,
          Math.round(extractQty(w.stepCount)),
          extractQty(w.elevationUp) || 0,
          extractQty(w.temperature) || 0,
          extractQty(w.humidity) || 0,
          extractQty(w.speed) || 0,
          extractQty(w.stepCadence) || 0,
          extractQty(w.intensity) || 0,
          w.isIndoor ? 1 : 0,
          JSON.stringify((w.heartRateData || []).map((e: any) => ({ d: e.date, b: Math.round(e.qty || 0) }))),
          routeJson
        );
      }
    }
  });

  ingestTx();
}

// ─── Migrate existing JSONL data into SQLite ──────────────

function migrateJsonlToDb() {
  if (!existsSync(RAW_LOG)) return;
  const count = db.query("SELECT COUNT(*) as c FROM metrics").get() as any;
  if (count.c > 0) return; // Already migrated

  console.log("📦 Migrating JSONL data to SQLite...");
  const lines = readFileSync(RAW_LOG, "utf-8").trim().split("\n").filter(l => l.length > 0);
  let migrated = 0;
  for (const line of lines) {
    try {
      const { payload } = JSON.parse(line);
      ingestPayload(payload);
      migrated++;
    } catch {}
  }
  console.log(`✅ Migrated ${migrated} payloads to SQLite`);
}

migrateJsonlToDb();

// ─── One-time: backfill workout route_data from JSONL for rows missing it ────
function backfillWorkoutRoutes() {
  if (!existsSync(RAW_LOG)) return;
  const missing = db.query("SELECT id FROM workouts WHERE route_data IS NULL AND is_indoor = 0").all() as any[];
  if (missing.length === 0) return;
  const wanted = new Set(missing.map((r: any) => r.id));
  console.log(`🗺️  Backfilling routes for ${wanted.size} workouts from JSONL...`);
  const updateRoute = db.prepare("UPDATE workouts SET route_data = ? WHERE id = ?");
  let filled = 0;
  try {
    const lines = readFileSync(RAW_LOG, "utf-8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      if (wanted.size === 0) break;
      try {
        const { payload } = JSON.parse(line);
        const workouts = payload?.data?.workouts;
        if (!workouts) continue;
        for (const w of workouts) {
          const id = w.id || `${w.start}-${w.name}`;
          if (!wanted.has(id) || !Array.isArray(w.route) || w.route.length === 0) continue;
          const routeJson = JSON.stringify(w.route.map((p: any) => ({
            lat: p.latitude ?? p.lat, lon: p.longitude ?? p.lon, alt: p.altitude ?? p.alt, ts: p.timestamp,
          })));
          updateRoute.run(routeJson, id);
          wanted.delete(id);
          filled++;
        }
      } catch {}
    }
  } catch (e: any) {
    console.error("Route backfill failed:", e?.message);
  }
  if (filled > 0) console.log(`✅ Backfilled ${filled} workout routes`);
}

backfillWorkoutRoutes();

// ─── Utilities ────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  const est = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}

function dateStrFmt(d: Date): string {
  const est = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}

// ─── Sleep Aggregation ────────────────────────────────────
//
// HAE sends multiple sleep_analysis entries per night that represent the
// same Apple Health sleep session at different aggregation levels (outer
// "InBed" interval + inner "Asleep stage" intervals). It also files
// pre-bedtime evening sleep under the *next* day's HAE date. Picking the
// longest single row per date drops naps and pre-bedtime sleep, so the
// dashboard would show e.g. 4h when iPhone shows 10h for a day with
// multiple sleep events.
//
// Rule (matches iPhone "Health → Sleep overview" totals to within ~1 min):
//   For calendar day X, include all sleep rows where:
//     (a) HAE's date field == X, OR
//     (b) HAE's date field == X+1 AND sleep_end is on day X
//         AND sleep_end's wall-clock time is before 22:00
//         (catches HAE's late-evening-nap-misfile bug where Apple Health
//          later reclassifies the entry from X+1 to X)
//   Then drop nested intervals (one row's window strictly contained in
//   another's larger-duration row), and SUM total_sleep + stages.
//
// This is a query-side rewrite — no schema changes, no data mutation.

interface AggregatedSleep {
  date: string;
  duration: number;     // total time asleep in hours (sum across sessions, excluding awake)
  deep: number;
  rem: number;
  core: number;
  awake: number;
  sleepStart: string;   // earliest sleep_start across kept rows
  sleepEnd: string;     // latest sleep_end across kept rows
  sessions: number;     // count of distinct (non-nested) sleep sessions on this day
  source: string;
}

// A row's "canonical day" — the single day it belongs to in iPhone's view.
// Default = HAE's `date` field. Exception = HAE filed it under day X+1 but
// sleep_end is on day X before 22:00 (HAE's late-nap-misfile bug).
function canonicalSleepDay(row: any): string {
  const haeDay = (row.date || "").slice(0, 10);
  const endDay = (row.sleep_end || "").slice(0, 10);
  const endTime = (row.sleep_end || "").slice(11, 16);
  if (endDay && endTime && endDay !== haeDay && endTime < "22:00" && dayShift(endDay, 1) === haeDay) {
    return endDay;
  }
  return haeDay;
}

function aggregateSleepForDate(day: string): AggregatedSleep | null {
  // Pull both candidate buckets (HAE-date == day, plus possible fold-back from day+1)
  const nextDay = dayShift(day, 1);
  const candidates = db.query(`
    SELECT * FROM sleep
    WHERE substr(date, 1, 10) = ?
       OR substr(date, 1, 10) = ?
    ORDER BY total_sleep DESC, sleep_start ASC
  `).all(day, nextDay) as any[];
  // Keep only rows whose canonical day matches the requested day
  const rows = candidates.filter(r => canonicalSleepDay(r) === day);
  if (rows.length === 0) return null;

  // Drop rows whose [sleep_start, sleep_end] window is strictly contained in
  // another row's window AND that other row has greater total_sleep.
  const kept: any[] = [];
  for (const r of rows) {
    const nested = rows.some(o =>
      o !== r &&
      o.total_sleep > r.total_sleep &&
      o.sleep_start && r.sleep_start && o.sleep_start <= r.sleep_start &&
      o.sleep_end && r.sleep_end && o.sleep_end >= r.sleep_end
    );
    if (!nested) kept.push(r);
  }

  const sum = (k: string) => kept.reduce((s, r) => s + (r[k] || 0), 0);
  const starts = kept.map(r => r.sleep_start).filter(Boolean).sort();
  const ends = kept.map(r => r.sleep_end).filter(Boolean).sort();

  return {
    date: day,
    duration: round(sum("total_sleep"), 2),
    deep: round(sum("deep"), 2),
    rem: round(sum("rem"), 2),
    core: round(sum("core"), 2),
    awake: round(sum("awake"), 2),
    sleepStart: starts[0] || "",
    sleepEnd: ends[ends.length - 1] || "",
    sessions: kept.length,
    source: kept[0]?.source || "",
  };
}

// Find the most recent calendar day (local) that has ANY sleep data.
// Used by /api/dashboard, /api/briefing, /api/recovery for "last sleep".
function getLatestSleepDay(): string | null {
  const r = db.query(`
    SELECT substr(sleep_end, 1, 10) as day FROM sleep
    WHERE sleep_end != ''
    ORDER BY sleep_end DESC LIMIT 1
  `).get() as any;
  return r?.day || null;
}

// ─── Query Builders (SQLite) ──────────────────────────────

function queryDaySummary(day: string) {
  const sumMetric = (name: string) => {
    const r = db.query("SELECT COALESCE(SUM(qty), 0) as total FROM metrics WHERE name = ? AND date LIKE ?").get(name, `${day}%`) as any;
    return Math.round(r.total * 100) / 100;
  };
  const latestMetric = (name: string) => {
    const r = db.query("SELECT qty FROM metrics WHERE name = ? AND date LIKE ? ORDER BY date DESC LIMIT 1").get(name, `${day}%`) as any;
    return r ? Math.round(r.qty * 100) / 100 : 0;
  };
  const standHours = () => {
    const r = db.query("SELECT COUNT(*) as c FROM metrics WHERE name = 'apple_stand_hour' AND date LIKE ?").get(`${day}%`) as any;
    return r.c;
  };

  // HR
  const hrRows = db.query("SELECT avg, min, max, date FROM hr_readings WHERE date LIKE ? ORDER BY date").all(`${day}%`) as any[];
  const hrAvgs = hrRows.map(r => r.avg).filter((v: number) => v > 0);
  const hrData = hrRows.map(r => {
    const d = new Date(r.date.replace(" ", "T").replace(/ ([+-]\d{4})$/, "$1"));
    return { time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, bpm: Math.round(r.avg) };
  }).filter(e => e.bpm > 0);

  // Sleep — sum all sessions on the day (matches iPhone "Time Asleep" total).
  // See aggregateSleepForDate above for the grouping rule.
  const sleepAgg = aggregateSleepForDate(day);

  // Workouts
  const workoutRows = db.query("SELECT * FROM workouts WHERE start LIKE ? ORDER BY start DESC").all(`${day}%`) as any[];
  const workouts = workoutRows.map(mapDbWorkout);

  return {
    date: day,
    activity: {
      steps: Math.round(sumMetric("step_count")),
      distance: Math.round(sumMetric("walking_running_distance") * 100) / 100,
      activeCalories: Math.round(sumMetric("active_energy")),
      exerciseMinutes: Math.round(sumMetric("apple_exercise_time")),
      standHours: standHours(),
      flightsClimbed: Math.round(sumMetric("flights_climbed")),
    },
    heartRate: {
      avg: hrAvgs.length > 0 ? Math.round(hrAvgs.reduce((a, b) => a + b, 0) / hrAvgs.length) : 0,
      resting: hrAvgs.length > 0 ? Math.round(Math.min(...hrAvgs)) : 0,
      max: hrAvgs.length > 0 ? Math.round(Math.max(...hrAvgs)) : 0,
      data: hrData,
    },
    sleep: {
      duration: sleepAgg?.duration || 0,
      deep: sleepAgg?.deep || 0,
      rem: sleepAgg?.rem || 0,
      core: sleepAgg?.core || 0,
      awake: sleepAgg?.awake || 0,
      sessions: sleepAgg?.sessions || 0,
    },
    workouts,
    extra: {
      respiratoryRate: latestMetric("respiratory_rate"),
      wristTemp: latestMetric("apple_sleeping_wrist_temperature"),
      walkingSpeed: latestMetric("walking_speed"),
      vo2Max: latestMetric("vo2_max"),
      stepLength: latestMetric("walking_step_length"),
      walkingAsymmetry: latestMetric("walking_asymmetry_percentage"),
      doubleSupport: latestMetric("walking_double_support_percentage"),
      cardioRecovery: latestMetric("cardio_recovery"),
      basalCalories: Math.round(sumMetric("basal_energy_burned")),
      totalCalories: Math.round(sumMetric("active_energy") + sumMetric("basal_energy_burned")),
      physicalEffort: Math.round(sumMetric("physical_effort") * 10) / 10,
      envAudio: (() => { const r = db.query("SELECT AVG(qty) as a FROM metrics WHERE name = 'environmental_audio_exposure' AND date LIKE ?").get(`${day}%`) as any; return r?.a ? Math.round(r.a) : 0; })(),
      totalWorkoutMin: workouts.reduce((s, w) => s + w.duration, 0),
      totalWorkoutCal: workouts.reduce((s, w) => s + w.calories, 0),
      totalWorkoutDist: Math.round(workouts.reduce((s, w) => s + w.distance, 0) * 100) / 100,
      totalElevation: workouts.reduce((s, w) => s + w.elevationGain, 0),
      avgWorkoutHR: workouts.length > 0 ? Math.round(workouts.reduce((s, w) => s + w.avgHR, 0) / workouts.length) : 0,
      avgPace: (() => { const p = workouts.filter(w => w.pace > 0); return p.length > 0 ? Math.round(p.reduce((s, w) => s + w.pace, 0) / p.length * 10) / 10 : 0; })(),
    },
  };
}

// Workout strain: 0-21 scale based on duration × HR intensity (Whoop-inspired)
function calcStrain(durationMin: number, avgHR: number, maxHR: number): number {
  const estMaxHR = 180; // Conservative estimate; adjusts as more data comes in
  const hrPct = avgHR / estMaxHR;
  // Strain = duration-weighted intensity on a log scale, capped at 21
  const rawStrain = durationMin * hrPct * hrPct * 0.15; // quadratic HR weighting
  return Math.round(Math.min(21, rawStrain) * 10) / 10;
}

// VO2 Max fitness age: maps VO2 to the age where it would be average
function vo2FitnessAge(vo2: number): number {
  // Population norms (male, from ACSM): VO2 max declines ~0.5 ml/kg/min per year
  // Average by age: 20→45, 30→40, 40→36, 50→32, 60→28, 70→24
  if (vo2 <= 0) return 0;
  const ageTable = [[20,45],[25,43],[30,40],[35,38],[40,36],[45,34],[50,32],[55,30],[60,28],[65,26],[70,24],[75,22],[80,20]];
  for (let i = 0; i < ageTable.length - 1; i++) {
    if (vo2 >= ageTable[i][1]) return ageTable[i][0];
    if (vo2 >= ageTable[i+1][1] && vo2 < ageTable[i][1]) {
      const frac = (vo2 - ageTable[i+1][1]) / (ageTable[i][1] - ageTable[i+1][1]);
      return Math.round(ageTable[i+1][0] - frac * (ageTable[i+1][0] - ageTable[i][0]));
    }
  }
  return 80;
}

function mapDbWorkout(w: any) {
  const distMi = Math.round(w.distance_km * 0.621371 * 100) / 100;
  const durationMin = Math.round(w.duration / 60);
  const strain = calcStrain(durationMin, w.avg_hr, w.max_hr);
  return {
    id: w.id || `${w.start}-${w.name}`,
    name: w.name, start: w.start, end: w.end,
    duration: durationMin,
    distance: distMi,
    calories: Math.round(w.calories),
    avgHR: Math.round(w.avg_hr),
    maxHR: Math.round(w.max_hr),
    steps: w.steps,
    elevationGain: Math.round(w.elevation_m * 3.28084),
    temperature: Math.round(w.temperature_c * 9 / 5 + 32),
    humidity: Math.round(w.humidity),
    speed: Math.round(w.speed_kmh * 0.621371 * 100) / 100,
    cadence: Math.round(w.cadence),
    intensity: Math.round(w.intensity * 100) / 100,
    pace: distMi > 0 ? Math.round(durationMin / distMi * 10) / 10 : 0,
    calPerMin: durationMin > 0 ? Math.round(w.calories / durationMin * 10) / 10 : 0,
    strain,
    isIndoor: w.is_indoor === 1,
  };
}

// ─── Metric Enrichment (baseline + trend for any value) ───

function enrichMetric(name: string, current: number, days = 30): { value: number; avg: number; delta: number; trend: string; arrow: string } {
  const base = getBaseline(name, days);
  const slope = base.values.length >= 5 ? linearSlope(base.values) : 0;
  const slopePerWeek = slope * 7;
  const delta = base.avg > 0 ? Math.round((current - base.avg) * 10) / 10 : 0;
  const trend = slopePerWeek > 0.01 ? "up" : slopePerWeek < -0.01 ? "down" : "flat";
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
  return { value: Math.round(current * 100) / 100, avg: base.avg, delta, trend, arrow };
}

// ─── API Builders ─────────────────────────────────────────

function buildDashboardData() {
  const today = todayStr();
  const summary = queryDaySummary(today);

  // Latest body metrics (global, not day-specific)
  const latestGlobal = (name: string) => {
    const r = db.query("SELECT qty FROM metrics WHERE name = ? ORDER BY date DESC LIMIT 1").get(name) as any;
    return r ? Math.round(r.qty * 100) / 100 : 0;
  };

  // Latest sleep — aggregated across all sessions on the most recent sleep day
  const latestDay = getLatestSleepDay();
  const lastSleepAgg = latestDay ? aggregateSleepForDate(latestDay) : null;

  return {
    today: summary.activity,
    heartRate: summary.heartRate,
    sleep: {
      ...(summary.sleep.duration > 0 ? summary.sleep : {
        duration: lastSleepAgg?.duration || 0,
        deep: lastSleepAgg?.deep || 0,
        rem: lastSleepAgg?.rem || 0,
        core: lastSleepAgg?.core || 0,
        awake: lastSleepAgg?.awake || 0,
        sessions: lastSleepAgg?.sessions || 0,
      }),
      wristTemp: Math.round(latestGlobal("apple_sleeping_wrist_temperature") * 10) / 10,
      respiratoryRate: Math.round(latestGlobal("respiratory_rate") * 10) / 10,
      breathingDisturbances: Math.round(latestGlobal("breathing_disturbances") * 10) / 10,
    },
    workouts: (db.query("SELECT * FROM workouts ORDER BY start DESC LIMIT 6").all() as any[]).map(mapDbWorkout),
    body: {
      vo2Max: enrichMetric("vo2_max", latestGlobal("vo2_max"), 90),
      walkingSpeed: enrichMetric("walking_speed", latestGlobal("walking_speed")),
      stepLength: enrichMetric("walking_step_length", latestGlobal("walking_step_length")),
      walkingAsymmetry: enrichMetric("walking_asymmetry_percentage", latestGlobal("walking_asymmetry_percentage")),
      cardioRecovery: enrichMetric("cardio_recovery", latestGlobal("cardio_recovery")),
    },
    lastUpdated: lastSyncTime || new Date().toISOString(),
  };
}

function buildHistoryData(days: number) {
  const result: any[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = dateStrFmt(d);
    const summary = queryDaySummary(day);
    if (summary.activity.steps > 0 || summary.heartRate.avg > 0 || summary.sleep.duration > 0 || summary.workouts.length > 0) {
      result.push(summary);
    }
  }
  return result;
}

function buildSleepHistory() {
  // Distinct calendar days in the sleep table, most recent 6
  const dayRows = db.query(`
    SELECT DISTINCT substr(date, 1, 10) as day FROM sleep
    ORDER BY day DESC LIMIT 6
  `).all() as any[];
  return dayRows.map(({ day }) => {
    const agg = aggregateSleepForDate(day);
    if (!agg) return null;
    const resp = db.query("SELECT qty FROM metrics WHERE name = 'respiratory_rate' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
    const temp = db.query("SELECT qty FROM metrics WHERE name = 'apple_sleeping_wrist_temperature' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
    const breath = db.query("SELECT qty FROM metrics WHERE name = 'breathing_disturbances' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
    return {
      date: day + " 00:00:00",
      duration: agg.duration, deep: agg.deep, rem: agg.rem, core: agg.core, awake: agg.awake,
      sleepStart: agg.sleepStart, sleepEnd: agg.sleepEnd, sessions: agg.sessions,
      respiratoryRate: resp ? round(resp.qty, 1) : 0,
      wristTemp: temp ? round(temp.qty, 1) : 0,
      breathingDisturbances: breath ? round(breath.qty, 1) : 0,
    };
  }).filter(Boolean);
}

function buildCalendarData(year: number, month: number) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const likePrefix = `${prefix}%`;

  // Batch: one GROUP BY per dataset instead of 5 queries × 31 days
  const metricByDay = (name: string) => {
    const rows = db.query(`SELECT substr(date,1,10) as day, COALESCE(SUM(qty),0) as t FROM metrics WHERE name=? AND date LIKE ? GROUP BY day`).all(name, likePrefix) as any[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.day, r.t);
    return m;
  };
  const stepsByDay = metricByDay("step_count");
  const calByDay = metricByDay("active_energy");
  const exerciseByDay = metricByDay("apple_exercise_time");
  const wkRows = db.query(`SELECT substr(start,1,10) as day, COUNT(*) as c FROM workouts WHERE start LIKE ? GROUP BY day`).all(likePrefix) as any[];
  const wkByDay = new Map<string, number>();
  for (const r of wkRows) wkByDay.set(r.day, r.c);
  // Sleep — per-day aggregate (sum, dedup nested) so calendar matches dashboard.
  // 31 calls/month is fine — each is a small indexed query and we only do it once per month load.
  const sleepByDay = new Map<string, number>();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${prefix}-${String(d).padStart(2, "0")}`;
    const agg = aggregateSleepForDate(day);
    if (agg) sleepByDay.set(day, agg.duration);
  }

  const result: any[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${prefix}-${String(d).padStart(2, "0")}`;
    result.push({
      date: day, day: d,
      steps: Math.round(stepsByDay.get(day) || 0),
      calories: Math.round(calByDay.get(day) || 0),
      exerciseMin: Math.round(exerciseByDay.get(day) || 0),
      workouts: wkByDay.get(day) || 0,
      sleepHrs: round(sleepByDay.get(day) || 0, 1),
    });
  }
  return { year, month, days: result };
}

function dbStats() {
  const metrics = (db.query("SELECT COUNT(*) as c FROM metrics").get() as any).c;
  const hr = (db.query("SELECT COUNT(*) as c FROM hr_readings").get() as any).c;
  const workouts = (db.query("SELECT COUNT(*) as c FROM workouts").get() as any).c;
  const sleep = (db.query("SELECT COUNT(*) as c FROM sleep").get() as any).c;
  const oldest = db.query("SELECT MIN(date) as d FROM metrics").get() as any;
  const newest = db.query("SELECT MAX(date) as d FROM metrics").get() as any;
  const dbSize = existsSync(DB_PATH) ? Math.round(Bun.file(DB_PATH).size / 1024) : 0;
  return { metrics, hr_readings: hr, workouts, sleep, oldest_date: oldest?.d, newest_date: newest?.d, db_size_kb: dbSize };
}

// ─── NixVitals 2.0: Computations ──────────────────────────

// Linear regression: returns slope per day
function linearSlope(values: number[]): number {
  if (values.length < 3) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += values[i]; sumXY += i * values[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// Pearson correlation coefficient
function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i]; sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i]; }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// ─── Recovery, Anomalies, Briefing ────────────────────────

function getBaseline(name: string, days: number): { avg: number; stddev: number; values: number[] } {
  const rows = db.query(`SELECT qty FROM metrics WHERE name = ? AND date >= date('now', '-${days} days') ORDER BY date`).all(name) as any[];
  const vals = rows.map(r => r.qty).filter((v: number) => v > 0);
  if (vals.length === 0) return { avg: 0, stddev: 0, values: [] };
  const avg = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  const variance = vals.reduce((s: number, v: number) => s + (v - avg) ** 2, 0) / vals.length;
  return { avg: Math.round(avg * 100) / 100, stddev: Math.round(Math.sqrt(variance) * 100) / 100, values: vals };
}

function getHRBaseline(days: number): { avg: number; stddev: number; resting: number } {
  // Get daily resting HR (min avg per day) for the last N days
  const rows = db.query(`SELECT substr(date,1,10) as day, MIN(avg) as resting FROM hr_readings WHERE date >= date('now', '-${days} days') GROUP BY day ORDER BY day`).all() as any[];
  const vals = rows.map(r => r.resting).filter((v: number) => v > 0);
  if (vals.length === 0) return { avg: 0, stddev: 0, resting: 0 };
  const avg = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  const variance = vals.reduce((s: number, v: number) => s + (v - avg) ** 2, 0) / vals.length;
  return { avg: Math.round(avg * 10) / 10, stddev: Math.round(Math.sqrt(variance) * 10) / 10, resting: Math.round(vals[vals.length - 1]) };
}

function buildRecoveryScore() {
  const today = todayStr();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return dateStrFmt(d); })();

  // Get baselines
  const hrBase = getHRBaseline(30);
  const sleepBase = getBaseline("sleep_analysis", 30); // won't have qty but we'll use sleep table
  const respBase = getBaseline("respiratory_rate", 30);
  const tempBase = getBaseline("apple_sleeping_wrist_temperature", 14);

  // Last night's sleep — aggregated per latest day
  const _latestDay = getLatestSleepDay();
  const lastSleep = _latestDay ? aggregateSleepForDate(_latestDay) : null;
  const sleepDuration = lastSleep?.duration || 0;
  const deepPct = sleepDuration > 0 ? ((lastSleep!.deep || 0) / sleepDuration) * 100 : 0;
  const remPct = sleepDuration > 0 ? ((lastSleep!.rem || 0) / sleepDuration) * 100 : 0;

  // Sleep avg from sleep table
  const sleepAvgRow = db.query("SELECT AVG(total_sleep) as avg FROM sleep WHERE total_sleep > 0").get() as any;
  const sleepAvg = sleepAvgRow?.avg || 7;

  // Today/yesterday resting HR
  const todayResting = (db.query("SELECT MIN(avg) as rhr FROM hr_readings WHERE date LIKE ?").get(`${today}%`) as any)?.rhr;
  const yesterdayResting = (db.query("SELECT MIN(avg) as rhr FROM hr_readings WHERE date LIKE ?").get(`${yesterday}%`) as any)?.rhr;
  const currentResting = todayResting || yesterdayResting || 0;

  // Latest resp rate and temp
  const latestResp = (db.query("SELECT qty FROM metrics WHERE name='respiratory_rate' ORDER BY date DESC LIMIT 1").get() as any)?.qty || 0;
  const latestTemp = (db.query("SELECT qty FROM metrics WHERE name='apple_sleeping_wrist_temperature' ORDER BY date DESC LIMIT 1").get() as any)?.qty || 0;

  // Component scores (each 0-100)
  // HRV proxy: how much resting HR deviates from baseline (lower = better)
  let hrScore = 50;
  if (hrBase.avg > 0 && currentResting > 0) {
    const deviation = (currentResting - hrBase.avg) / (hrBase.stddev || 1);
    hrScore = Math.max(0, Math.min(100, 50 - deviation * 25)); // centered at 50, ±2σ = 0-100
  }

  // Sleep quality: duration(30%) + deep%(20%) + REM%(15%) + efficiency(20%) + bedtime consistency(15%)
  let sleepScore = 50;
  if (sleepDuration > 0) {
    const durationScore = Math.min(30, (sleepDuration / sleepAvg) * 30);
    const deepScore = Math.min(20, deepPct * 1.5);
    const remScore = Math.min(15, remPct * 0.75);
    // Sleep efficiency: time asleep / time in bed
    const sleepStart = lastSleep?.sleepStart ? new Date(lastSleep.sleepStart.replace(" ","T").replace(/ ([+-]\d{4})$/,"$1")).getTime() : 0;
    const sleepEnd = lastSleep?.sleepEnd ? new Date(lastSleep.sleepEnd.replace(" ","T").replace(/ ([+-]\d{4})$/,"$1")).getTime() : 0;
    const timeInBed = sleepStart && sleepEnd ? (sleepEnd - sleepStart) / 3600000 : sleepDuration;
    const efficiency = timeInBed > 0 ? (sleepDuration / timeInBed) * 100 : 80;
    const efficiencyScore = Math.min(20, efficiency >= 85 ? 20 : efficiency >= 75 ? 15 : efficiency >= 65 ? 10 : 5);
    // Bedtime consistency: std dev of sleep_start times over last 7 nights
    const recentStarts = (db.query("SELECT sleep_start FROM sleep WHERE sleep_start != '' ORDER BY date DESC LIMIT 7").all() as any[]).map(r => {
      const d = new Date(r.sleep_start.replace(" ","T").replace(/ ([+-]\d{4})$/,"$1"));
      return d.getHours() * 60 + d.getMinutes(); // minutes since midnight
    }).filter(m => m > 0);
    let consistencyScore = 10; // default mid
    if (recentStarts.length >= 3) {
      const avgStart = recentStarts.reduce((a,b) => a+b, 0) / recentStarts.length;
      const stddev = Math.sqrt(recentStarts.reduce((s,v) => s + (v - avgStart) ** 2, 0) / recentStarts.length);
      consistencyScore = stddev <= 30 ? 15 : stddev <= 60 ? 10 : stddev <= 90 ? 5 : 2; // ≤30min variance = great
    }
    sleepScore = Math.max(0, Math.min(100, durationScore + deepScore + remScore + efficiencyScore + consistencyScore));
  }

  // Respiratory rate: deviation from baseline (lower = better)
  let respScore = 50;
  if (respBase.avg > 0 && latestResp > 0) {
    const deviation = (latestResp - respBase.avg) / (respBase.stddev || 1);
    respScore = Math.max(0, Math.min(100, 50 - deviation * 20));
  }

  // Wrist temp: deviation from baseline
  let tempScore = 50;
  if (tempBase.avg > 0 && latestTemp > 0) {
    const deviation = Math.abs(latestTemp - tempBase.avg) / (tempBase.stddev || 0.5);
    tempScore = Math.max(0, Math.min(100, 100 - deviation * 30));
  }

  // Weighted composite
  const score = Math.round(hrScore * 0.35 + sleepScore * 0.30 + respScore * 0.20 + tempScore * 0.15);
  const level = score >= 67 ? "green" : score >= 34 ? "yellow" : "red";
  const recommendation = score >= 67 ? "Ready to push — go hard today" : score >= 50 ? "Moderate day — steady effort" : score >= 34 ? "Take it easy — light activity only" : "Rest day recommended — prioritize recovery";

  return {
    score, level, recommendation,
    components: {
      heartRate: { score: Math.round(hrScore), current: currentResting, baseline: hrBase.avg, weight: "35%" },
      sleep: { score: Math.round(sleepScore), duration: sleepDuration, deepPct: Math.round(deepPct), remPct: Math.round(remPct), baseline: Math.round(sleepAvg * 10) / 10, weight: "30%" },
      respiratory: { score: Math.round(respScore), current: latestResp, baseline: respBase.avg, weight: "20%" },
      temperature: { score: Math.round(tempScore), current: Math.round(latestTemp * 10) / 10, baseline: tempBase.avg, weight: "15%" },
    },
  };
}

function buildAnomalyDetection() {
  const today = todayStr();
  const anomalies: any[] = [];

  // Check key metrics against 30-day baselines
  const checks = [
    { name: "respiratory_rate", label: "Respiratory Rate", unit: "/min", lower: true },
    { name: "apple_sleeping_wrist_temperature", label: "Wrist Temperature", unit: "°F", lower: false },
    { name: "walking_speed", label: "Walking Speed", unit: "mph", lower: false },
    { name: "walking_asymmetry_percentage", label: "Walking Asymmetry", unit: "%", lower: true },
    { name: "vo2_max", label: "VO2 Max", unit: "ml/kg·min", lower: false },
  ];

  for (const check of checks) {
    const base = getBaseline(check.name, 30);
    if (base.avg === 0 || base.stddev === 0) continue;
    const latest = (db.query("SELECT qty FROM metrics WHERE name = ? ORDER BY date DESC LIMIT 1").get(check.name) as any);
    if (!latest) continue;
    const zscore = (latest.qty - base.avg) / base.stddev;
    if (Math.abs(zscore) >= 1.5) {
      anomalies.push({
        metric: check.label, unit: check.unit,
        current: Math.round(latest.qty * 100) / 100,
        baseline: base.avg, stddev: base.stddev,
        zscore: Math.round(zscore * 10) / 10,
        direction: zscore > 0 ? "above" : "below",
        severity: Math.abs(zscore) >= 2.5 ? "high" : Math.abs(zscore) >= 2 ? "medium" : "low",
        concern: (check.lower && zscore > 0) || (!check.lower && zscore < 0),
      });
    }
  }

  // Check resting HR
  const hrBase = getHRBaseline(30);
  if (hrBase.avg > 0) {
    const zscore = (hrBase.resting - hrBase.avg) / (hrBase.stddev || 1);
    if (Math.abs(zscore) >= 1.5) {
      anomalies.push({
        metric: "Resting Heart Rate", unit: "bpm",
        current: hrBase.resting, baseline: hrBase.avg, stddev: hrBase.stddev,
        zscore: Math.round(zscore * 10) / 10,
        direction: zscore > 0 ? "above" : "below",
        severity: Math.abs(zscore) >= 2.5 ? "high" : Math.abs(zscore) >= 2 ? "medium" : "low",
        concern: zscore > 0, // elevated resting HR is always concerning
      });
    }
  }

  // Check sleep duration
  const sleepRows = db.query("SELECT total_sleep FROM sleep WHERE total_sleep > 0 ORDER BY date DESC LIMIT 30").all() as any[];
  if (sleepRows.length >= 7) {
    const vals = sleepRows.map(r => r.total_sleep);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stddev = Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length);
    const latest = vals[0];
    const zscore = (latest - avg) / (stddev || 1);
    if (Math.abs(zscore) >= 1.5) {
      anomalies.push({
        metric: "Sleep Duration", unit: "hrs",
        current: Math.round(latest * 10) / 10, baseline: Math.round(avg * 10) / 10, stddev: Math.round(stddev * 10) / 10,
        zscore: Math.round(zscore * 10) / 10,
        direction: zscore > 0 ? "above" : "below",
        severity: Math.abs(zscore) >= 2.5 ? "high" : Math.abs(zscore) >= 2 ? "medium" : "low",
        concern: zscore < 0,
      });
    }
  }

  return { anomalies, checkedAt: new Date().toISOString() };
}

function buildMorningBriefing() {
  const recovery = buildRecoveryScore();
  const { anomalies } = buildAnomalyDetection();
  const today = todayStr();

  // Last night's sleep — aggregated per latest day (matches dashboard headline)
  const _briefingDay = getLatestSleepDay();
  const lastSleep = _briefingDay ? aggregateSleepForDate(_briefingDay) : null;
  const sleepQuality = lastSleep ? (() => {
    const dur = lastSleep.duration || 0;
    const deepPct = dur > 0 ? ((lastSleep.deep || 0) / dur) * 100 : 0;
    const remPct = dur > 0 ? ((lastSleep.rem || 0) / dur) * 100 : 0;
    const durationScore = Math.min(60, (dur / 7.5) * 60);
    const deepScore = Math.min(20, deepPct * 1.5);
    const remScore = Math.min(20, remPct);
    return Math.round(Math.max(0, Math.min(100, durationScore + deepScore + remScore)));
  })() : 0;

  // Sleep debt (14-day rolling) — use aggregated per-day totals so naps count
  const sleepAvgRow = db.query("SELECT AVG(total_sleep) as avg FROM sleep WHERE total_sleep > 0").get() as any;
  const sleepNeed = sleepAvgRow?.avg || 7;
  const recentDays = db.query(`SELECT DISTINCT substr(date,1,10) as day FROM sleep ORDER BY day DESC LIMIT 14`).all() as any[];
  const last14Totals = recentDays.map(({ day }) => aggregateSleepForDate(day)?.duration || 0);
  const sleepDebt = round(last14Totals.reduce((debt, t) => debt + (sleepNeed - t), 0), 1);

  // Training load (simple: last 7 days workout minutes)
  const recentWorkouts = db.query("SELECT duration, calories, avg_hr FROM workouts WHERE start >= date('now', '-7 days')").all() as any[];
  const acuteLoad = recentWorkouts.reduce((s, w) => s + (w.duration || 0) / 3600, 0); // hours
  const chronicWorkouts = db.query("SELECT duration FROM workouts WHERE start >= date('now', '-42 days')").all() as any[];
  const chronicLoad = chronicWorkouts.reduce((s, w) => s + (w.duration || 0) / 3600, 0) / 6; // avg weekly hours over 6 weeks
  const loadRatio = chronicLoad > 0 ? Math.round(acuteLoad / chronicLoad * 100) / 100 : 0;
  const loadStatus = loadRatio > 1.5 ? "overreaching" : loadRatio > 1.2 ? "pushing" : loadRatio > 0.8 ? "optimal" : loadRatio > 0 ? "detraining" : "no data";

  // Today's activity so far
  const todaySummary = queryDaySummary(today);

  return {
    recovery,
    sleep: {
      duration: lastSleep?.duration || 0,
      quality: sleepQuality,
      deep: lastSleep?.deep || 0,
      rem: lastSleep?.rem || 0,
      sessions: lastSleep?.sessions || 0,
      debt: sleepDebt,
      need: round(sleepNeed, 2),
    },
    training: {
      acuteLoad: Math.round(acuteLoad * 10) / 10,
      chronicLoad: Math.round(chronicLoad * 10) / 10,
      loadRatio, loadStatus,
    },
    anomalies: anomalies.filter(a => a.concern),
    today: todaySummary.activity,

    // VO2 Max + Fitness Age
    vo2: (() => {
      const row = db.query("SELECT qty FROM metrics WHERE name='vo2_max' ORDER BY date DESC LIMIT 1").get() as any;
      const val = row?.qty || 0;
      const slope = linearSlope(getBaseline("vo2_max", 90).values);
      return { current: Math.round(val * 10) / 10, fitnessAge: vo2FitnessAge(val), trend: slope > 0.01 ? "improving" : slope < -0.01 ? "declining" : "stable", slopePerMonth: Math.round(slope * 30 * 100) / 100 };
    })(),

    // Cardiac Recovery
    cardioRecovery: (() => {
      const row = db.query("SELECT qty FROM metrics WHERE name='cardio_recovery' ORDER BY date DESC LIMIT 1").get() as any;
      const base = getBaseline("cardio_recovery", 30);
      const val = row?.qty || 0;
      const grade = val >= 20 ? "excellent" : val >= 15 ? "good" : val >= 12 ? "fair" : "poor";
      return { current: Math.round(val * 10) / 10, grade, baseline: base.avg };
    })(),

    // Environmental Audio
    envAudio: (() => {
      const today = todayStr();
      const todayAvg = db.query("SELECT AVG(qty) as a, MAX(qty) as mx FROM metrics WHERE name='environmental_audio_exposure' AND date LIKE ?").get(`${today}%`) as any;
      const base = getBaseline("environmental_audio_exposure", 30);
      return {
        todayAvg: todayAvg?.a ? Math.round(todayAvg.a) : 0,
        todayMax: todayAvg?.mx ? Math.round(todayAvg.mx) : 0,
        baseline: Math.round(base.avg),
        safe: (todayAvg?.a || 0) < 70, // WHO: sustained <70dB is safe
      };
    })(),

    illness: buildIllnessPrediction(),
    sleepPrediction: buildSleepPrediction(),
    lastSync: lastSyncTime || "No data received yet",
  };
}

// ─── Phase 2: Correlations, Insights, Gait ────────────────

function buildCorrelations() {
  // Get daily data for correlation analysis
  const days = 90;
  const dailyData: any[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const day = dateStrFmt(d);

    const steps = (db.query("SELECT COALESCE(SUM(qty),0) as t FROM metrics WHERE name='step_count' AND date LIKE ?").get(`${day}%`) as any).t;
    const cal = (db.query("SELECT COALESCE(SUM(qty),0) as t FROM metrics WHERE name='active_energy' AND date LIKE ?").get(`${day}%`) as any).t;
    const exercise = (db.query("SELECT COALESCE(SUM(qty),0) as t FROM metrics WHERE name='apple_exercise_time' AND date LIKE ?").get(`${day}%`) as any).t;
    const hrRow = db.query("SELECT MIN(avg) as resting, AVG(avg) as avg FROM hr_readings WHERE date LIKE ?").get(`${day}%`) as any;
    const sleepAggDay = aggregateSleepForDate(day);
    const workoutRow = db.query("SELECT COUNT(*) as c, SUM(duration) as dur, SUM(calories) as cal FROM workouts WHERE start LIKE ?").get(`${day}%`) as any;

    if (steps > 0 || sleepAggDay || hrRow?.resting) {
      dailyData.push({
        date: day, steps, calories: cal, exercise,
        restingHR: hrRow?.resting || 0, avgHR: hrRow?.avg || 0,
        sleepDuration: sleepAggDay?.duration || 0,
        deepSleep: sleepAggDay?.deep || 0, remSleep: sleepAggDay?.rem || 0,
        workoutCount: workoutRow?.c || 0,
        workoutMinutes: Math.round((workoutRow?.dur || 0) / 60),
        workoutCal: workoutRow?.cal || 0,
        envAudio: (() => { const r = db.query("SELECT AVG(qty) as a FROM metrics WHERE name='environmental_audio_exposure' AND date LIKE ?").get(`${day}%`) as any; return r?.a ? Math.round(r.a) : 0; })(),
      });
    }
  }

  if (dailyData.length < 7) return { correlations: [], dailyData: dailyData.length };

  // Define metric pairs to correlate
  const pairs: Array<{ xKey: string; yKey: string; xLabel: string; yLabel: string; note: string; lowerYBetter?: boolean }> = [
    { xKey: "sleepDuration", yKey: "restingHR", xLabel: "Sleep Duration", yLabel: "Next-Day Resting HR", note: "More sleep → lower resting HR?", lowerYBetter: true },
    { xKey: "sleepDuration", yKey: "steps", xLabel: "Sleep Duration", yLabel: "Next-Day Steps", note: "More sleep → more active?" },
    { xKey: "deepSleep", yKey: "restingHR", xLabel: "Deep Sleep", yLabel: "Next-Day Resting HR", note: "Deep sleep → better HR recovery?", lowerYBetter: true },
    { xKey: "deepSleep", yKey: "calories", xLabel: "Deep Sleep", yLabel: "Next-Day Active Calories", note: "Deep sleep → more energy?" },
    { xKey: "exercise", yKey: "sleepDuration", xLabel: "Exercise Minutes", yLabel: "That Night's Sleep", note: "Exercise → better sleep?" },
    { xKey: "steps", yKey: "sleepDuration", xLabel: "Daily Steps", yLabel: "That Night's Sleep", note: "More active → sleep longer?" },
    { xKey: "workoutMinutes", yKey: "sleepDuration", xLabel: "Workout Duration", yLabel: "That Night's Sleep", note: "Harder workout → more sleep?" },
    { xKey: "workoutMinutes", yKey: "restingHR", xLabel: "Workout Duration", yLabel: "Next-Day Resting HR", note: "Training load → HR impact?", lowerYBetter: true },
    { xKey: "sleepDuration", yKey: "exercise", xLabel: "Sleep Duration", yLabel: "Next-Day Exercise", note: "Sleep → more exercise?" },
    { xKey: "remSleep", yKey: "steps", xLabel: "REM Sleep", yLabel: "Next-Day Steps", note: "REM → next-day activity?" },
    { xKey: "envAudio", yKey: "sleepDuration", xLabel: "Noise Exposure", yLabel: "That Night's Sleep", note: "Noise → sleep impact?", lowerYBetter: false },
    { xKey: "envAudio", yKey: "restingHR", xLabel: "Noise Exposure", yLabel: "Next-Day Resting HR", note: "Noise → cardiovascular impact?", lowerYBetter: true },
  ];

  const correlations: any[] = [];

  for (const pair of pairs) {
    // For "next-day" correlations, offset by 1 day
    const isNextDay = pair.yLabel.includes("Next-Day");
    const xVals: number[] = [];
    const yVals: number[] = [];

    for (let i = 0; i < dailyData.length - (isNextDay ? 1 : 0); i++) {
      const x = dailyData[i][pair.xKey];
      const yIdx = isNextDay ? i + 1 : i;
      const y = dailyData[yIdx]?.[pair.yKey.replace("Next-Day ", "")];
      if (x > 0 && y > 0) { xVals.push(x); yVals.push(y); }
    }

    if (xVals.length >= 7) {
      const r = pearsonCorr(xVals, yVals);
      if (Math.abs(r) >= 0.15) {
        const direction = r > 0 ? "positive" : "negative";
        const strength = Math.abs(r) >= 0.5 ? "strong" : Math.abs(r) >= 0.3 ? "moderate" : "weak";
        const goodOrBad = (pair.lowerYBetter && r < 0) || (!pair.lowerYBetter && r > 0) ? "beneficial" : (pair.lowerYBetter && r > 0) || (!pair.lowerYBetter && r < 0) ? "concerning" : "neutral";

        correlations.push({
          x: pair.xLabel, y: pair.yLabel,
          r: Math.round(r * 100) / 100,
          direction, strength, goodOrBad,
          note: pair.note,
          dataPoints: xVals.length,
        });
      }
    }
  }

  // Sort by absolute correlation strength
  correlations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  return { correlations, totalDays: dailyData.length };
}

function buildInsights() {
  const correlations = buildCorrelations();
  const anomalies = buildAnomalyDetection();
  const recovery = buildRecoveryScore();

  // Gait trends (2-week regression)
  const gaitMetrics = ["walking_speed", "walking_step_length", "walking_asymmetry_percentage", "walking_double_support_percentage"];
  const gaitTrends: any[] = [];
  for (const name of gaitMetrics) {
    const base = getBaseline(name, 30);
    if (base.values.length >= 5) {
      const slope = linearSlope(base.values);
      const slopePerWeek = slope * 7;
      const pctChange = base.avg > 0 ? Math.round(slopePerWeek / base.avg * 100 * 10) / 10 : 0;
      const label = name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      const concerning = (name.includes("asymmetry") || name.includes("double_support")) ? slopePerWeek > 0 : slopePerWeek < 0;
      gaitTrends.push({
        metric: label, current: base.avg, slope: Math.round(slopePerWeek * 1000) / 1000,
        pctChangePerWeek: pctChange, direction: slopePerWeek > 0 ? "increasing" : "decreasing",
        concerning, dataPoints: base.values.length,
      });
    }
  }

  // Key metric trends (30-day regression)
  const trendMetrics = [
    { name: "vo2_max", label: "VO2 Max", lowerBad: true },
    { name: "walking_speed", label: "Walking Speed", lowerBad: true },
    { name: "respiratory_rate", label: "Respiratory Rate", lowerBad: false },
  ];
  const metricTrends: any[] = [];
  for (const m of trendMetrics) {
    const base = getBaseline(m.name, 90);
    if (base.values.length >= 7) {
      const slope = linearSlope(base.values);
      const slopePerMonth = slope * 30;
      const arrow = slopePerMonth > 0.01 ? "↑" : slopePerMonth < -0.01 ? "↓" : "→";
      metricTrends.push({
        metric: m.label, current: base.avg,
        trend: arrow, slopePerMonth: Math.round(slopePerMonth * 100) / 100,
        concerning: m.lowerBad ? slopePerMonth < -0.01 : slopePerMonth > 0.01,
      });
    }
  }

  // Sleep resting HR data
  const sleepRows = db.query("SELECT total_sleep, deep, rem FROM sleep WHERE total_sleep > 0 ORDER BY date DESC LIMIT 30").all() as any[];
  const hrDays = db.query("SELECT substr(date,1,10) as day, MIN(avg) as resting FROM hr_readings GROUP BY day ORDER BY day DESC LIMIT 30").all() as any[];

  return {
    correlations: correlations.correlations.slice(0, 8),
    anomalies: anomalies.anomalies,
    gaitTrends,
    metricTrends,
    recovery: { score: recovery.score, level: recovery.level },
  };
}

// ─── Monthly Report ───────────────────────────────────────

function buildMonthlyReport(year: number, month: number) {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10 : 0;

  // Activity — batched GROUP BY per metric (was 4 queries × 31 days = 124)
  const likePrefix = `${prefix}%`;
  const sumByDay = (name: string) => {
    const rows = db.query(`SELECT substr(date,1,10) as day, COALESCE(SUM(qty),0) as t FROM metrics WHERE name=? AND date LIKE ? GROUP BY day`).all(name, likePrefix) as any[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.day, r.t);
    return m;
  };
  const stepMap = sumByDay("step_count");
  const calMap = sumByDay("active_energy");
  const exMap = sumByDay("apple_exercise_time");
  const distMap = sumByDay("walking_running_distance");
  const dailySteps: number[] = [], dailyCal: number[] = [], dailyExercise: number[] = [], dailyDist: number[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${prefix}-${String(d).padStart(2, "0")}`;
    const steps = stepMap.get(day) || 0;
    if (steps > 0) {
      dailySteps.push(steps);
      dailyCal.push(calMap.get(day) || 0);
      dailyExercise.push(exMap.get(day) || 0);
      dailyDist.push(distMap.get(day) || 0);
    }
  }

  // Sleep — aggregate per date (sum + nested-dedup, matches dashboard)
  const sleepDayRows = db.query(`SELECT DISTINCT substr(date,1,10) as day FROM sleep WHERE date LIKE ? ORDER BY day ASC`).all(`${prefix}%`) as any[];
  const sleepNights = sleepDayRows.map(({ day }) => {
    const a = aggregateSleepForDate(day);
    if (!a) return null;
    return { date: day, total_sleep: a.duration, deep: a.deep, rem: a.rem, core: a.core, awake: a.awake };
  }).filter(Boolean) as any[];

  // HR
  const hrRows = db.query(`SELECT substr(date,1,10) as day, MIN(avg) as resting, AVG(avg) as avg, MAX(max) as peak FROM hr_readings WHERE date LIKE ? GROUP BY day`).all(`${prefix}%`) as any[];

  // Workouts
  const workouts = (db.query("SELECT * FROM workouts WHERE start LIKE ? ORDER BY start ASC").all(`${prefix}%`) as any[]).map(mapDbWorkout);

  // Anomalies for the month (simplified — count days with elevated resting HR)
  const restingHRs = hrRows.map(r => r.resting).filter(v => v > 0);
  const hrAvg = avg(restingHRs);
  const hrStd = restingHRs.length > 0 ? Math.sqrt(restingHRs.reduce((s, v) => s + (v - hrAvg) ** 2, 0) / restingHRs.length) : 0;
  const elevatedHRDays = restingHRs.filter(v => v > hrAvg + 1.5 * hrStd).length;

  // VO2 trend
  const vo2Rows = db.query("SELECT qty FROM metrics WHERE name='vo2_max' AND date LIKE ? ORDER BY date").all(`${prefix}%`) as any[];
  const vo2Start = vo2Rows.length > 0 ? Math.round(vo2Rows[0].qty * 10) / 10 : 0;
  const vo2End = vo2Rows.length > 0 ? Math.round(vo2Rows[vo2Rows.length - 1].qty * 10) / 10 : 0;

  // Personal records for the month
  const bestStepDay = dailySteps.length > 0 ? Math.round(Math.max(...dailySteps)) : 0;
  const bestSleepNight = sleepNights.length > 0 ? Math.round(Math.max(...sleepNights.map(s => s.total_sleep)) * 10) / 10 : 0;
  const longestWorkout = workouts.length > 0 ? Math.max(...workouts.map(w => w.duration)) : 0;
  const farthestWorkout = workouts.length > 0 ? Math.max(...workouts.map(w => w.distance)) : 0;

  return {
    title: `${monthNames[month]} ${year}`,
    period: prefix,
    daysTracked: dailySteps.length,
    activity: {
      avgSteps: Math.round(avg(dailySteps)),
      totalSteps: Math.round(dailySteps.reduce((a, b) => a + b, 0)),
      avgCalories: Math.round(avg(dailyCal)),
      totalCalories: Math.round(dailyCal.reduce((a, b) => a + b, 0)),
      avgExercise: Math.round(avg(dailyExercise)),
      totalExercise: Math.round(dailyExercise.reduce((a, b) => a + b, 0)),
      avgDistance: Math.round(avg(dailyDist) * 100) / 100,
      totalDistance: Math.round(dailyDist.reduce((a, b) => a + b, 0) * 100) / 100,
    },
    sleep: {
      nights: sleepNights.length,
      avgDuration: avg(sleepNights.map(s => s.total_sleep)),
      avgDeep: avg(sleepNights.map(s => s.deep)),
      avgRem: avg(sleepNights.map(s => s.rem)),
      avgCore: avg(sleepNights.map(s => s.core)),
      bestNight: bestSleepNight,
    },
    heartRate: {
      avgResting: avg(restingHRs),
      lowestResting: restingHRs.length > 0 ? Math.round(Math.min(...restingHRs)) : 0,
      elevatedDays: elevatedHRDays,
    },
    workouts: {
      count: workouts.length,
      totalDuration: workouts.reduce((s, w) => s + w.duration, 0),
      totalDistance: Math.round(workouts.reduce((s, w) => s + w.distance, 0) * 100) / 100,
      totalCalories: workouts.reduce((s, w) => s + w.calories, 0),
      totalStrain: Math.round(workouts.reduce((s, w) => s + w.strain, 0) * 10) / 10,
      avgStrain: avg(workouts.map(w => w.strain)),
    },
    fitness: {
      vo2Start, vo2End,
      vo2Change: Math.round((vo2End - vo2Start) * 10) / 10,
      vo2Direction: vo2End > vo2Start ? "improving" : vo2End < vo2Start ? "declining" : "stable",
    },
    records: { bestStepDay, bestSleepNight, longestWorkout, farthestWorkout },
  };
}

// ─── 3.0: Illness Prediction ──────────────────────────────

function buildIllnessPrediction() {
  // Check 3 signals over last 3 days: resting HR, respiratory rate, wrist temperature
  const signals: any[] = [];
  const days = 3;
  let triggeredSignals = 0;

  // Signal 1: Resting HR elevated for 2+ consecutive days
  const hrBase = getHRBaseline(30);
  const recentHR = db.query("SELECT substr(date,1,10) as day, MIN(avg) as resting FROM hr_readings GROUP BY day ORDER BY day DESC LIMIT ?").all(days) as any[];
  const elevatedHRDays = recentHR.filter(r => r.resting > hrBase.avg + 1.5 * (hrBase.stddev || 3));
  const hrElevated = elevatedHRDays.length >= 2;
  if (hrElevated) triggeredSignals++;
  signals.push({
    name: "Resting Heart Rate", icon: "❤️",
    status: hrElevated ? "elevated" : "normal",
    current: recentHR[0]?.resting ? Math.round(recentHR[0].resting) : 0,
    baseline: hrBase.avg,
    threshold: Math.round(hrBase.avg + 1.5 * (hrBase.stddev || 3)),
    consecutiveDays: elevatedHRDays.length,
  });

  // Signal 2: Respiratory rate elevated
  const respBase = getBaseline("respiratory_rate", 30);
  const recentResp = db.query("SELECT qty FROM metrics WHERE name='respiratory_rate' ORDER BY date DESC LIMIT ?").all(days) as any[];
  const elevatedRespDays = recentResp.filter(r => r.qty > respBase.avg + 1 * (respBase.stddev || 1));
  const respElevated = elevatedRespDays.length >= 2;
  if (respElevated) triggeredSignals++;
  signals.push({
    name: "Respiratory Rate", icon: "🫁",
    status: respElevated ? "elevated" : "normal",
    current: recentResp[0]?.qty ? Math.round(recentResp[0].qty * 10) / 10 : 0,
    baseline: respBase.avg,
    threshold: Math.round((respBase.avg + 1 * (respBase.stddev || 1)) * 10) / 10,
    consecutiveDays: elevatedRespDays.length,
  });

  // Signal 3: Wrist temperature deviation
  const tempBase = getBaseline("apple_sleeping_wrist_temperature", 14);
  const recentTemp = db.query("SELECT qty FROM metrics WHERE name='apple_sleeping_wrist_temperature' ORDER BY date DESC LIMIT ?").all(days) as any[];
  const elevatedTempDays = recentTemp.filter(r => Math.abs(r.qty - tempBase.avg) > 0.5);
  const tempElevated = elevatedTempDays.length >= 2;
  if (tempElevated) triggeredSignals++;
  signals.push({
    name: "Wrist Temperature", icon: "🌡️",
    status: tempElevated ? "elevated" : "normal",
    current: recentTemp[0]?.qty ? Math.round(recentTemp[0].qty * 10) / 10 : 0,
    baseline: tempBase.avg,
    threshold: Math.round((tempBase.avg + 0.5) * 10) / 10,
    consecutiveDays: elevatedTempDays.length,
  });

  const alert = triggeredSignals >= 2;
  const level = triggeredSignals >= 3 ? "high" : triggeredSignals >= 2 ? "moderate" : "none";
  const message = alert
    ? triggeredSignals >= 3
      ? "Multiple body signals are elevated. Your body may be fighting something. Strongly consider rest and extra sleep."
      : "Two early warning signals are elevated. Monitor closely — this pattern often precedes illness by 48-72 hours."
    : "All clear — no illness indicators detected.";

  return { alert, level, triggeredSignals, signals, message };
}

// ─── 3.0: Sleep Prediction ───────────────────────────────

function buildSleepPrediction() {
  const today = todayStr();

  // Gather today's inputs
  const todayExercise = (db.query("SELECT COALESCE(SUM(qty),0) as t FROM metrics WHERE name='apple_exercise_time' AND date LIKE ?").get(`${today}%`) as any).t;
  const todaySteps = (db.query("SELECT COALESCE(SUM(qty),0) as t FROM metrics WHERE name='step_count' AND date LIKE ?").get(`${today}%`) as any).t;
  const todayWorkouts = (db.query("SELECT COUNT(*) as c, COALESCE(SUM(duration),0) as dur FROM workouts WHERE start LIKE ?").get(`${today}%`) as any);
  const workoutMinutes = Math.round((todayWorkouts?.dur || 0) / 60);

  // Get correlation data: exercise → sleep duration
  const corrData = buildCorrelations();
  const exerciseSleepCorr = corrData.correlations.find((c: any) => c.x === "Exercise Minutes" && c.y.includes("Sleep"));

  // Historical averages
  const sleepAvgRow = db.query("SELECT AVG(total_sleep) as avg FROM sleep WHERE total_sleep > 0").get() as any;
  const sleepAvg = sleepAvgRow?.avg || 7;

  // Day of week pattern
  const dow = new Date().getDay(); // 0=Sun
  const dowSleep = db.query(`SELECT AVG(s.total_sleep) as avg FROM sleep s WHERE cast(strftime('%w', substr(s.date,1,10)) as integer) = ? AND s.total_sleep > 0`).get(dow) as any;
  const dowAvg = dowSleep?.avg ? Math.round(dowSleep.avg * 10) / 10 : sleepAvg;

  // Training load effect
  // Get training load status directly (avoid circular call to buildMorningBriefing)
  const recentWk = db.query("SELECT duration FROM workouts WHERE start >= date('now', '-7 days')").all() as any[];
  const acLoad = recentWk.reduce((s: number, w: any) => s + (w.duration || 0) / 3600, 0);
  const chronicWk = db.query("SELECT duration FROM workouts WHERE start >= date('now', '-42 days')").all() as any[];
  const chLoad = chronicWk.reduce((s: number, w: any) => s + (w.duration || 0) / 3600, 0) / 6;
  const lRatio = chLoad > 0 ? acLoad / chLoad : 0;
  const loadStatus = lRatio > 1.5 ? "overreaching" : lRatio > 1.2 ? "pushing" : lRatio > 0.8 ? "optimal" : "detraining";
  const loadPenalty = loadStatus === "overreaching" ? -0.3 : loadStatus === "pushing" ? -0.1 : 0;

  // Exercise effect (moderate exercise helps, excessive hurts)
  const exerciseBonus = todayExercise > 20 && todayExercise < 60 ? 0.2 : todayExercise >= 60 ? -0.1 : 0;

  // Step effect
  const stepBase = getBaseline("step_count", 30);
  const stepBonus = todaySteps > stepBase.avg * 1.2 ? 0.15 : todaySteps < stepBase.avg * 0.5 ? -0.1 : 0;

  // Predicted duration
  const predictedDuration = Math.round((dowAvg + exerciseBonus + stepBonus + loadPenalty) * 10) / 10;

  // Predicted quality (0-100)
  const baseQuality = 70;
  const exerciseQualBonus = todayExercise > 20 ? 10 : 0;
  const loadQualPenalty = loadStatus === "overreaching" ? -15 : loadStatus === "pushing" ? -5 : 0;
  const predictedQuality = Math.max(20, Math.min(100, Math.round(baseQuality + exerciseQualBonus + loadQualPenalty)));

  const factors: any[] = [];
  if (todayExercise > 20) factors.push({ factor: "Exercise", effect: "positive", note: `${Math.round(todayExercise)} min of exercise today` });
  if (todayExercise >= 60) factors.push({ factor: "Heavy exercise", effect: "negative", note: "Late/heavy exercise may reduce sleep quality" });
  if (workoutMinutes > 0) factors.push({ factor: "Workout", effect: "positive", note: `${workoutMinutes} min workout completed` });
  if (loadStatus === "overreaching") factors.push({ factor: "Training load", effect: "negative", note: "Overreaching — body under stress" });
  if (todaySteps > stepBase.avg * 1.2) factors.push({ factor: "High activity", effect: "positive", note: `${Math.round(todaySteps)} steps (above average)` });

  return {
    predictedDuration,
    predictedQuality,
    yourAverage: Math.round(sleepAvg * 10) / 10,
    dayOfWeekAverage: dowAvg,
    factors,
    confidence: corrData.totalDays > 30 ? "moderate" : "low",
  };
}

// ─── 3.0: Workout Route Map Data ─────────────────────────

function getWorkoutRoute(workoutId: string) {
  const row = db.query("SELECT * FROM workouts WHERE id = ?").get(workoutId) as any;
  if (!row) return { error: "Workout not found" };

  const workout = mapDbWorkout(row);
  let route: any[] = [];
  let hrTimeline: any[] = [];

  try {
    const hrData = JSON.parse(row.hr_data || "[]");
    hrTimeline = hrData.map((h: any) => ({ time: h.d, bpm: h.b }));
  } catch {}

  // Prefer DB-stored route_data (populated during ingest + backfill). Fall back to
  // JSONL scan only if DB has nothing — previously we scanned the full 108 MB JSONL
  // on every request, which blocked the event loop for hundreds of ms.
  if (row.route_data) {
    try {
      const parsed = JSON.parse(row.route_data);
      route = parsed.map((p: any) => ({ lat: p.lat, lon: p.lon, alt: p.alt, timestamp: p.ts }));
    } catch {}
  }

  return { workout, route, hrTimeline, hasRoute: route.length > 0 };
}

// ─── Server ───────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    // POST health data → ingest to SQLite + append to JSONL backup
    if (url.pathname === "/health" && req.method === "POST") {
      const declaredLen = parseInt(req.headers.get("content-length") || "0");
      if (declaredLen > MAX_POST_BYTES) return json({ status: "error", message: "Payload too large" }, 413);

      let body: string;
      try {
        body = await req.text();
      } catch (err: any) {
        return json({ status: "error", message: "Failed to read body: " + err.message }, 400);
      }
      if (body.length > MAX_POST_BYTES) return json({ status: "error", message: "Payload too large" }, 413);

      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch (err: any) {
        return json({ status: "error", message: "Invalid JSON: " + err.message }, 400);
      }

      const timestamp = new Date().toISOString();
      try {
        ingestPayload(payload);
        appendFileSync(RAW_LOG, JSON.stringify({ timestamp, size: body.length, payload }) + "\n");
        lastSyncTime = timestamp;
        console.log(`[${timestamp}] Ingested health data: ${body.length} bytes`);
        return json({ status: "ok", received: body.length });
      } catch (err: any) {
        console.error(`[${timestamp}] Ingest failed:`, err?.message);
        return json({ status: "error", message: "Ingest failed: " + err.message }, 500);
      }
    }

    if (url.pathname === "/health" && req.method === "GET") return json({ status: "ok", uptime: process.uptime() });

    // Browser-safe runtime config. CARTO requires the API key client-side,
    // so expose only that key from the container environment.
    if (url.pathname === "/api/config" && req.method === "GET") {
      return json({ cartoApiKey: process.env.CARTO_API_KEY || "" });
    }
    // ─── NixVitals 2.0 Endpoints ─────────────────────────
    if (url.pathname === "/api/briefing") return json(buildMorningBriefing());
    if (url.pathname === "/api/recovery") return json(buildRecoveryScore());
    if (url.pathname === "/api/anomalies") return json(buildAnomalyDetection());
    if (url.pathname === "/api/correlations") return json(buildCorrelations());
    if (url.pathname === "/api/insights") return json(buildInsights());
    if (url.pathname === "/api/illness") return json(buildIllnessPrediction());
    if (url.pathname === "/api/sleep-prediction") return json(buildSleepPrediction());
    if (url.pathname === "/api/route") { const id = url.searchParams.get("id") || ""; return json(getWorkoutRoute(id)); }
    if (url.pathname === "/api/monthly-report") {
      const now = new Date();
      const year = parseInt(url.searchParams.get("year") || String(now.getFullYear()));
      const month = parseInt(url.searchParams.get("month") || String(now.getMonth() + 1));
      if (!isValidYearMonth(year, month)) return json({ error: "Invalid year/month" }, 400);
      return json(buildMonthlyReport(year, month));
    }

    if (url.pathname === "/api/dashboard") return json(buildDashboardData());
    if (url.pathname === "/api/history") {
      const raw = parseInt(url.searchParams.get("days") || "7");
      const days = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 7, 365));
      return json(buildHistoryData(days));
    }
    if (url.pathname === "/api/day") {
      const day = url.searchParams.get("date") || todayStr();
      if (!isValidDay(day)) return json({ error: "Invalid date format (expected YYYY-MM-DD)" }, 400);
      return json(queryDaySummary(day));
    }
    if (url.pathname === "/api/workouts") return json((db.query("SELECT * FROM workouts ORDER BY start DESC").all() as any[]).map(mapDbWorkout));

    // Workout analytics — aggregated stats, weekly/monthly breakdowns, trends, PRs
    if (url.pathname === "/api/workout-analytics") {
      const all = (db.query("SELECT * FROM workouts ORDER BY start ASC").all() as any[]).map(mapDbWorkout);
      if (all.length === 0) return json({ error: "No workouts" });

      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10 : 0;
      const sum = (arr: number[]) => Math.round(arr.reduce((a,b)=>a+b,0)*100)/100;
      const withPace = all.filter(w => w.pace > 0);

      // Overall stats
      const overall = {
        count: all.length,
        totalDuration: sum(all.map(w=>w.duration)),
        totalDistance: sum(all.map(w=>w.distance)),
        totalCalories: sum(all.map(w=>w.calories)),
        totalSteps: sum(all.map(w=>w.steps)),
        totalElevation: sum(all.map(w=>w.elevationGain)),
        avgDuration: avg(all.map(w=>w.duration)),
        avgDistance: avg(all.map(w=>w.distance)),
        avgCalories: avg(all.map(w=>w.calories)),
        avgHR: avg(all.map(w=>w.avgHR)),
        avgPace: avg(withPace.map(w=>w.pace)),
        avgCadence: avg(all.filter(w=>w.cadence>0).map(w=>w.cadence)),
        avgCalPerMin: avg(all.filter(w=>w.calPerMin>0).map(w=>w.calPerMin)),
        avgSteps: avg(all.map(w=>w.steps)),
        avgElevation: avg(all.filter(w=>w.elevationGain>0).map(w=>w.elevationGain)),
        avgStrain: avg(all.map(w=>w.strain)),
        totalStrain: sum(all.map(w=>w.strain)),
      };

      // Personal records
      const prs = {
        longestDuration: all.reduce((b,w)=>w.duration>b.duration?w:b),
        farthestDistance: all.reduce((b,w)=>w.distance>b.distance?w:b),
        mostCalories: all.reduce((b,w)=>w.calories>b.calories?w:b),
        highestHR: all.reduce((b,w)=>w.maxHR>b.maxHR?w:b),
        fastestPace: withPace.reduce((b,w)=>w.pace<b.pace?w:b,withPace[0]),
        mostSteps: all.reduce((b,w)=>w.steps>b.steps?w:b),
        mostElevation: all.filter(w=>w.elevationGain>0).reduce((b,w)=>w.elevationGain>b.elevationGain?w:b,all[0]),
      };

      // Weekly aggregates
      const weeks = new Map<string, any[]>();
      for (const w of all) {
        const d = new Date(w.start.replace(" ","T").replace(/ ([+-]\d{4})$/,"$1"));
        const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
        const wk = `${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,"0")}-${String(sun.getDate()).padStart(2,"0")}`;
        if (!weeks.has(wk)) weeks.set(wk, []);
        weeks.get(wk)!.push(w);
      }
      const weeklyStats = Array.from(weeks.entries()).map(([wk, ws]) => ({
        week: wk, count: ws.length,
        totalDuration: sum(ws.map(w=>w.duration)), totalDistance: sum(ws.map(w=>w.distance)),
        totalCalories: sum(ws.map(w=>w.calories)), totalSteps: sum(ws.map(w=>w.steps)),
        avgDuration: avg(ws.map(w=>w.duration)), avgDistance: avg(ws.map(w=>w.distance)),
        avgCalories: avg(ws.map(w=>w.calories)), avgHR: avg(ws.map(w=>w.avgHR)),
        avgPace: avg(ws.filter(w=>w.pace>0).map(w=>w.pace)),
      })).sort((a,b)=>a.week.localeCompare(b.week));

      // Per-workout trend data (for charts)
      const trends = all.map(w => ({
        date: w.start.slice(0,10), duration: w.duration, distance: w.distance,
        calories: w.calories, avgHR: w.avgHR, pace: w.pace, steps: w.steps,
        elevation: w.elevationGain, cadence: w.cadence, calPerMin: w.calPerMin, strain: w.strain,
      }));

      // Cardiac recovery rate over time — from cardio_recovery metric entries
      const recoveryTrend = (db.query("SELECT date, qty FROM metrics WHERE name='cardio_recovery' ORDER BY date ASC").all() as any[]).map(r => ({
        date: r.date.slice(0, 10),
        rate: Math.round(r.qty * 10) / 10,
        grade: r.qty >= 20 ? "excellent" : r.qty >= 15 ? "good" : r.qty >= 12 ? "fair" : "poor",
      }));

      return json({ overall, prs, weeklyStats, trends, recoveryTrend, workouts: all.reverse() });
    }
    if (url.pathname === "/api/sleep") return json(buildSleepHistory());

    // HR samples within a specific night's sleep window + the night's stage breakdown.
    // Used by the HR-during-sleep curve chart on the Sleep tab.
    if (url.pathname === "/api/sleep-hr") {
      const day = url.searchParams.get("date") || todayStr();
      if (!isValidDay(day)) return json({ error: "Invalid date format" }, 400);
      const agg = aggregateSleepForDate(day);
      if (!agg || !agg.sleepStart || !agg.sleepEnd) return json({ error: "No sleep data for date" }, 404);
      const hrRows = db.query(`
        SELECT date, avg, min, max FROM hr_readings
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC
      `).all(agg.sleepStart, agg.sleepEnd) as any[];
      // Pull all sleep entries in the window so we can render the stage timeline
      const stageRows = db.query(`
        SELECT sleep_start, sleep_end, deep, rem, core, awake, total_sleep
        FROM sleep
        WHERE sleep_start >= ? AND sleep_end <= ?
        ORDER BY total_sleep ASC
      `).all(agg.sleepStart, agg.sleepEnd) as any[];
      return json({
        date: day,
        sleepStart: agg.sleepStart,
        sleepEnd: agg.sleepEnd,
        duration: agg.duration,
        sessions: agg.sessions,
        hrSamples: hrRows.map(r => ({ t: r.date, bpm: Math.round(r.avg || 0), min: Math.round(r.min || 0), max: Math.round(r.max || 0) })),
        stageWindows: stageRows.map(r => ({
          start: r.sleep_start, end: r.sleep_end,
          deep: round(r.deep || 0, 2), rem: round(r.rem || 0, 2),
          core: round(r.core || 0, 2), awake: round(r.awake || 0, 2),
          total: round(r.total_sleep || 0, 2),
        })),
      });
    }

    // 14-day recovery score history (compact computation reusing per-day inputs)
    if (url.pathname === "/api/recovery-history") {
      const days = Math.max(7, Math.min(parseInt(url.searchParams.get("days") || "14"), 60));
      const dayRows = db.query(`SELECT DISTINCT substr(date,1,10) as day FROM sleep ORDER BY day DESC LIMIT ?`).all(days) as any[];
      const hrBase = getHRBaseline(30);
      const respBase = getBaseline("respiratory_rate", 30);
      const tempBase = getBaseline("apple_sleeping_wrist_temperature", 14);
      const result: any[] = [];
      for (const { day } of dayRows.reverse()) {
        const sleep = aggregateSleepForDate(day);
        const dur = sleep?.duration || 0;
        const deepPct = dur > 0 ? ((sleep!.deep || 0) / dur) * 100 : 0;
        const remPct = dur > 0 ? ((sleep!.rem || 0) / dur) * 100 : 0;
        // Sleep score (simplified, 0-100)
        let sleepScore = 0;
        if (dur > 0) {
          const durationScore = Math.min(50, (dur / 7.5) * 50);
          const deepScore = Math.min(25, deepPct * 1.7);
          const remScore = Math.min(25, remPct * 1.2);
          sleepScore = Math.round(durationScore + deepScore + remScore);
        }
        // HR score (lower deviation = higher score)
        const dayResting = (db.query("SELECT MIN(avg) as r FROM hr_readings WHERE date LIKE ?").get(`${day}%`) as any)?.r || 0;
        let hrScore = 50;
        if (hrBase.avg > 0 && dayResting > 0) {
          const dev = (dayResting - hrBase.avg) / (hrBase.stddev || 1);
          hrScore = Math.max(0, Math.min(100, 50 - dev * 25));
        }
        // Respiratory + temp scores
        const dayResp = (db.query("SELECT qty FROM metrics WHERE name='respiratory_rate' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any)?.qty || 0;
        let respScore = 50;
        if (respBase.avg > 0 && dayResp > 0) respScore = Math.max(0, Math.min(100, 50 - ((dayResp - respBase.avg) / (respBase.stddev || 1)) * 20));
        const dayTemp = (db.query("SELECT qty FROM metrics WHERE name='apple_sleeping_wrist_temperature' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any)?.qty || 0;
        let tempScore = 50;
        if (tempBase.avg > 0 && dayTemp > 0) tempScore = Math.max(0, Math.min(100, 100 - Math.abs(dayTemp - tempBase.avg) / (tempBase.stddev || 0.5) * 30));
        const composite = Math.round(hrScore * 0.35 + sleepScore * 0.30 + respScore * 0.20 + tempScore * 0.15);
        result.push({ date: day, score: composite, sleep: sleepScore, hr: Math.round(hrScore), resp: Math.round(respScore), temp: Math.round(tempScore), duration: round(dur, 2) });
      }
      return json({ days: result });
    }

    // Sleep analytics — aggregate per calendar date (sum + nested-dedup, matches dashboard rule)
    if (url.pathname === "/api/sleep-analytics") {
      const dayList = db.query(`SELECT DISTINCT substr(date,1,10) as day FROM sleep ORDER BY day ASC`).all() as any[];
      const all = dayList.map(({ day }) => {
        const a = aggregateSleepForDate(day);
        if (!a) return null;
        const resp = db.query("SELECT qty FROM metrics WHERE name='respiratory_rate' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
        const temp = db.query("SELECT qty FROM metrics WHERE name='apple_sleeping_wrist_temperature' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
        const breath = db.query("SELECT qty FROM metrics WHERE name='breathing_disturbances' AND date LIKE ? ORDER BY date DESC LIMIT 1").get(`${day}%`) as any;
        const dur = a.duration;
        return {
          date: day + " 00:00:00",
          duration: round(dur, 1), deep: round(a.deep, 1), rem: round(a.rem, 1),
          core: round(a.core, 1), awake: round(a.awake, 1),
          sleepStart: a.sleepStart, sleepEnd: a.sleepEnd, sessions: a.sessions,
          respiratoryRate: resp ? round(resp.qty, 1) : 0,
          wristTemp: temp ? round(temp.qty, 1) : 0,
          breathingDisturbances: breath ? round(breath.qty, 1) : 0,
          deepPct: dur > 0 ? Math.round(a.deep / dur * 100) : 0,
          remPct: dur > 0 ? Math.round(a.rem / dur * 100) : 0,
          corePct: dur > 0 ? Math.round(a.core / dur * 100) : 0,
        };
      }).filter(Boolean) as any[];
      if(all.length===0) return json({error:"No sleep data"});

      const avg=(arr:number[])=>arr.length?Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10:0;
      const sum=(arr:number[])=>Math.round(arr.reduce((a,b)=>a+b,0)*10)/10;
      const withResp=all.filter(s=>s.respiratoryRate>0);
      const withTemp=all.filter(s=>s.wristTemp>0);

      const overall={
        nights: all.length,
        avgDuration: avg(all.map(s=>s.duration)),
        avgDeep: avg(all.map(s=>s.deep)),
        avgRem: avg(all.map(s=>s.rem)),
        avgCore: avg(all.map(s=>s.core)),
        avgAwake: avg(all.map(s=>s.awake)),
        avgDeepPct: avg(all.map(s=>s.deepPct)),
        avgRemPct: avg(all.map(s=>s.remPct)),
        avgRespRate: avg(withResp.map(s=>s.respiratoryRate)),
        avgWristTemp: avg(withTemp.map(s=>s.wristTemp)),
        totalSleep: sum(all.map(s=>s.duration)),
      };

      // Best/worst nights
      const records={
        bestSleep: all.reduce((b,s)=>s.duration>b.duration?s:b),
        worstSleep: all.reduce((b,s)=>s.duration<b.duration&&s.duration>0?s:b),
        mostDeep: all.reduce((b,s)=>s.deep>b.deep?s:b),
        mostRem: all.reduce((b,s)=>s.rem>b.rem?s:b),
        leastAwake: all.filter(s=>s.awake>=0).reduce((b,s)=>s.awake<b.awake?s:b),
      };

      // Weekly aggregates
      const weeks=new Map<string,any[]>();
      for(const s of all){
        const d=new Date(s.date.replace(" ","T").replace(/ ([+-]\d{4})$/,"$1"));
        const sun=new Date(d);sun.setDate(d.getDate()-d.getDay());
        const wk=`${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,"0")}-${String(sun.getDate()).padStart(2,"0")}`;
        if(!weeks.has(wk))weeks.set(wk,[]);
        weeks.get(wk)!.push(s);
      }
      const weeklyStats=Array.from(weeks.entries()).map(([wk,ss])=>({
        week:wk,nights:ss.length,
        avgDuration:avg(ss.map(s=>s.duration)),avgDeep:avg(ss.map(s=>s.deep)),
        avgRem:avg(ss.map(s=>s.rem)),avgCore:avg(ss.map(s=>s.core)),
        avgAwake:avg(ss.map(s=>s.awake)),
        avgDeepPct:avg(ss.map(s=>s.deepPct)),avgRemPct:avg(ss.map(s=>s.remPct)),
      })).sort((a,b)=>a.week.localeCompare(b.week));

      // Monthly aggregates
      const months=new Map<string,any[]>();
      for(const s of all){
        const mo=s.date.slice(0,7);
        if(!months.has(mo))months.set(mo,[]);
        months.get(mo)!.push(s);
      }
      const monthlyStats=Array.from(months.entries()).map(([mo,ss])=>({
        month:mo,nights:ss.length,
        avgDuration:avg(ss.map(s=>s.duration)),avgDeep:avg(ss.map(s=>s.deep)),
        avgRem:avg(ss.map(s=>s.rem)),avgCore:avg(ss.map(s=>s.core)),
        totalSleep:sum(ss.map(s=>s.duration)),
      })).sort((a,b)=>a.month.localeCompare(b.month));

      // Trend data
      const trends=all.map(s=>({date:s.date.slice(0,10),...s}));

      return json({overall,records,weeklyStats,monthlyStats,trends,nights:all.reverse()});
    }
    if (url.pathname === "/api/calendar") {
      const now = new Date();
      const year = parseInt(url.searchParams.get("year") || String(now.getFullYear()));
      const month = parseInt(url.searchParams.get("month") || String(now.getMonth() + 1));
      if (!isValidYearMonth(year, month)) return json({ error: "Invalid year/month" }, 400);
      return json(buildCalendarData(year, month));
    }
    if (url.pathname === "/api/stats") return json(dbStats());

    // Static files — reject any path that escapes PUBLIC_DIR
    const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(PUBLIC_DIR, rawPath);
    if (filePath.startsWith(PUBLIC_DIR + "/") && existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }
    // SPA fallback — serve index.html for unknown routes
    if (existsSync(join(PUBLIC_DIR, "index.html"))) return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
    return new Response("Health dashboard — POST health data to /health", { status: 200 });
  },
});

// Graceful shutdown: flush DB, stop listener, exit cleanly
const shutdown = (signal: string) => {
  console.log(`\n🛑 ${signal} received — shutting down…`);
  try { server.stop(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`🏥 Health server running on http://localhost:${PORT}`);
console.log(`📊 SQLite database: ${DB_PATH}`);
