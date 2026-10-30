// QA 2026-10-30 (first real-engine run on a Linux server), safe operations 1A:
//   B3: tries refused before any conversion do not use the hourly / per-reply slots, and every refusal says what it is
//       (busy, cleanup, the hourly limit with the minutes to wait, the per-reply limit, the budget)
//   D1: a conversation stays confidential after 1A is turned off only when a 1A workflow was admitted in it
//       (migration 323 for the rows written before; fail-closed when unsure)
//   B1: the readiness check names what is missing (root-owned programs, the bounded group)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { makeHandler } from '../../server/src/mcp/protocol'
import { confidentialChat } from '../../server/src/safe-ops/confidential'
import { withWorkflow, reserveJob, WORKFLOW_LIMITS } from '../../server/src/safe-ops/workflow'
import { SAFE_OPS_TEXT, SAFE_ERROR_KEYS, SafeOpsError, safeText, toolErrorText } from '../../server/src/safe-ops/strings'
import { safeOpsReadiness, safeProgram, untrusted } from '../../server/src/safe-ops/ready'
import { ToolError } from '../../server/src/policy/errors'
import { MIGRATIONS_DIR, migrate, openDb } from '../../server/src/db'

let A: CApp
beforeAll(async () => { A = await makeCApp('safe-ops-qa') })
afterAll(async () => { delete process.env.MYCEL_SAFE_OPS_1A; await A.close() })
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof ToolError ? e.code : String(e) } }
const workflows = (user: string) => A.ctx.db.query('SELECT state, jobs FROM safe_ops_workflows WHERE user_id=? ORDER BY created').all(user) as { state: string; jobs: number }[]

describe('B3: workflow admission', () => {
  test('a try refused before converting anything does not count; one that converted does', async () => {
    for (let i = 0; i < WORKFLOW_LIMITS.perUserHour + 3; i++) {
      // a new reply each time (the per-reply limit is 4): not ready, nothing converted
      const c = A.toolCtx('bob', A.turn('bob', A.chat('bob')))
      expect(await code(withWorkflow(A.ctx.files, c, async () => { throw new ToolError('not ready', 'safe_ops_not_ready_group') }))).toBe('safe_ops_not_ready_group')
    }
    expect(workflows('bob').every((w) => w.state === 'done' && w.jobs === 0)).toBe(true)
    // 8 that did work fill the hour
    for (let i = 0; i < WORKFLOW_LIMITS.perUserHour; i++) {
      const c = A.toolCtx('bob', A.turn('bob', A.chat('bob')))
      await withWorkflow(A.ctx.files, c, async () => { reserveJob(crypto.randomUUID(), '/unused', path.join(A.data, 'unused'), 1).finish(true) })
    }
    const c = A.toolCtx('bob', A.turn('bob', A.chat('bob')))
    let err: unknown
    try { await withWorkflow(A.ctx.files, c, async () => {}) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SafeOpsError)
    expect((err as SafeOpsError).code).toBe('safe_ops_hour_limit')
    expect((err as SafeOpsError).vars.minutes).toBeGreaterThanOrEqual(59)
    // the person reads the limit and the wait, not "limit or cleanup"
    A.ctx.db.query("UPDATE users SET locale='ko' WHERE id='bob'").run()
    const ko = toolErrorText(A.ctx.db, 'bob', err as ToolError)
    expect(ko).toContain('1시간에 8번')
    expect(ko).toMatch(/약 (59|60)분 뒤/)
    expect(ko).not.toContain('{minutes}')
    A.ctx.db.query("UPDATE users SET locale='en' WHERE id='bob'").run()
  })

  test('per-reply limit, busy and cleanup each have their own code and words', async () => {
    const turn = A.turn('carol', A.chat('carol'))
    for (let i = 0; i < WORKFLOW_LIMITS.perTurn; i++)
      await withWorkflow(A.ctx.files, A.toolCtx('carol', turn), async () => { reserveJob(crypto.randomUUID(), '/unused', path.join(A.data, 'unused'), 1).finish(true) })
    expect(await code(withWorkflow(A.ctx.files, A.toolCtx('carol', turn), async () => {}))).toBe('safe_ops_turn_limit')
    // one workflow at a time on the server: the second is "busy", not "limit or cleanup"
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((r) => (started = r))
    const p = withWorkflow(A.ctx.files, A.toolCtx('dana', A.turn('dana', A.chat('dana'))), async () => { started(); await new Promise<void>((r) => (release = r)) })
    await ready
    expect(await code(withWorkflow(A.ctx.files, A.toolCtx('erin', A.turn('erin', A.chat('erin'))), async () => {}))).toBe('safe_ops_busy')
    release(); await p
    // unfinished cleanup: "cleanup", with the administrator's next step
    await withWorkflow(A.ctx.files, A.toolCtx('carol', A.turn('carol', A.chat('carol'))), async () => { reserveJob(crypto.randomUUID(), path.join(A.data, 'no-cgroup'), path.join(A.data, 'safe-ops-jobs'), 1).finish(false) })
    try {
      expect(await code(withWorkflow(A.ctx.files, A.toolCtx('erin'), async () => {}))).toBe('safe_ops_cleanup')
      expect(safeText(A.ctx.db, 'erin', 'cleanup')).toContain('docs/SAFE-OPS-1A.md')
    } finally {
      A.ctx.db.query("UPDATE safe_ops_workflows SET state='aborted', debt_bytes=0 WHERE state='debt'").run()
    }
  })

  test('every refusal code has its own text in all five languages', () => {
    const keys = Object.values(SAFE_ERROR_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of ['cleanup', 'hourLimit', 'turnLimit', 'budget', 'notReadyGroup', 'notReadyPrograms', 'groupMemory'] as const)
      for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(SAFE_OPS_TEXT[k][l].length).toBeGreaterThan(40)
    // the old text that mixed both causes is gone
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(SAFE_OPS_TEXT.workflow[l]).not.toMatch(/cleanup|정리|limpieza|pembersihan|後処理/)
  })
})

describe('D1: the confidential lock stays only where 1A worked', () => {
  test('with 1A on every conversation is local; after off only the one with an admitted workflow stays local', async () => {
    process.env.MYCEL_SAFE_OPS_1A = '1'
    const plain = A.chat('alice'), plainTurn = A.turn('alice', plain)
    const worked = A.chat('alice'), workedTurn = A.turn('alice', worked)
    const refused = A.chat('alice'), refusedTurn = A.turn('alice', refused)
    try {
      for (const c of [plain, worked, refused]) expect(confidentialChat(A.ctx.db, c)).toBe(true)
      await withWorkflow(A.ctx.files, A.toolCtx('alice', workedTurn), async () => {})
      // refused at admission (another workflow runs): it read nothing, so it marks nothing
      let release!: () => void
      let started!: () => void
      const ready = new Promise<void>((r) => (started = r))
      const p = withWorkflow(A.ctx.files, A.toolCtx('dana', A.turn('dana', A.chat('dana'))), async () => { started(); await new Promise<void>((r) => (release = r)) })
      await ready
      expect(await code(withWorkflow(A.ctx.files, A.toolCtx('alice', refusedTurn), async () => {}))).toBe('safe_ops_busy')
      release(); await p
    } finally {
      delete process.env.MYCEL_SAFE_OPS_1A
    }
    expect(confidentialChat(A.ctx.db, worked)).toBe(true)
    expect(confidentialChat(A.ctx.db, plain)).toBe(false)
    expect(confidentialChat(A.ctx.db, refused)).toBe(false)
    // the MCP route: the locked conversation refuses an external tool with the confidential text, the other does not
    const call = (turn: string) => makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', turn))({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_fetch', arguments: { url: 'https://example.invalid' } } })
    const external = safeText(A.ctx.db, 'alice', 'external')
    expect(JSON.stringify((await call(workedTurn)).result)).toContain(external)
    expect(JSON.stringify((await call(plainTurn)).result)).not.toContain(external)
  })

  test('migration 323: old rows unlock only when nothing ties 1A work to them (fail-closed otherwise)', () => {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'mig323-'))
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (/^\d{3}_/.test(f) && parseInt(f, 10) < 323) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f))
    const db = openDb(':memory:', { migrationsDir: old })
    try {
      for (const u of ['ann', 'ben']) db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(u, u, u)
      const chat = (id: string, user: string) => db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(id, user)
      const turn = (id: string, c: string, user: string) => db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, ?, ?, 'claude-code')").run(id, c, user)
      const wf = (id: string, user: string, t: string | null) => db.query("INSERT INTO safe_ops_workflows (id, user_id, turn_id, created, owner_pid, state) VALUES (?, ?, ?, 0, 1, 'done')").run(id, user, t)
      // ann: one chat that ran a workflow, one used while 1A was on for something else, one that published
      chat('a-work', 'ann'); turn('t-a-work', 'a-work', 'ann'); wf('w1', 'ann', 't-a-work')
      chat('a-web', 'ann'); turn('t-a-web', 'a-web', 'ann')
      chat('a-pub', 'ann'); turn('t-a-pub', 'a-pub', 'ann')
      db.query("INSERT INTO safe_ops_publications (id, user_id, turn_id, destination, hash, size, policy, audience, provenance, state, cleanup, created, owner_pid) VALUES ('p1', 'ann', 't-a-pub', 'x.pptx', 'h', 1, 1, '[]', '{}', 'published', 'clean', 0, 1)").run()
      // ben: a workflow whose turn row is gone (retention), so no conversation can be ruled out
      chat('b-web', 'ben'); turn('t-b-web', 'b-web', 'ben'); wf('w2', 'ben', 't-gone')
      // a turn-less workflow (no conversation) ties nothing
      wf('w3', 'ann', null)
      for (const c of ['a-work', 'a-web', 'a-pub', 'b-web']) db.query('INSERT INTO safe_ops_chats (chat_id) VALUES (?)').run(c)
      fs.copyFileSync(path.join(MIGRATIONS_DIR, '323_c_safe_ops_lock_material.sql'), path.join(old, '323_c_safe_ops_lock_material.sql'))
      migrate(db, { migrationsDir: old })
      const m = Object.fromEntries((db.query('SELECT chat_id, material FROM safe_ops_chats').all() as { chat_id: string; material: number }[]).map((r) => [r.chat_id, r.material]))
      expect(m).toEqual({ 'a-work': 1, 'a-web': 0, 'a-pub': 1, 'b-web': 1 })
      // a row an older build writes after a roll-back stays locked
      chat('a-new', 'ann')
      db.query('INSERT INTO safe_ops_chats (chat_id) VALUES (?)').run('a-new')
      expect((db.query("SELECT material FROM safe_ops_chats WHERE chat_id='a-new'").get() as { material: number }).material).toBe(1)
    } finally {
      db.close()
      fs.rmSync(old, { recursive: true, force: true })
    }
  })
})

describe('B1: readiness names what is missing', () => {
  test('a program the server account owns is not trusted, and the reason says so', () => {
    const f = path.join(A.data, 'fake-pandoc')
    fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 })
    const why = untrusted(f)
    expect(why).toMatch(process.getuid!() === 0 ? /writable|not root/ : /owned by uid \d+, not root/)
    expect(untrusted(path.join(A.data, 'missing'))).toContain('is missing')
  })

  test('the unit names root\'s copies; without it the app\'s copies are used', () => {
    const before = process.env.MYCEL_SAFE_OPS_BIN
    try {
      process.env.MYCEL_SAFE_OPS_BIN = '/var/lib/mycel/root/safe-ops'
      expect(safeProgram('pandoc', '/x/bin/pandoc')).toBe('/var/lib/mycel/root/safe-ops/pandoc')
      expect(safeProgram('mycel-safeops')).toBe('/var/lib/mycel/root/safe-ops/mycel-safeops')
      delete process.env.MYCEL_SAFE_OPS_BIN
      expect(safeProgram('pandoc', '/x/bin/pandoc')).toBe('/x/bin/pandoc')
      expect(safeProgram('mycel-safeops')).toMatch(/\/mycel-safeops$/)
    } finally {
      if (before === undefined) delete process.env.MYCEL_SAFE_OPS_BIN
      else process.env.MYCEL_SAFE_OPS_BIN = before
    }
  })

  test('off says nothing; on outside a qualified Linux install names the missing part', () => {
    expect(safeOpsReadiness(false)).toEqual({ state: 'off' })
    const r = safeOpsReadiness(true)
    expect(r.state).toBe('not_ready')
    if (process.platform !== 'linux') expect(r).toMatchObject({ reason: 'unavailable', detail: 'not Linux' })
  })
})
