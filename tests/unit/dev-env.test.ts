// Dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)"): off unless MYCEL_DEV_ENV=1 and an
// admin turns it on per project after the warning; folder write access is needed in every scope and is checked on
// every command; box_shell goes to boxd (a fake here) inside a change window that records who changed what (versions,
// conflict copies, background changes); a command that can use a login asks the person after changes by others;
// preview links are single-use, short-lived, on a separate origin, checked on every request. The box itself
// (podman, network rules, limits) is tested on the dev-env-test VM (scripts/dev-env/vm-tests.sh).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_WARNING_VERSION } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { setBoxdClient, type BoxdClient } from '../../server/src/devenv/boxd'
import { devEnvFlag, devEnvSetting, mayUseBox, OFF_SETTING, saveDevEnvSetting, newConsent } from '../../server/src/devenv/setting'
import { diffSnapshots, readInside, skipName, takeSnapshot, SnapshotStore } from '../../server/src/devenv/snapshot'
import { boxCwd, newDestinations, usesCredentials } from '../../server/src/devenv/tool'
import { _previewLinks, issuePreview, previewBase, previewFetch, sameSite, TOKEN_TTL_MS } from '../../server/src/devenv/preview'
import { fileEvent } from '../../server/src/files/store'
import { stepLabel } from '@mycel/shared'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
let projectId = ''
const FOLDER = 'projects/falcon'
const calls: { op: string; req: unknown }[] = []
/** what the fake exec does while it "runs" (the real box writes the same folder through the idmapped mount) */
let during: (() => void) | null = null
/** the next exec finds the box stopped (a command ended its main process) */
let stoppedOnce = false

const fakeBoxd: BoxdClient = {
  async status() { return { ok: true, value: { ev: 'status', available: true, boxes: [{ box: projectId, state: 'running', startedAt: null, lastActiveAt: null, memoryMiB: 12 }] } } },
  async ensure(req) { calls.push({ op: 'ensure', req }); return { ok: true, value: { ev: 'ok' } } },
  async stop(box) { calls.push({ op: 'stop', req: box }); return { ok: true, value: { ev: 'ok' } } },
  async ps() { return { ok: true, value: { ev: 'ps', processes: [{ pid: 40, seconds: 90, command: 'node vite --host 127.0.0.1' }] } } },
  async preview() { return { ok: true, value: { ev: 'preview', socket: '/nonexistent/preview.sock' } } },
  async netlog() { return { ok: true, value: { ev: 'netlog', lines: ['1730360000 tcp 104.16.3.35:443'] } } },
  async exec(req) {
    calls.push({ op: 'exec', req })
    if (stoppedOnce) { stoppedOnce = false; return { ok: false, message: 'box_stopped: the box does not run' } }
    // "write <rel> <text>" lines write files of the project folder; anything else echoes
    let out = ''
    for (const l of req.command.split('\n')) {
      const m = /^write (\S+) (.*)$/.exec(l)
      if (m) { const p = path.join(h.team, FOLDER, req.cwd, m[1]!); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, m[2]!) }
      else out += l + '\n'
    }
    during?.()
    return { ok: true, value: { ev: 'exit', code: 0, signal: '', stdout: out, stderr: '', truncated: false, ms: 5 } }
  },
}

const turnOn = (scope: { mode: 'writers' | 'selected'; groupIds: string[]; userIds: string[] } = { mode: 'writers', groupIds: [], userIds: [] }) =>
  saveDevEnvSetting(h.ctx.db, projectId, { ...OFF_SETTING, enabled: true, scope, consent: newConsent({ id: 'carol', name: 'Carol Park' }) })

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'dev-env', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-dev' })
  await alice.next('hello')
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: FOLDER, instructions: '' } })).id
  setBoxdClient(fakeBoxd)
})
afterAll(async () => { setBoxdClient(null); delete process.env.MYCEL_DEV_ENV; delete process.env.MYCEL_DEV_PREVIEW_ORIGIN; alice?.close(); await h.close() })

describe('pure parts', () => {
  test('cwd stays inside the project folder', () => {
    expect(boxCwd(undefined)).toBe('')
    expect(boxCwd('./src/')).toBe('src')
    expect(boxCwd('a/../../etc')).toBeNull()
    expect(boxCwd('/etc')).toBe('etc') // leading slashes are taken off: relative to /work
    expect(boxCwd('a//b')).toBeNull()
  })
  test('network destinations go into the audit once', () => {
    const lines = ['1 tcp 104.16.3.35:443', '2 udp 169.254.1.1:53', '3 tcp 104.16.3.35:443']
    expect(newDestinations(lines, undefined)).toEqual({ dest: ['tcp 104.16.3.35:443', 'udp 169.254.1.1:53'], last: '3 tcp 104.16.3.35:443' })
    expect(newDestinations(lines, '2 udp 169.254.1.1:53').dest).toEqual(['tcp 104.16.3.35:443'])
    expect(newDestinations(lines, '3 tcp 104.16.3.35:443').dest).toEqual([])
  })
  test('commands that can use a login', () => {
    for (const c of ['git push origin main', 'cd x && git pull', 'npm publish', 'ssh host', 'gh pr create', 'docker login']) expect(usesCredentials(c)).toBe(true)
    for (const c of ['git status', 'git commit -m x', 'npm install', 'npm run dev', 'echo github']) expect(usesCredentials(c)).toBe(false)
  })
  test('snapshots skip build output and secrets, catch mtime tricks, see deletes', () => {
    for (const n of ['node_modules', '.git', '.env', '.env.local', 'dist', '.next', '.venv']) expect(skipName(n)).toBe(true)
    expect(skipName('src')).toBe(false)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-snap-'))
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t) }
    w('app/a.txt', 'one'); w('app/node_modules/x/i.js', 'x'); w('app/.env', 'SECRET=1'); w('app/dist/o.js', 'o')
    const store = new SnapshotStore(path.join(root, '.store'))
    const s1 = takeSnapshot(root, 'app', null, store)
    expect(Object.keys(s1.files)).toEqual(['app/a.txt'])
    // same size, mtime set back: ctime still differs
    const st = fs.statSync(path.join(root, 'app/a.txt'))
    Bun.sleepSync(20)
    fs.writeFileSync(path.join(root, 'app/a.txt'), 'two'); fs.utimesSync(path.join(root, 'app/a.txt'), st.atime, st.mtime)
    w('app/b.txt', 'b')
    const s2 = takeSnapshot(root, 'app', s1, store)
    expect(diffSnapshots(s1, s2).map((c) => `${c.action} ${c.path}`)).toEqual(['update app/a.txt', 'create app/b.txt'])
    expect(store.blob(s1.files['app/a.txt']!.sha256!)?.toString()).toBe('one')
    // a link the box made to a file outside the folder is never read, also when swapped in for a listed name
    w('secret.db', 'SERVER SECRET')
    fs.symlinkSync(path.join(root, 'secret.db'), path.join(root, 'app/link.txt'))
    fs.mkdirSync(path.join(root, 'outside')); w('outside/x.txt', 'SERVER SECRET 2')
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'app/dirlink'))
    expect(readInside(path.join(root, 'app/link.txt'), path.join(root, 'app'))).toBeNull()
    expect(readInside(path.join(root, 'app/dirlink/x.txt'), path.join(root, 'app'))).toBeNull()
    expect(readInside(path.join(root, 'app/a.txt'), path.join(root, 'app'))?.bytes.toString()).toBe('two')
    const s3 = takeSnapshot(root, 'app', s2, store)
    expect(Object.keys(s3.files).some((k) => k.includes('link'))).toBe(false)
    fs.rmSync(path.join(root, 'app/link.txt')); fs.rmSync(path.join(root, 'app/dirlink'))
    fs.rmSync(path.join(root, 'app/b.txt'))
    expect(diffSnapshots(s2, takeSnapshot(root, 'app', s2, store)).map((c) => `${c.action} ${c.path}`)).toEqual(['delete app/b.txt'])
    fs.rmSync(root, { recursive: true, force: true })
  })
  test('preview origin must be a wildcard on another site', () => {
    expect(previewBase({ MYCEL_DEV_PREVIEW_ORIGIN: 'https://*.preview.example.net' })).toEqual({ scheme: 'https', suffix: 'preview.example.net', port: '' })
    expect(previewBase({ MYCEL_DEV_PREVIEW_ORIGIN: 'https://preview.example.net' })).toBeNull()
    expect(sameSite('team.example.net', 'preview.example.net')).toBe(true)
    expect(sameSite('team.example.com', 'preview.example.net')).toBe(false)
  })
  test('step label', () => {
    expect(stepLabel('box_shell', { command: 'npm install\nnpm test' }, 'en', new Set())).toBe('Dev environment command · npm install')
  })
})

describe('the setting', () => {
  test('off by default, needs the flag and a consent to the current warning, and write access in every scope', () => {
    expect(devEnvSetting(h.ctx.db, projectId).enabled).toBe(false)
    const ref = { id: projectId, folderPath: FOLDER }
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(false)
    saveDevEnvSetting(h.ctx.db, projectId, { ...OFF_SETTING, enabled: true })
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(false) // no consent
    turnOn()
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(true)
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'alice', false)).toBe(false) // flag off
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'bob')).toBe(false) // finance reads only
    turnOn({ mode: 'selected', groupIds: ['finance'], userIds: [] })
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'bob')).toBe(false) // named, but still no write access
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(false) // not named
    saveDevEnvSetting(h.ctx.db, projectId, OFF_SETTING)
    expect(devEnvFlag({})).toBe(false)
  })

  test('API: admins only, warning first, audited; 404 without the flag', async () => {
    const body = { enabled: true, scope: { mode: 'writers' as const, groupIds: [], userIds: [] } }
    await expect(h.api('alice').call(API.updateDevEnv, { params: { id: projectId }, body })).rejects.toMatchObject({ status: 403 })
    await expect(h.api('carol').call(API.updateDevEnv, { params: { id: projectId }, body })).rejects.toMatchObject({ status: 409, body: { params: { reason: 'dev_env_warning' } } })
    const on = await h.api('carol').call(API.updateDevEnv, { params: { id: projectId }, body: { ...body, acceptWarning: DEV_ENV_WARNING_VERSION } })
    expect(on.setting).toMatchObject({ enabled: true, consent: { by: { id: 'carol' } } })
    const mine = await h.api('alice').call(API.devEnv, { params: { id: projectId } })
    expect(mine).toMatchObject({ mayUse: true, mayManage: false, availability: { available: true }, box: { state: 'running', processes: [{ pid: 40 }] } })
    expect((await h.api('bob').call(API.devEnv, { params: { id: projectId } })).mayUse).toBe(false)
    await expect(h.api('erin').call(API.devEnv, { params: { id: projectId } })).rejects.toMatchObject({ status: 404 }) // cannot read the folder
    const rows = h.ctx.db.query("SELECT actor_id, action FROM audit_log WHERE action LIKE 'dev_env.%' AND target = ? ORDER BY id").all(projectId)
    expect(rows).toEqual([{ actor_id: 'carol', action: 'dev_env.consent' }, { actor_id: 'carol', action: 'dev_env.setting' }])
    // a network change stops the box (it starts again with the new rules at the next command)
    calls.length = 0
    await h.api('carol').call(API.updateDevEnv, { params: { id: projectId }, body: { ...body, network: 'offline' } })
    expect(calls).toEqual([{ op: 'stop', req: projectId }])
    await h.api('carol').call(API.updateDevEnv, { params: { id: projectId }, body: { ...body, network: 'open' } })
    delete process.env.MYCEL_DEV_ENV
    try { await expect(h.api('alice').call(API.devEnv, { params: { id: projectId } })).rejects.toMatchObject({ status: 404 }) } finally { process.env.MYCEL_DEV_ENV = '1' }
  })
})

describe('the turn', () => {
  test('box_shell only for people who may use the box; changes are recorded with their name and versions', async () => {
    turnOn()
    fs.writeFileSync(path.join(h.team, FOLDER, 'plan.md'), '# Project Falcon plan\nKickoff 2026-10-01\n')
    // a first command takes the baseline
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const tools = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }))
    expect(tools.done.content).toContain('box_shell')
    calls.length = 0
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'box_shell', args: { command: 'echo hi\nwrite src/app.ts export {}\nwrite plan.md changed', cwd: '' }, sayResult: true }))
    expect(r.done.content).toContain('Exit code 0.')
    expect(r.done.content).toContain('Processes still running in the box')
    expect(r.done.content).toContain(`created ${FOLDER}/src/app.ts`)
    expect(r.done.content).toContain(`changed ${FOLDER}/plan.md`)
    expect(calls.map((c) => c.op)).toEqual(['ensure', 'exec'])
    expect(calls[1]!.req).toMatchObject({ box: projectId, cwd: '', background: false, actor: 'alice' })
    const ev = h.ctx.db.query(`SELECT user_id, path, action FROM file_events WHERE detail LIKE '%"via":"dev_env"%' ORDER BY id`).all()
    expect(ev).toEqual([{ user_id: 'alice', path: `${FOLDER}/plan.md`, action: 'update' }, { user_id: 'alice', path: `${FOLDER}/src/app.ts`, action: 'create' }])
    const v = h.ctx.db.query('SELECT author_id FROM file_versions WHERE path = ?').all(`${FOLDER}/plan.md`)
    expect(v).toEqual([{ author_id: 'alice' }]) // the old content became a version
    const cmd = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.command' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(cmd.detail)).toMatchObject({ destinations: ['tcp 104.16.3.35:443'], changed: 2, result: { code: 0 } })
    const act = await h.api('bob').call(API.devEnvActivity, { params: { id: projectId } })
    expect(act.items.some((i) => i.kind === 'command' && i.text.includes('echo hi') && i.by?.id === 'alice')).toBe(true)
    // the box stopped by itself since the last command: started again, the command runs once
    stoppedOnce = true
    calls.length = 0
    const rs = await ask(h, alice, 'alice', chat.id, fake({ tool: 'box_shell', args: { command: 'echo after-stop' }, sayResult: true }))
    expect(rs.done.content).toContain('Exit code 0.')
    expect(calls.map((c) => c.op)).toEqual(['ensure', 'exec', 'ensure', 'exec'])
    // background changes (a dev server between commands) show up at the next command
    fs.writeFileSync(path.join(h.team, FOLDER, 'src/gen.ts'), 'generated')
    const r2 = await ask(h, alice, 'alice', chat.id, fake({ tool: 'box_shell', args: { command: 'echo again' }, sayResult: true }))
    expect(r2.done.content).toContain(`Files changed in the background since the last command (1):\n  created ${FOLDER}/src/gen.ts`)
    // bob reads only: no tool
    const bobChat = await h.api('bob').call(API.createChat, { body: { projectId } })
    const bob = await h.ws('bob', { windowId: 'win-bob-dev' }); await bob.next('hello')
    const bt = await ask(h, bob, 'bob', bobChat.id, fake({ echo: 'tools' }))
    expect(bt.done.content).not.toContain('box_shell')
    bob.close()
  })

  test('the admin turns it off: the next call is refused', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    turnOn()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'ask_user', args: { question: 'wait' } }, { tool: 'box_shell', args: { command: 'echo x' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    saveDevEnvSetting(h.ctx.db, projectId, OFF_SETTING)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'ok' } })
    const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('The dev environment is off')
    turnOn()
  })

  test('a login command after changes by others: the person sees them and decides', async () => {
    turnOn()
    fileEvent(h.ctx.db, { turnId: null, userId: 'carol', path: `${FOLDER}/package.json`, action: 'update', size: 10 })
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'box_shell', args: { command: 'git push origin main' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect(JSON.stringify(card.data.request)).toContain(`Carol Park: update ${FOLDER}/package.json`)
    calls.length = 0
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'no' } })
    const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('did not allow')
    expect(calls).toEqual([])
  })

  test('a Files save during a command is kept as a conflict copy', async () => {
    turnOn()
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const target = path.join(h.team, FOLDER, 'notes.md')
    fs.writeFileSync(target, 'base')
    await ask(h, alice, 'alice', chat.id, fake({ tool: 'box_shell', args: { command: 'echo baseline' } }))
    during = () => {
      // carol saves from the file screen while the command runs; then the command overwrites it
      fs.writeFileSync(target, 'carol edit')
      fileEvent(h.ctx.db, { turnId: null, userId: 'carol', path: `${FOLDER}/notes.md`, action: 'update', size: 10 })
      fs.writeFileSync(target, 'box result')
    }
    try {
      const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'box_shell', args: { command: 'echo build' }, sayResult: true }))
      expect(r.done.content).toContain('their version is kept as')
    } finally { during = null }
    const copies = fs.readdirSync(path.join(h.team, FOLDER)).filter((n) => n.startsWith('notes (') && n.includes('Carol Park'))
    expect(copies.length).toBe(1)
    expect(fs.readFileSync(path.join(h.team, FOLDER, copies[0]!), 'utf8')).toBe('carol edit')
    expect(fs.readFileSync(target, 'utf8')).toBe('box result')
  })
})

describe('preview', () => {
  test('single-use link, own origin per link, cookie only for it, permission checked on every request', async () => {
    turnOn()
    delete process.env.MYCEL_DEV_PREVIEW_ORIGIN
    await expect(h.api('alice').call(API.devEnvPreview, { params: { id: projectId }, body: { port: 5173 } })).rejects.toMatchObject({ status: 409, body: { params: { reason: 'dev_env_preview_not_configured' } } })
    process.env.MYCEL_DEV_PREVIEW_ORIGIN = 'https://*.preview.example.net'
    // bob can read the folder: he may look at the preview (not run commands)
    const link = await h.api('bob').call(API.devEnvPreview, { params: { id: projectId }, body: { port: 5173 } })
    const u = new URL(link.url)
    expect(u.hostname).toMatch(/^[0-9a-f]{20}\.preview\.example\.net$/)
    const seen: { socket: string; host: string | null; cookie: string | null }[] = []
    const upstream = async (socket: string, req: Request) => {
      seen.push({ socket, host: req.headers.get('host'), cookie: req.headers.get('cookie') })
      return new Response('<h1>dev</h1>', { headers: { 'set-cookie': 'app=1; Path=/' } })
    }
    const get = (p: string, cookie?: string) => previewFetch(h.ctx, new Request(`https://${u.host}${p}`, { headers: { host: u.host, ...(cookie ? { cookie } : {}) } }), upstream)
    expect((await get('/')).status).toBe(403) // no session yet
    const red = await get(u.pathname + u.search)
    expect(red.status).toBe(303)
    const cookie = red.headers.get('set-cookie')!
    expect(cookie).toMatch(/^mycel_pv=[0-9a-f]{48}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/)
    expect((await get(u.pathname + u.search)).status).toBe(403) // single use
    const ok = await get('/', cookie.split(';')[0] + '; app=1')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('<h1>dev</h1>')
    expect(seen[0]).toEqual({ socket: '/nonexistent/preview.sock', host: 'localhost', cookie: 'app=1' }) // our cookie is not forwarded
    // another link's host with this cookie: refused (every link is its own origin)
    const other = new URL((await h.api('bob').call(API.devEnvPreview, { params: { id: projectId }, body: { port: 5173 } })).url)
    expect((await previewFetch(h.ctx, new Request(`https://${other.host}/`, { headers: { host: other.host, cookie: cookie.split(';')[0]! } }), upstream)).status).toBe(403)
    // turned off: the open session stops working
    saveDevEnvSetting(h.ctx.db, projectId, OFF_SETTING)
    expect((await get('/', cookie.split(';')[0])).status).toBe(403)
    turnOn()
    // an expired token
    const late = issuePreview(h.ctx, { projectId, folderPath: FOLDER, port: 3000, userId: 'bob' }, Date.now() - TOKEN_TTL_MS - 1000) as { url: string }
    const lu = new URL(late.url)
    expect((await previewFetch(h.ctx, new Request(late.url, { headers: { host: lu.host } }), upstream)).status).toBe(403)
    // the app's own host on the same site is refused
    process.env.MYCEL_DEV_PREVIEW_ORIGIN = 'https://*.preview.example.net'
    expect(issuePreview(h.ctx, { projectId, folderPath: FOLDER, port: 3000, userId: 'bob', appHost: 'team.example.net' })).toEqual({ error: 'same_site' })
    expect(_previewLinks().size).toBeGreaterThan(0)
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dev_env.preview'").get()).toEqual({ n: 3 })
  })
})
