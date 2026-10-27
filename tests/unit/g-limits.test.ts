// The plan file and what it limits (server/src/system/limits.ts, docs/DECISIONS.md "클라우드 리눅스 서버"): the derived
// memory numbers, answers at the same time (L05, SEC-03), seats (BIZ-01, UX-14), thread caps, the read and in-process
// parse limits (L10), local backup retention (L09). Without a plan file nothing changes on a Mac.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { extractText, TOO_BIG_IN_PROCESS } from '../../server/src/files/extract'
import { rgArgv } from '../../server/src/files/search'
import {
  Plan, backupRetentionDays, concurrencyMax, configurePlan, cpuBudget, currentPlan, effectiveConcurrency, inProcessParseMax, limitsActive, onnxThreads,
  planFileProblem, planLimits, readMaxBytes, rgThreads, seatsUsed, setLimitsPlatformForTests, setPlanForTests, typstJobs, whisperThreads,
} from '../../server/src/system/limits'
import { setSetting } from '../../server/src/admin/settings'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-limits')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

const plan = (o: Partial<Plan> = {}): Plan => Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, ...o })
afterEach(() => { setPlanForTests(undefined); setLimitsPlatformForTests(null); configurePlan({ file: null }) })

describe('plan file', () => {
  test('the derived numbers of the hypothetical plans (Basic / Team / Pro)', () => {
    expect(planLimits(plan({ memoryMiB: 2048, maxConcurrency: 2 }))).toMatchObject({ turnBudgetMiB: 1280, turnMaxMiB: 800, turnHighMiB: 680, convMiB: 512 })
    expect(planLimits(plan({ memoryMiB: 4096, maxConcurrency: 3 }))).toMatchObject({ turnBudgetMiB: 3328, turnMaxMiB: 1387, turnHighMiB: 1178, convMiB: 1024 })
    expect(planLimits(plan({ memoryMiB: 8192, maxConcurrency: 6 }))).toMatchObject({ turnBudgetMiB: 7424, turnMaxMiB: 1536, turnHighMiB: 1305, convMiB: 1536 })
    expect(planLimits(plan({ memoryMiB: 4096, turnMemoryMaxMiB: 900, convMemoryMaxMiB: 700 }))).toMatchObject({ turnMaxMiB: 900, convMiB: 700, serverMemoryMaxMiB: 768 + 700 })
  })
  test('ranges are checked; unknown fields (the launcher\'s) are ignored', () => {
    expect(Plan.safeParse({ format: 1, plan: 'x', maxConcurrency: 17, memoryMiB: 4096, cpuCores: 2, diskGiB: 50 }).success).toBe(false)
    expect(Plan.safeParse({ format: 1, plan: 'x', maxConcurrency: 2, memoryMiB: 512, cpuCores: 2, diskGiB: 50 }).success).toBe(false)
    expect(Plan.safeParse({ format: 1, plan: 'x', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20, links: { account: 'http://x.example', status: 'https://s.example', support: 'help@x.example' } }).success).toBe(false)
    expect(Plan.parse({ format: 1, plan: 'x', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20, launcherOnly: 1 })).toMatchObject({ readMaxMiB: 200, localBackupRetentionDays: 14, maxActiveMembers: null, links: null })
    // the Go reader's range (native/internal/plan): a plan mycel-ctl apply-plan would refuse is refused here too
    expect(Plan.safeParse({ format: 1, plan: 'x', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20, turnPidsMax: 32 }).success).toBe(false)
  })
  test('read from the file, again when it changes; a broken write keeps the last good plan', () => {
    const f = path.join(W, 'plan.json')
    fs.writeFileSync(f, JSON.stringify({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 1, diskGiB: 20, maxActiveMembers: 5 }))
    configurePlan({ file: f })
    expect(currentPlan()).toMatchObject({ plan: 'basic', maxActiveMembers: 5 })
    expect(planFileProblem()).toBeNull()
    fs.writeFileSync(f, JSON.stringify({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50 }))
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(currentPlan(Date.now() + 61_000)?.plan).toBe('team')
    fs.writeFileSync(f, '{ broken')
    fs.utimesSync(f, new Date(), new Date(Date.now() + 10_000))
    expect(currentPlan(Date.now() + 130_000)?.plan).toBe('team')
    expect(planFileProblem()?.error).toContain('JSON')
    fs.rmSync(f)
    expect(currentPlan(Date.now() + 200_000)).toBeNull()
  })
})

describe('resource caps (L10)', () => {
  test('a Mac without a plan keeps today\'s behaviour', () => {
    setLimitsPlatformForTests('darwin')
    setPlanForTests(null)
    expect(limitsActive()).toBe(false)
    expect(rgThreads()).toBeNull()
    expect(rgArgv('/bin/rg', ['--files'])).toEqual(['/bin/rg', '--files'])
    expect(onnxThreads()).toBeNull()
    expect(typstJobs()).toBeNull()
    expect(inProcessParseMax()).toBe(Infinity)
    expect(readMaxBytes()).toBe(200 * 1024 * 1024)
    expect(backupRetentionDays()).toBe(14)
    expect(concurrencyMax()).toBe(16)
  })
  test('Linux, or a plan: the caps', () => {
    setLimitsPlatformForTests('linux')
    setPlanForTests(plan({ cpuCores: 4, readMaxMiB: 64, localBackupRetentionDays: 3 }))
    expect(cpuBudget()).toBeLessThanOrEqual(4)
    expect(rgThreads()).toBe(Math.min(2, cpuBudget()))
    expect(rgArgv('/bin/rg', ['--files'])).toEqual(['/bin/rg', '--threads', String(Math.min(2, cpuBudget())), '--files'])
    expect(whisperThreads()).toBe(Math.max(1, Math.min(4, cpuBudget() - 1)))
    expect(onnxThreads()).toEqual({ intraOpNumThreads: Math.min(2, cpuBudget()), interOpNumThreads: 1 })
    expect(typstJobs()).toBe(2)
    expect(inProcessParseMax()).toBe(32 * 1024 * 1024)
    expect(readMaxBytes()).toBe(64 * 1024 * 1024)
    expect(backupRetentionDays()).toBe(3)
    setPlanForTests(plan({ cpuCores: 1 }))
    expect(whisperThreads()).toBe(1)
    expect(rgThreads()).toBe(1)
  })
  test('spreadsheets and Hangul files above 32 MB are not parsed in the server process (where limits apply)', async () => {
    setLimitsPlatformForTests('linux')
    const big = new Uint8Array(33 * 1024 * 1024)
    for (const name of ['a.xlsx', 'a.xls', 'a.ods', 'a.hwp', 'a.hwpx']) await expect(extractText(name, big, { pandoc: null, pdftotext: null })).rejects.toThrow(TOO_BIG_IN_PROCESS)
    setLimitsPlatformForTests('darwin')
    setPlanForTests(null)
    // no cap on a Mac without a plan: the parser itself decides (this zero-filled file is no workbook)
    await expect(extractText('a.hwp', big, { pandoc: null, pdftotext: null })).rejects.not.toThrow(TOO_BIG_IN_PROCESS)
  })
})

describe('answers at the same time (L05, SEC-03)', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('g-limits-conc'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('effective = min(admin setting, plan); the stored setting stays', () => {
    setSetting(h.ctx.db, 'concurrency', 8)
    expect(effectiveConcurrency(h.ctx.db)).toBe(8)
    setPlanForTests(plan({ maxConcurrency: 3 }))
    expect(effectiveConcurrency(h.ctx.db)).toBe(3)
    setPlanForTests(null)
    expect(effectiveConcurrency(h.ctx.db)).toBe(8)
    setSetting(h.ctx.db, 'concurrency', 3)
  })
  test('Admin > AI engines shows the plan maximum; PATCH above it is refused with 409 plan_limit (engines and settings)', async () => {
    setPlanForTests(plan({ maxConcurrency: 3 }))
    expect((await owner.call('GET', '/api/admin/engines')).concurrencyMax).toBe(3)
    const over = await owner.try('PATCH', '/api/admin/engines', { concurrency: 4 })
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe('plan_limit')
    expect(over.body.error.params).toMatchObject({ reason: 'concurrency_over_plan', max: 3 })
    expect(over.body.error.message).toContain('3')
    expect((await owner.try('PATCH', '/api/admin/settings', { concurrency: 5 })).status).toBe(409)
    expect((await owner.try('PATCH', '/api/admin/engines', { concurrency: 2 })).status).toBe(200)
    setPlanForTests(null)
    expect((await owner.call('GET', '/api/admin/engines')).concurrencyMax).toBe(16)
    expect((await owner.try('PATCH', '/api/admin/engines', { concurrency: 12 })).status).toBe(200)
  })
})

describe('seats (BIZ-01, UX-14)', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('g-limits-seats'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('invite, direct add, accepting an invite and enabling an account again stop at the plan\'s seats (409, plan link)', async () => {
    const m1 = await addMember(h, owner, { username: 'mina' })
    setPlanForTests(plan({ maxActiveMembers: 3, links: { account: 'https://app.teamax.example/billing', status: 'https://status.teamax.example', support: 'support@teamax.example' } }))
    expect(seatsUsed(h.ctx.db)).toBe(2)
    const inv = await owner.call('POST', '/api/admin/invites', { role: 'member' })
    await addMember(h, owner, { username: 'nora' }) // the third seat
    // a link made while a seat was free: accepting it now is refused, the link stays unused
    const anon = h.client()
    const acc = await anon.try('POST', `/api/invites/${inv.token}/accept`, { username: 'otto', name: 'Otto', password: 'quiet river stone 9' })
    expect(acc.status).toBe(409)
    expect(acc.body.error.code).toBe('plan_limit')
    expect(acc.body.error.params).toMatchObject({ reason: 'seat_limit', limit: 3, manageUrl: 'https://app.teamax.example/billing' })
    expect(acc.body.error.message).toContain('3')
    expect((await owner.call('GET', '/api/admin/invites')).items.find((i: any) => i.id === inv.invite.id).usedAt).toBeNull()
    expect((await owner.try('POST', '/api/admin/invites', { role: 'member' })).status).toBe(409)
    const add = await owner.try('POST', '/api/admin/users', { username: 'paul', name: 'Paul', role: 'member' })
    expect(add.status).toBe(409)
    expect(add.body.error.params.reason).toBe('seat_limit')
    // disabled accounts do not count: disabling one frees a seat, enabling it again needs a free one
    await owner.call('PATCH', `/api/admin/users/${m1.id}`, { status: 'disabled' })
    expect(seatsUsed(h.ctx.db)).toBe(2)
    expect((await anon.try('POST', `/api/invites/${inv.token}/accept`, { username: 'otto', name: 'Otto', password: 'quiet river stone 9' })).status).toBe(201)
    const again = await owner.try('PATCH', `/api/admin/users/${m1.id}`, { status: 'active' })
    expect(again.status).toBe(409)
    // without a plan there is no limit (self-hosted)
    setPlanForTests(null)
    expect((await owner.try('PATCH', `/api/admin/users/${m1.id}`, { status: 'active' })).status).toBe(200)
    expect(OWNER_PW.length).toBeGreaterThan(0)
  })
  test('the message is in the person\'s language', async () => {
    setPlanForTests(plan({ maxActiveMembers: 1 }))
    await owner.call('PATCH', '/api/me', { locale: 'en' })
    const r = await owner.try('POST', '/api/admin/invites', { role: 'member' })
    expect(r.body.error.message).toContain('member limit (1)')
    await owner.call('PATCH', '/api/me', { locale: 'id' })
    expect((await owner.try('POST', '/api/admin/invites', { role: 'member' })).body.error.message).toContain('Batas anggota')
  })
})
