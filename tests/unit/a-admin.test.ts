// Component A: engines status (local logins, managed AI connections), settings, budgets, usage, audit list, the server CLI.
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { recordSkillUse } from '../../server/src/admin/skill-usage'
import { uuidv7 } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import { checkBudgets } from '../../server/src/admin/budgets'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { CliError, runCli } from '../../server/src/auth/cli'
import { OWNER_PW, addMember, harness, testConfig, withOwner, type Client, type Harness } from './a-lib'
import { credentialsOf } from '../../server/src/credentials/store'
import { addCred } from '../lib/credentials'

function fakeBin(dir: string, name: string, script: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return p
}

describe('engines', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let bins: string
  beforeAll(async () => {
    h = await harness('engines')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    bins = path.join(h.ctx.config.dataDir, '..', 'bins')
    const claudeOk = fakeBin(bins, 'claude-ok', `case "$1" in --version) echo "2.1.305 (Claude Code)";; auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}';; *) exit 2;; esac`)
    const codexOk = fakeBin(bins, 'codex-ok', `case "$1" in --version) echo "codex-cli 0.163.0";; login) echo "Logged in using ChatGPT";; *) exit 2;; esac`)
    h.ctx.config.engine = { authMode: 'local-login', claudeBin: claudeOk, codexBin: codexOk }
    fs.mkdirSync(path.join(h.ctx.config.dataDir, 'engine'), { recursive: true }) // lockdown results
    // the dev catalog chat/engines.ts locks from the owner's models cache (one place: <data>/codex-catalog.json)
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'codex-catalog.json'), JSON.stringify({ models: [{ slug: 'gpt-x', display_name: 'GPT-X', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }))
  })
  afterAll(() => h.close())
  const check = (id: string) => admin.call('POST', `/api/admin/engines/${id}/check`)

  test('installed + logged in + pinned version -> ok, with models; no model call is made', async () => {
    const r = await admin.call('GET', '/api/admin/engines')
    expect(r.engines.map((e: any) => [e.id, e.status, e.version, e.authMode])).toEqual([['claude-code', 'ok', '2.1.305', 'local-login'], ['codex', 'ok', '0.163.0', 'local-login'], ['api', 'not_installed', null, 'local-login']])
    expect(r.engines[0].models.map((m: any) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(r.engines[1].models).toEqual([{ id: 'gpt-x', label: 'GPT-X' }])
    expect(r).toMatchObject({ defaultEngine: 'claude-code', defaultModel: null, concurrency: 3, accounts: [] })
  })
  test('not installed, not logged in, other version, failed lockdown, timeouts', async () => {
    h.ctx.config.engine.claudeBin = '/nonexistent/claude'
    expect(await check('claude-code')).toMatchObject({ installed: false, status: 'not_installed', version: null })
    h.ctx.config.engine.claudeBin = fakeBin(bins, 'claude-out', `case "$1" in --version) echo "2.1.305 (Claude Code)";; auth) echo '{"loggedIn": false}'; exit 1;; esac`)
    const out = await check('claude-code')
    expect(out).toMatchObject({ installed: true, status: 'not_logged_in' })
    expect(out.detail).toContain('claude')
    h.ctx.config.engine.claudeBin = fakeBin(bins, 'claude-new', `case "$1" in --version) echo "2.2.0 (Claude Code)";; auth) echo '{"loggedIn": true}';; esac`)
    expect(await check('claude-code')).toMatchObject({ status: 'version_unsupported', version: '2.2.0' })
    h.ctx.config.engine.codexBin = fakeBin(bins, 'codex-out', `case "$1" in --version) echo "codex-cli 0.163.0";; login) echo "Not logged in"; exit 1;; esac`)
    expect(await check('codex')).toMatchObject({ status: 'not_logged_in' })
    h.ctx.config.engine.codexBin = path.join(bins, 'codex-ok')
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'engine', 'lockdown-codex.json'), JSON.stringify({ ok: false, version: '0.163.0' }))
    expect(await check('codex')).toMatchObject({ status: 'lockdown_failed' })
    fs.rmSync(path.join(h.ctx.config.dataDir, 'engine', 'lockdown-codex.json'))
    expect(await check('codex')).toMatchObject({ status: 'ok' })
    expect((await admin.try('POST', '/api/admin/engines/gpt/check')).status).toBe(404)
  })
  test('managed mode (installed server): an engine without an AI connection says to add one; a usable connection is "ok"', async () => {
    h.ctx.config.engine.claudeBin = path.join(bins, 'claude-ok')
    h.ctx.config.engine.authMode = 'managed'
    try {
      const r = await check('claude-code')
      expect(r).toMatchObject({ authMode: 'managed', status: 'not_logged_in' })
      expect(r.detail).toContain('AI 연결')
      const cc = credentialsOf(h.ctx)
      setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true) // this case explicitly exercises a shared team subscription
      const id = addCred(cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'f'.repeat(40))
      expect(await check('claude-code')).toMatchObject({ authMode: 'managed', status: 'ok' })
      // refused: none usable any more, and the text says so
      h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid' WHERE id = ?").run(id)
      const bad = await check('claude-code')
      expect(bad.status).toBe('not_logged_in'); expect(bad.detail).toContain('쓸 수 없어요')
      // Codex: the OpenAI family is separate
      expect((await check('codex')).status).toBe('not_logged_in')
      addCred(cc, 'openai-api-key', 'sk-' + 'o'.repeat(40))
      expect((await check('codex')).status).toBe('ok')
      expect((await admin.call('GET', '/api/admin/engines')).accounts).toEqual([])
    } finally {
      h.ctx.config.engine.authMode = 'local-login'; h.ctx.db.query('DELETE FROM engine_credentials').run()
      h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(SHARED_SUBSCRIPTIONS_KEY)
    }
  })
  test('defaults, concurrency, enable / disable', async () => {
    const r = await admin.call('PATCH', '/api/admin/engines', { defaultEngine: 'codex', defaultModel: 'gpt-x', concurrency: 5 })
    expect(r).toMatchObject({ defaultEngine: 'codex', defaultModel: 'gpt-x', concurrency: 5 })
    expect((await admin.try('PATCH', '/api/admin/engines', { enabled: { 'claude-code': false } })).status).toBe(200)
    expect((await admin.try('PATCH', '/api/admin/engines', { defaultEngine: 'claude-code' })).status).toBe(409)
    expect((await admin.try('PATCH', '/api/admin/engines', { concurrency: 99 })).status).toBe(400)
    const s = await admin.call('GET', '/api/admin/settings')
    expect(s).toMatchObject({ defaultEngine: 'codex', defaultModel: 'gpt-x', concurrency: 5 })
    const e = await admin.call('GET', '/api/admin/engines')
    expect(e.engines.find((x: any) => x.id === 'claude-code').enabled).toBe(false)
    await admin.call('PATCH', '/api/admin/engines', { enabled: { 'claude-code': true }, defaultEngine: 'claude-code' })
    expect((await admin.call('GET', '/api/admin/settings')).defaultModel).toBeNull() // engine changed -> model reset
  })
  test('the older company-key endpoints are gone (company keys are AI connections now)', async () => {
    const secret = 'sk-ant-api03-' + 'x'.repeat(30) + 'WXYZ'
    expect((await owner.try('POST', '/api/admin/engines/accounts', { engine: 'anthropic', secret })).status).toBe(404)
    expect((await owner.try('DELETE', '/api/admin/engines/accounts/x')).status).toBe(404)
  })
})

describe('settings, budgets, usage, audit', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let mem: { client: Client; id: string }
  let group: string
  beforeAll(async () => {
    h = await harness('misc')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    group = (await admin.call('POST', '/api/admin/groups', { name: 'Ops' })).id
    mem = await addMember(h, owner, { username: 'max', groupIds: [group] })
    const turn = (user: string, engine: string, model: string | null, inT: number, outT: number, cost: number, at: string) =>
      h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)")
        .run(uuidv7(), uuidv7(), user, engine, model, at, inT, outT, cost)
    const today = new Date().toISOString()
    turn(mem.id, 'claude-code', 'sonnet', 100, 50, 0.5, today)
    turn(mem.id, 'codex', 'gpt-x', 10, 5, 0.25, today)
    turn('olga', 'claude-code', null, 1000, 500, 2, today)
    turn(mem.id, 'claude-code', 'sonnet', 1, 1, 9, new Date(Date.now() - 40 * 86_400_000).toISOString())
  })
  afterAll(() => h.close())

  test('settings: defaults, validation, team name is owner-only, audited', async () => {
    const s = await admin.call('GET', '/api/admin/settings')
    expect(s).toMatchObject({ teamName: 'Acme', defaultLocale: 'ko', concurrency: 3, auditRetentionDays: 90, chatTrashRetentionDays: 7 })
    expect((await admin.try('PATCH', '/api/admin/settings', { teamName: 'Other' })).status).toBe(403)
    expect((await admin.try('PATCH', '/api/admin/settings', { updateWindow: '25:00' })).status).toBe(400)
    expect((await admin.call('PATCH', '/api/admin/settings', { updateWindow: '02:00-05:00', trashRetentionDays: 14 })).trashRetentionDays).toBe(14)
    expect((await owner.call('PATCH', '/api/admin/settings', { teamName: 'Acme Corp' })).teamName).toBe('Acme Corp')
    expect((await mem.client.call('GET', '/api/me')).team.name).toBe('Acme Corp')
    const a = await owner.call('GET', '/api/admin/audit?source=admin')
    expect(a.items.find((e: any) => e.action === 'settings.update' && e.detail.teamName)).toBeTruthy()
  })
  test('budgets: subjects checked, current spend shown, checkBudgets for proxy mode', async () => {
    const team = await admin.call('POST', '/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'month', limitUsd: 100, action: 'warn' })
    expect(team).toMatchObject({ usedUsd: 2.75, usedTokens: 1665, limitTokens: null })
    const user = await admin.call('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: mem.id, period: 'day', limitUsd: 0.7, action: 'block' })
    expect(user.usedUsd).toBeCloseTo(0.75)
    const grp = await admin.call('POST', '/api/admin/budgets', { subjectType: 'group', subjectId: group, period: 'month', limitUsd: 10, limitTokens: 100, action: 'block' })
    expect(grp.usedTokens).toBe(165)
    expect((await admin.try('POST', '/api/admin/budgets', { subjectType: 'team', subjectId: 'x', period: 'day', limitUsd: 1, action: 'warn' })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: 'ghost', period: 'day', limitUsd: 1, action: 'warn' })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/budgets', { subjectType: 'group', subjectId: uuidv7(), period: 'day', limitUsd: 1, action: 'warn' })).status).toBe(400)
    const c = checkBudgets(h.ctx.db, mem.id)
    expect(c.map((x) => [x.budget.subjectType, x.exceeded]).sort()).toEqual([['group', true], ['team', false], ['user', true]])
    expect(checkBudgets(h.ctx.db, 'olga').map((x) => x.budget.subjectType)).toEqual(['team'])
    const up = await admin.call('PATCH', `/api/admin/budgets/${user.id}`, { limitUsd: 5 })
    expect(up).toMatchObject({ limitUsd: 5, subjectId: mem.id, period: 'day' })
    expect((await admin.call('GET', '/api/admin/budgets')).items).toHaveLength(3)
    await admin.call('DELETE', `/api/admin/budgets/${grp.id}`)
    expect((await admin.try('DELETE', `/api/admin/budgets/${grp.id}`)).status).toBe(404)
    expect((await admin.try('PATCH', `/api/admin/budgets/${uuidv7()}`, { limitUsd: 1 })).status).toBe(404)
  })
  test('usage per person / engine / model / day / group, last 30 days by default', async () => {
    const u = await admin.call('GET', '/api/admin/usage')
    expect(u.totals).toEqual({ turns: 3, inputTokens: 1110, outputTokens: 555, costUsd: 2.75 })
    expect(u.rows.map((r: any) => [r.key, r.label, r.turns])).toEqual([['olga', 'Olga Owner', 1], [mem.id, 'MAX', 2]])
    expect((await admin.call('GET', '/api/admin/usage?groupBy=engine')).rows.map((r: any) => [r.key, r.turns])).toEqual([['claude-code', 2], ['codex', 1]])
    expect((await admin.call('GET', '/api/admin/usage?groupBy=model')).rows.map((r: any) => r.label).sort()).toEqual(['(default)', 'gpt-x', 'sonnet'])
    expect((await admin.call('GET', '/api/admin/usage?groupBy=group')).rows).toEqual([{ key: group, label: 'Ops', turns: 2, inputTokens: 110, outputTokens: 55, costUsd: 0.75 }])
    const from = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const days = (await admin.call('GET', `/api/admin/usage?groupBy=day&from=${encodeURIComponent(from)}`)).rows
    expect(days).toHaveLength(2)
    // days of the server's own time zone, not UTC days
    const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(days.map((r: any) => r.key)).toEqual([local(new Date(Date.now() - 40 * 86_400_000)), local(new Date())])
    expect((await admin.try('GET', `/api/admin/usage?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(from)}`)).status).toBe(400)
  })
  test('skill usage uses the same admin permission and report dates; no prompt body is returned', async () => {
    const turn = h.ctx.db.query('SELECT id, user_id FROM turns ORDER BY started_at DESC LIMIT 1').get() as { id: string; user_id: string }
    recordSkillUse(h.ctx.db, { turnId: turn.id, userId: turn.user_id, skill: { path: 'skills/report.md', name: 'Weekly report' }, source: 'command' })
    const res = await admin.call('GET', '/api/admin/usage?groupBy=skill')
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]).toMatchObject({ key: 'skills/report.md', label: 'Weekly report', turns: 1 })
    expect(Object.keys(res.rows[0]).sort()).toEqual(['costUsd', 'inputTokens', 'key', 'label', 'outputTokens', 'turns'])
    expect((await mem.client.try('GET', '/api/admin/usage?groupBy=skill')).status).toBe(403)
    expect((await admin.try('GET', '/api/admin/usage?groupBy=skill&from=invalid')).status).toBe(400)
  })
  test('audit: admin, sign-in, file and tool events newest first, filters, stable cursor pages', async () => {
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action, size) VALUES (NULL, ?, 'groups/Ops/plan.md', 'update', 12), (NULL, ?, 'shared/x.md', 'create', 3)").run(mem.id, mem.id)
    h.ctx.db.query("INSERT INTO tool_events (turn_id, user_id, tool, summary, ok) VALUES (NULL, ?, 'grep', 'grep \"plan\" in groups/', 1)").run(mem.id)
    const all: any[] = []
    let cursor: string | null = null
    do {
      const page: any = await admin.call('GET', `/api/admin/audit?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      expect(page.items.length).toBeLessThanOrEqual(3)
      all.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length)
    const ats = all.map((e) => e.at)
    expect([...ats].sort().reverse()).toEqual(ats)
    expect(new Set(all.map((e) => e.source))).toEqual(new Set(['admin', 'auth', 'file', 'tool']))
    const auth = await admin.call('GET', '/api/admin/audit?source=auth')
    expect(auth.items.every((e: any) => e.action.startsWith('auth.'))).toBe(true)
    expect(auth.items.some((e: any) => e.action === 'auth.login' && e.detail.ip === '10.0.0.7')).toBe(true)
    const files = await admin.call('GET', '/api/admin/audit?path=groups/Ops')
    expect(files.items.map((e: any) => [e.source, e.target])).toEqual([['file', 'groups/Ops/plan.md']])
    expect(files.items[0].detail).toMatchObject({ size: 12 })
    const byActor = await admin.call('GET', `/api/admin/audit?actor=${mem.id}&source=tool`)
    expect(byActor.items).toMatchObject([{ source: 'tool', action: 'grep', actor: { id: mem.id, name: 'MAX' }, detail: { summary: 'grep "plan" in groups/', ok: 1 } }])
    expect((await admin.try('GET', '/api/admin/audit?cursor=garbage')).status).toBe(400)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect((await admin.call('GET', `/api/admin/audit?from=${encodeURIComponent(future)}`)).items).toEqual([])
  })
})

describe('server CLI (create-owner, reset-link)', () => {
  const cfg = testConfig('cli', { setupToken: null })
  test('status, create-owner from stdin (only once), owner recovery link that works', async () => {
    expect(await runCli(['status'], { config: cfg })).toContain('setup needed')
    await expect(runCli(['create-owner', '--username', 'kim', '--name', 'Kim', '--team', 'Acme'], { config: cfg, stdin: async () => 'short\n' })).rejects.toThrow(CliError)
    await expect(runCli(['create-owner', '--name', 'Kim', '--team', 'Acme'], { config: cfg, stdin: async () => OWNER_PW })).rejects.toThrow('--username')
    expect(await runCli(['create-owner', '--username', 'kim', '--name', 'Kim', '--team', 'Acme'], { config: cfg, stdin: async () => OWNER_PW + '\n' })).toContain('owner "kim" created')
    await expect(runCli(['create-owner', '--username', 'lee', '--name', 'Lee', '--team', 'X'], { config: cfg, stdin: async () => OWNER_PW })).rejects.toThrow('already set up')
    expect(await runCli(['status'], { config: cfg })).toContain('"Acme" is set up (1 accounts)')
    const out = await runCli(['reset-link'], { config: cfg })
    const url = /http:\/\/localhost:19110\/reset-password\/([A-Za-z0-9_-]+)/.exec(out)
    expect(url).toBeTruthy()
    await expect(runCli(['reset-link', '--username', 'ghost'], { config: cfg })).rejects.toThrow('no account')
    await expect(runCli(['bogus'], { config: cfg })).rejects.toThrow('usage')

    // the link works through the API; the audit says it came from the server Mac (no admin)
    const db = openDb(path.join(cfg.dataDir, 'app.db'))
    const ctx = createContext({ config: cfg, db, log: silentLogger })
    const app = await buildApp(ctx)
    const post = (p: string, body: unknown) => app.fetch(new Request('http://team.localhost' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify(body) }), { ip: '127.0.0.1', via: 'test' })
    const r = await post(`/api/password-resets/${url![1]}`, { newPassword: 'recovered owner pw 1' })
    expect(r.status).toBe(200)
    const me = ((await r.json()) as any).me
    expect(me.user).toMatchObject({ id: 'kim', role: 'owner' })
    expect(me.passwordReset).toMatchObject({ by: null })
    expect((await post('/api/auth/login', { username: 'kim', password: 'recovered owner pw 1' })).status).toBe(200)
    expect(db.query("SELECT actor_id FROM audit_log WHERE action = 'user.reset_link'").get()).toEqual({ actor_id: null })
    await ctx.close()
    db.close()
  })
})
