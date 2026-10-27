// The team's time zone (L06, review UX-06): a Linux server runs in UTC, a Korean team's day starts at 00:00 KST. Team
// setting timeZone (setup sends the browser's; Admin > Settings), default MYCEL_TEAM_TZ > the process's zone > UTC.
// Budgets' day / month, usage per day, schedules, conflict-copy names, the nightly backup and the engines' TZ follow it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { periodEnd, periodStart } from '../../server/src/admin/budgets'
import { getTeamSettings, setSetting, teamTimeZone } from '../../server/src/admin/settings'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { buildClaudeLaunch } from '../../server/src/engine/claude'
import { buildCodexLaunch } from '../../server/src/engine/codex'
import { conflictCopyName } from '../../server/src/files/store'
import { defaultTimeZone, engineTimeZone, isValidTimeZone, processTimeZone, setTeamTimeZoneSource, zonedDay } from '../../server/src/system/time-zone'
import { openDb } from '../../server/src/db'
import { SETUP_TOKEN, harness, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const SEOUL = 'Asia/Seoul'

describe('zone arithmetic', () => {
  test('day and month boundaries of Asia/Seoul while the clock reads UTC', () => {
    const now = new Date('2026-10-21T20:00:00Z') // 05:00 on the 22nd in Seoul
    expect(periodStart('day', now, SEOUL).toISOString()).toBe('2026-10-21T15:00:00.000Z')
    expect(periodStart('month', now, SEOUL).toISOString()).toBe('2026-09-30T15:00:00.000Z')
    expect(periodEnd('day', now, SEOUL).toISOString()).toBe('2026-10-22T15:00:00.000Z')
    expect(periodEnd('month', now, SEOUL).toISOString()).toBe('2026-10-31T15:00:00.000Z')
    // year end and a DST zone
    expect(periodEnd('month', new Date('2026-12-31T10:00:00Z'), SEOUL).toISOString()).toBe('2026-12-31T15:00:00.000Z')
    expect(periodEnd('month', new Date('2026-12-31T20:00:00Z'), SEOUL).toISOString()).toBe('2027-01-31T15:00:00.000Z') // already January in Seoul
    expect(periodEnd('month', new Date('2027-01-01T01:00:00Z'), SEOUL).toISOString()).toBe('2027-01-31T15:00:00.000Z')
    expect(periodStart('day', new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(periodEnd('day', new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(zonedDay(now, SEOUL)).toBe('2026-10-22')
    expect(zonedDay(now, 'UTC')).toBe('2026-10-21')
  })
  test('without a zone the old behaviour (the process\'s midnight)', () => {
    const now = new Date(2026, 9, 21, 15, 30)
    expect(periodStart('day', now).getTime()).toBe(new Date(2026, 9, 21).getTime())
    expect(periodEnd('month', now).getTime()).toBe(new Date(2026, 10, 1).getTime())
  })
  test('valid names, defaults', () => {
    expect(isValidTimeZone(SEOUL)).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(defaultTimeZone({ MYCEL_TEAM_TZ: 'Asia/Jakarta' })).toBe('Asia/Jakarta')
    expect(defaultTimeZone({ MYCEL_TEAM_TZ: 'nope' })).toBe(processTimeZone())
    expect(defaultTimeZone({})).toBe(processTimeZone())
  })
  test('conflict copies are named in the team\'s zone', () => {
    const d = new Date('2026-10-21T20:05:00Z')
    expect(conflictCopyName('a.md', 'Olga', d, 'en', SEOUL)).toBe('a (conflict copy - Olga 2026-10-22 05.05).md')
    expect(conflictCopyName('a.md', 'Olga', d, 'ko', 'UTC')).toBe('a (충돌 사본 - Olga 2026-10-21 20.05).md')
  })
  test('the engines get TZ when the team\'s zone differs from the process\'s (a Mac\'s launch request stays as it was)', () => {
    const other = processTimeZone() === 'Pacific/Kiritimati' ? 'Pacific/Chatham' : 'Pacific/Kiritimati'
    const claude = () => buildClaudeLaunch({ turnId: 't', chatDir: path.join(os.tmpdir(), 'c'), token: 'k', systemPrompt: 's', message: 'm', sessionId: 'x', resume: false, stash: null, maxTurns: 1, timeoutMs: 1 },
      { bin: 'c', authMode: 'managed', agentHome: '/a', modelProxy: { baseUrl: 'http://127.0.0.1:9' } })
    const codex = () => buildCodexLaunch({ turnId: 't', chatDir: path.join(os.tmpdir(), 'c'), token: 'k', systemPrompt: 's', message: 'm', timeoutMs: 1 },
      { bin: '/x/codex', codexHome: '/h', agentHome: '/a', catalog: '/cat.json', model: 'm', auth: 'dev-owner-symlink' })
    try {
      setTeamTimeZoneSource(() => other)
      expect(engineTimeZone()).toBe(other)
      expect(claude().env.TZ).toBe(other)
      expect(codex().env.TZ).toBe(other)
      setTeamTimeZoneSource(() => processTimeZone())
      expect(claude().env.TZ).toBeUndefined()
      expect(codex().env.TZ).toBeUndefined()
      setTeamTimeZoneSource(() => 'not/a-zone')
      expect(engineTimeZone()).toBeNull()
    } finally { setTeamTimeZoneSource(null) }
  })
  test('teamTimeZone: the setting, else MYCEL_TEAM_TZ; an unknown stored name falls back', () => {
    const db = openDb(path.join(WORK, 'g-timezone-db', 'app.db'))
    const before = process.env.MYCEL_TEAM_TZ
    try {
      process.env.MYCEL_TEAM_TZ = 'Asia/Jakarta'
      expect(teamTimeZone(db)).toBe('Asia/Jakarta')
      expect(getTeamSettings(db).timeZone).toBe('Asia/Jakarta')
      const db2 = openDb(path.join(WORK, 'g-timezone-db2', 'app.db'))
      setSetting(db2, 'timeZone', 'Mars/Olympus')
      expect(teamTimeZone(db2)).toBe('Asia/Jakarta')
      expect(getTeamSettings(db2).timeZone).toBe('Asia/Jakarta')
      db2.close()
    } finally { if (before === undefined) delete process.env.MYCEL_TEAM_TZ; else process.env.MYCEL_TEAM_TZ = before; db.close() }
  })
})

describe('hosted: the zone chosen at sign-up stays (MYCEL_TEAM_TZ), the setup page\'s browser zone does not replace it', () => {
  test('setup on a hosted server keeps MYCEL_TEAM_TZ; the owner can change it afterwards', async () => {
    const before = process.env.MYCEL_TEAM_TZ
    process.env.MYCEL_TEAM_TZ = 'Asia/Jakarta'
    const h = await harness('g-timezone-hosted', { deployment: 'hosted' })
    try {
      const owner = h.client()
      await owner.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'id', timeZone: SEOUL, owner: { username: 'olga', name: 'Olga', password: 'owner horse battery 42' } })
      expect((await owner.call('GET', '/api/admin/settings')).timeZone).toBe('Asia/Jakarta')
      await owner.call('PATCH', '/api/admin/settings', { timeZone: SEOUL })
      expect((await owner.call('GET', '/api/admin/settings')).timeZone).toBe(SEOUL)
    } finally {
      h.close()
      if (before === undefined) delete process.env.MYCEL_TEAM_TZ; else process.env.MYCEL_TEAM_TZ = before
    }
  })
})

describe('through the app', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('g-timezone')
    owner = h.client()
    // the setup page sends the browser's zone
    await owner.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'ko', timeZone: SEOUL, owner: { username: 'olga', name: 'Olga', password: 'owner horse battery 42' } })
  })
  afterAll(() => h.close())

  test('setup stored it; settings show it; an unknown zone is refused (400)', async () => {
    expect((await owner.call('GET', '/api/admin/settings')).timeZone).toBe(SEOUL)
    expect((await owner.call('GET', '/api/me')).server.timeZone).toBe(SEOUL)
    expect((await owner.try('PATCH', '/api/admin/settings', { timeZone: 'Mars/Olympus' })).status).toBe(400)
  })
  test('budgets count from 00:00 in the team\'s zone', async () => {
    const start = periodStart('day', new Date(), SEOUL)
    const ins = h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, input_tokens, output_tokens) VALUES (?, 'c1', 'olga', 'claude-code', 'done', ?, ?, 0)")
    ins.run('01900000-0000-7000-8000-000000000001', new Date(start.getTime() - 60_000).toISOString(), 1000) // yesterday in Seoul
    ins.run('01900000-0000-7000-8000-000000000002', new Date(start.getTime() + 60_000).toISOString(), 7)
    const b = await owner.call('POST', '/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'day', limitUsd: 0, limitTokens: 100, action: 'warn' })
    expect(b.usedTokens).toBe(7)
    const usage = await owner.call('GET', `/api/admin/usage?groupBy=day&from=${new Date(start.getTime() - 3_600_000).toISOString()}&to=${new Date(start.getTime() + 3_600_000).toISOString()}`)
    expect(usage.rows.map((r: { key: string }) => r.key)).toEqual([zonedDay(new Date(start.getTime() - 60_000), SEOUL), zonedDay(new Date(start.getTime() + 60_000), SEOUL)])
  })
  test('changing the zone moves the enabled schedules to their times in the new zone', async () => {
    const rt = getChatRuntime(h.ctx)
    expect(rt.timeZone).toBe(SEOUL)
    const s = rt.schedules.create('olga', { title: 'Digest', prompt: 'summarize the week', repeat: 'daily', time: '09:00' })
    const seoulNext = new Date(s.next_run_at!)
    expect(seoulNext.getUTCHours()).toBe(0) // 09:00 KST
    await owner.call('PATCH', '/api/admin/settings', { timeZone: 'UTC' })
    expect(rt.timeZone).toBe('UTC')
    expect(new Date(rt.schedules.get('olga', s.id)!.next_run_at!).getUTCHours()).toBe(9)
    await owner.call('PATCH', '/api/admin/settings', { timeZone: SEOUL })
  })
})
