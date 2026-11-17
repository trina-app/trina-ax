// The nightly backup's schedule (QA TC-4755). The old rule ("20 h since the last one and after the start time") was
// true from the start time until midnight, so the backup time walked 4 h earlier every day: an install at 14:00 ran at
// 14:10, 10:10, 06:10, 03:00, 23:00, 19:00, 15:00, ... and compressed the team folder in working hours. Now: the first
// one right after install, then once a night inside [start, start + 3 h) in the team's zone, or any time when the last
// one is over 30 h old. These tests step a fake clock in 10-minute ticks, like OpsService.start(), for 14 days.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { DAILY_BACKUP_RETRY_MS, DAILY_BACKUP_WINDOW_MIN, OpsService } from '../../server/src/system/ops'
import { zonedParts, zonedToUtc } from '../../server/src/system/time-zone'
import { WORK } from '../lib/env'

const TICK = 10 * 60_000
const dir = path.join(WORK, 'p1-backup-window')
fs.rmSync(dir, { recursive: true, force: true })
const cfg = {
  mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
  teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
  engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
  validateResponses: true, setupToken: null,
} as AppConfig
fs.mkdirSync(cfg.dataDir, { recursive: true })
const db = openDb(path.join(cfg.dataDir, 'app.db'))
afterAll(() => db.close())

type Sim = {
  tz: string
  /** team-local install time */
  install: [number, number, number, number, number]
  /** override of the start minute (a hosted tenant's window from ax-hostd) */
  start?: number
  hosted?: boolean
  /** [from, to) instants when the server is off: no ticks */
  off?: [Date, Date]
  /** the try at this instant fails */
  failAt?: (t: Date, n: number) => boolean
  days?: number
}

/** steps the clock; returns the instants a daily backup was written and the failed tries */
function simulate(s: Sim) {
  updateTeamSettings(db, { timeZone: s.tz })
  cfg.deployment = s.hosted ? 'hosted' : undefined
  let now = zonedToUtc(...s.install, s.tz)
  const ops = new OpsService(createContext({ config: cfg, db, log: silentLogger }), { now: () => now, engines: async () => [] })
  if (s.start !== undefined) ops.backupStartMinute = () => s.start!
  const done: Date[] = [], failed: Date[] = []
  let lastError: { at: string; message: string } | null = null
  const b = ops.backups as unknown as { metas: () => unknown[]; lastError: () => unknown }
  b.metas = () => done.map((t) => ({ kind: 'daily', createdAt: t.toISOString() }))
  b.lastError = () => lastError
  const end = now.getTime() + (s.days ?? 14) * 86400_000
  for (now = new Date(now.getTime() + TICK); now.getTime() < end; now = new Date(now.getTime() + TICK)) {
    if (s.off && now >= s.off[0] && now < s.off[1]) continue
    if (!ops.shouldRunDailyBackup()) continue
    if (s.failAt?.(now, done.length + failed.length)) { failed.push(now); lastError = { at: now.toISOString(), message: 'unreadable' } }
    else done.push(now)
  }
  cfg.deployment = undefined
  return { done, failed, start: ops.backupStartMinute() }
}

const minuteOf = (t: Date, tz: string) => { const p = zonedParts(t, tz); return p.h * 60 + p.min }
const inWindow = (t: Date, tz: string, start: number) => (minuteOf(t, tz) - start + 1440) % 1440 < DAILY_BACKUP_WINDOW_MIN
/** the night a time belongs to: the team-local date of (wall time - start) */
const nightOf = (t: Date, tz: string, start: number) => { const p = zonedParts(t, tz); return new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - start * 60_000).toISOString().slice(0, 10) }

function expectNightly(r: ReturnType<typeof simulate>, tz: string, days = 14) {
  expect(r.done.length).toBeGreaterThanOrEqual(days)
  // the first one right after install (the first tick)
  const rest = r.done.slice(1)
  for (const t of rest) expect({ t: t.toISOString(), inWindow: inWindow(t, tz, r.start) }).toEqual({ t: t.toISOString(), inWindow: true })
  const nights = rest.map((t) => nightOf(t, tz, r.start))
  expect(new Set(nights).size).toBe(nights.length)
}

const zones = ['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/Berlin', 'Asia/Jakarta']
const installHours = [0, 2, 3, 4, 9, 14, 20, 23]

test('every backup after the first starts inside the night window, at most one a night, every night', () => {
  for (const tz of zones) for (const h of installHours) {
    const r = simulate({ tz, install: [2026, 10, 20, h, 0] })
    expect(r.start).toBe(180)
    expect(r.done[0]!.getTime()).toBe(zonedToUtc(2026, 10, 20, h, 0, tz).getTime() + TICK)
    expectNightly(r, tz)
    // 14 days and one backup per night: no gap over a day and a bit
    for (let i = 1; i < r.done.length; i++) expect(r.done[i]!.getTime() - r.done[i - 1]!.getTime()).toBeLessThanOrEqual(27 * 3600_000)
  }
})

test('across the DST changes (Berlin and New York, late March and early November) it runs once a night', () => {
  for (const [tz, y, m, d] of [['Europe/Berlin', 2026, 3, 22], ['Europe/Berlin', 2026, 10, 18], ['America/New_York', 2026, 3, 1], ['America/New_York', 2026, 10, 25]] as const) {
    // 02:00 start: the hour the clocks skip or repeat is inside the window
    for (const start of [120, 180]) expectNightly(simulate({ tz, install: [y, m, d, 14, 0], start }), tz)
  }
})

test('hosted: the tenant window (02:00 + 0–179 min, or the one ax-hostd gave) and a window that crosses midnight', () => {
  const r = simulate({ tz: 'Asia/Seoul', install: [2026, 10, 20, 14, 0], hosted: true })
  expect(r.start).toBeGreaterThanOrEqual(120)
  expect(r.start).toBeLessThan(300)
  expectNightly(r, 'Asia/Seoul')
  for (const start of [120, 299, 22 * 60, 23 * 60 + 30, 1439]) for (const h of [0, 14, 23]) {
    const w = simulate({ tz: 'Asia/Jakarta', install: [2026, 10, 20, h, 0], start, hosted: true })
    expect(w.start).toBe(start)
    expectNightly(w, 'Asia/Jakarta')
  }
})

test('catch-up: after a 2-day outage the backup runs as soon as the server is back, then nightly again', () => {
  const tz = 'Asia/Seoul'
  const off: [Date, Date] = [zonedToUtc(2026, 10, 23, 12, 0, tz), zonedToUtc(2026, 10, 25, 11, 0, tz)]
  const r = simulate({ tz, install: [2026, 10, 20, 14, 0], off })
  const back = r.done.find((t) => t >= off[1])!
  expect(back.getTime()).toBe(off[1].getTime()) // the first tick after the outage (11:00, outside the window)
  expect(inWindow(back, tz, 180)).toBe(false)
  const later = r.done.filter((t) => t > back)
  expect(later.length).toBeGreaterThanOrEqual(8)
  for (const t of later) expect(inWindow(t, tz, 180)).toBe(true)
})

test('a server that is off every night: catch-up about every 30 h', () => {
  const tz = 'UTC'
  updateTeamSettings(db, { timeZone: tz })
  let now = zonedToUtc(2026, 10, 20, 9, 0, tz)
  const ops = new OpsService(createContext({ config: cfg, db, log: silentLogger }), { now: () => now, engines: async () => [] })
  const done: Date[] = []
  const b = ops.backups as unknown as { metas: () => unknown[]; lastError: () => unknown }
  b.metas = () => done.map((t) => ({ kind: 'daily', createdAt: t.toISOString() }))
  b.lastError = () => null
  const end = now.getTime() + 7 * 86400_000
  for (; now.getTime() < end; now = new Date(now.getTime() + TICK)) {
    const h = zonedParts(now, tz).h
    if (h < 8 || h >= 18) continue // on 08:00–18:00 only
    if (ops.shouldRunDailyBackup()) done.push(now)
  }
  expect(done.length).toBeGreaterThanOrEqual(5)
  for (let i = 1; i < done.length; i++) expect(done[i]!.getTime() - done[i - 1]!.getTime()).toBeLessThanOrEqual(48 * 3600_000)
})

test('a failed try waits an hour, then tries again (inside the window: still that night)', () => {
  const tz = 'Asia/Seoul'
  // the 2nd try (the first nightly one) fails twice
  const r = simulate({ tz, install: [2026, 10, 20, 14, 0], failAt: (_t, n) => n === 1 || n === 2 })
  expect(r.failed.length).toBe(2)
  expect(r.failed[1]!.getTime() - r.failed[0]!.getTime()).toBe(DAILY_BACKUP_RETRY_MS)
  const next = r.done[1]!
  expect(next.getTime() - r.failed[1]!.getTime()).toBe(DAILY_BACKUP_RETRY_MS)
  expect(inWindow(next, tz, 180)).toBe(true)
  expect(nightOf(next, tz, 180)).toBe(nightOf(r.failed[0]!, tz, 180))
  expectNightly(r, tz)
  // the very first backup failing waits an hour too
  const first = simulate({ tz, install: [2026, 10, 20, 14, 0], failAt: (_t, n) => n === 0, days: 1 })
  expect(first.done[0]!.getTime() - first.failed[0]!.getTime()).toBe(DAILY_BACKUP_RETRY_MS)
})
