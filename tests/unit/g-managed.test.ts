// The hosted service's files for the team server (control-plane 3.5.6, SV-1 / SV-2; server/src/system/managed.ts):
// notices.json read by mtime and on SIGHUP, the last good file kept when a write is broken, notices by role and time,
// GET /api/managed/notices and GET /api/admin/plan, and a self-hosted server without the files (nothing changes).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { NoticesFile } from '@mycel/shared/cloud-protocol'
import { Plan, configurePlan, currentPlan, setPlanForTests } from '../../server/src/system/limits'
import { configureNotices, currentNotices, noticesFileProblem, noticesFor, reloadManagedFiles, setNoticesForTests } from '../../server/src/system/managed'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-managed')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

const T = (s: string) => ({ ko: `${s} (ko)`, en: `${s} (en)`, id: `${s} (id)` })
const FILE: NoticesFile = {
  format: 1, issuedAt: '2026-10-22T00:00:00Z',
  notices: [
    { id: 'maint', level: 'info', audience: 'everyone', text: T('maintenance tonight'), link: 'https://status.treesoop.com', until: null },
    { id: 'billing', level: 'warn', audience: 'admins', text: T('payment failed'), link: 'https://account.treesoop.com/billing', until: null },
    { id: 'grant', level: 'critical', audience: 'owner', text: T('support has access'), link: null, until: null },
    { id: 'old', level: 'critical', audience: 'everyone', text: T('expired'), link: null, until: '2026-01-01T00:00:00Z' },
  ],
}
const PLAN = Plan.parse({
  format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 3, diskGiB: 50, localBackupRetentionDays: 3,
  updatedAt: '2026-10-22T00:00:00Z', maxActiveMembers: 12, display: { name: { ko: '팀', en: 'Team', id: 'Tim' } },
  links: { account: 'https://account.treesoop.com', status: 'https://status.treesoop.com', support: 'support@treesoop.com' },
})

afterEach(() => { setNoticesForTests(undefined); setPlanForTests(undefined); configureNotices({ file: null }); configurePlan({ file: null }) })

describe('notices.json (server/src/system/managed.ts)', () => {
  test('no file: no notices (a self-hosted server)', () => {
    configureNotices({ file: path.join(W, 'none.json') })
    expect(currentNotices()).toBeNull()
    expect(noticesFor('owner', 'ko')).toEqual([])
    expect(noticesFileProblem()).toBeNull()
  })
  test('read by mtime; a broken write keeps the last good notices and is reported; SIGHUP reads again at once', () => {
    const f = path.join(W, 'notices.json')
    fs.writeFileSync(f, JSON.stringify(FILE))
    configureNotices({ file: f })
    const t0 = Date.now()
    expect(currentNotices(t0)?.notices.map((n) => n.id)).toEqual(['maint', 'billing', 'grant', 'old'])
    // a change inside the 30 s window is not seen yet; SIGHUP (mycel-ctl notices-set) makes the next read look
    fs.writeFileSync(f, JSON.stringify({ ...FILE, notices: FILE.notices.slice(0, 1) }))
    fs.utimesSync(f, new Date(), new Date(t0 + 5000))
    expect(currentNotices(t0 + 1000)?.notices).toHaveLength(4)
    reloadManagedFiles()
    expect(currentNotices(t0 + 2000)?.notices).toHaveLength(1)
    // a broken write: the previous notices stay, Diagnostics says why
    fs.writeFileSync(f, JSON.stringify({ ...FILE, notices: [{ ...FILE.notices[0], level: 'shout' }] }))
    fs.utimesSync(f, new Date(), new Date(t0 + 10_000))
    expect(currentNotices(t0 + 40_000)?.notices).toHaveLength(1)
    expect(noticesFileProblem()?.error).toContain('level')
    // removed: no notices any more
    fs.rmSync(f)
    expect(currentNotices(t0 + 80_000)).toBeNull()
    expect(noticesFileProblem()).toBeNull()
  })
  test('by role and time, critical first, in the caller\'s language; only critical ones cannot be hidden', () => {
    setNoticesForTests(FILE)
    const now = Date.parse('2026-10-22T12:00:00Z')
    expect(noticesFor('member', 'en', now).map((n) => n.id)).toEqual(['maint'])
    expect(noticesFor('admin', 'en', now).map((n) => n.id)).toEqual(['billing', 'maint'])
    const owner = noticesFor('owner', 'ko', now)
    expect(owner.map((n) => [n.id, n.dismissible])).toEqual([['grant', false], ['billing', true], ['maint', true]])
    expect(owner[2]).toEqual({ id: 'maint', level: 'info', text: 'maintenance tonight (ko)', link: 'https://status.treesoop.com', until: null, dismissible: true })
    expect(noticesFor('owner', 'id', Date.parse('2025-12-31T00:00:00Z')).map((n) => n.id)).toContain('old')
  })
})

describe('GET /api/managed/notices and GET /api/admin/plan', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let member: Client
  beforeAll(async () => {
    h = await harness('g-managed-api')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    member = (await addMember(h, owner, { username: 'mina' })).client
  })
  afterAll(() => h.close())

  test('notices by role; none without the file', async () => {
    expect((await member.call('GET', '/api/managed/notices')).items).toEqual([])
    setNoticesForTests(FILE)
    expect((await member.call('GET', '/api/managed/notices')).items.map((n: { id: string }) => n.id)).toEqual(['maint'])
    expect((await admin.call('GET', '/api/managed/notices')).items.map((n: { id: string }) => n.id)).toEqual(['billing', 'maint'])
    const o = (await owner.call('GET', '/api/managed/notices')).items
    expect(o.map((n: { id: string }) => n.id)).toEqual(['grant', 'billing', 'maint'])
    expect(o[0].dismissible).toBe(false)
    expect((await h.client().try('GET', '/api/managed/notices')).status).toBe(401)
  })

  test('the plan card: limits and use for owner and admins, members refused; null without a plan', async () => {
    expect((await owner.call('GET', '/api/admin/plan')).plan).toBeNull()
    setPlanForTests(PLAN)
    await owner.call('PATCH', '/api/me', { locale: 'en' })
    const p = (await owner.call('GET', '/api/admin/plan')).plan
    expect(p).toEqual({
      id: 'team', name: 'Team', maxConcurrency: 3, concurrency: 3, maxActiveMembers: 12, activeMembers: 3, diskGiB: 50,
      memoryMiB: 4096, cpuCores: 3, localBackupRetentionDays: 3, links: PLAN.links, updatedAt: '2026-10-22T00:00:00Z',
    })
    expect((await admin.call('GET', '/api/admin/plan')).plan.name).toBe('팀') // the admin's own language
    expect((await member.try('GET', '/api/admin/plan')).status).toBe(403)
    // a plan written by the linux runtime alone (no display, links, seats): the id is the name
    setPlanForTests(Plan.parse({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20 }))
    expect((await owner.call('GET', '/api/admin/plan')).plan).toMatchObject({ id: 'basic', name: 'basic', maxActiveMembers: null, links: null, updatedAt: null, concurrency: 2 })
    expect(currentPlan()?.plan).toBe('basic')
  })
})
