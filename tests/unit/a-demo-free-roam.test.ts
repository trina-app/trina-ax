// A free-roam demo instance (DemoFile.kind "freeRoam", docs/decisions/20261119-demo-free-roam-a.md): one visitor's own
// server behind demo-gate, signed in as the demo's one person, with the real AI until the demo limit. It must start only
// where only the gate reaches it (managed AI, a loopback listener, no relay, the gate as model upstream), show nothing of
// a development server, refuse whatever its fences list whoever asks, never mark its stand-in AI connection, and count
// the demo limit with cache reads and cache writes at 0.1, refusing sends at the limit with reason demo_limit.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEMO_GATE_KEY_HEADER, DEMO_LIMIT_DEFAULT, DEV_SESSION_COOKIE, SESSION_COOKIE, DemoFile, type Endpoint } from '../../shared/src/api'
import { cookieFor, FREE_ROAM_SESSION_COOKIE, readToken, sessionCookie } from '../../server/src/auth/service'
import { ConfigError, loadAppConfig } from '../../server/src/app-config'
import { featuresOf } from '../../server/src/system/deployment'
import { budgetBlock, demoLimitState, demoUsed, setDemoLimit } from '../../server/src/admin/budgets'
import { demoQuestionsLeft } from '../../web/src/lib/freeRoam'
import { createBroker } from '../../server/src/credentials/broker'
import { credentialsOf, getRow, listRows } from '../../server/src/credentials/store'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import { DEMO_AI_LABEL, demoRestError, freeRoamDenyRead, freeRoamTurnError, startFreeRoam } from '../../server/src/demo/free-roam'
import { DEMO_GATE_DIR, demoDenyReadDirs, sandboxProfile, setDemoDenyRead } from '../../server/src/tools/isolate'
import { FREE_ROAM_REFUSED_TOOLS, freeRoamFenceOf } from '../../server/src/demo/guard'
import { HIGGSFIELD_TOOLS } from '../../server/src/demo/fakes/higgsfield'
import { issueProxyToken, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { CLAUDE_TOKEN_RE, verifySecret } from '../../server/src/credentials/validate'
import { markInvalid, markNeedsReconnect, markNoCredit } from '../../server/src/credentials/store'
import { gateKeyOk } from '../../server/src/routes/demo'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { ask, startHarness, type Harness as BHarness, type TestSocket } from '../lib/b-harness'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'

setDefaultTimeout(60_000)

const PW = 'demo public words 42'
const SCRIPTED: DemoFile = { company: 'Steepling', password: PW, personas: [{ key: 'newHire', username: 'mina', intro: 'First day at Steepling', questions: [] }] }
const FREE: DemoFile = { ...SCRIPTED, kind: 'freeRoam', limitTokens: 5000, signupUrl: 'https://example.com/start', uploadFileMax: 4000, uploadTotalMax: 6000 }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a-demo-free-roam-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const write = (name: string, v: object) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p }
const freeFile = write('free.json', FREE)
const GATE = 'http://127.0.0.1:47999/i/inst1.secret0123456789'
const GOOD = { mode: 'dev', listen: { host: '127.0.0.1', port: 0 }, engine: { authMode: 'managed', modelUpstreams: { anthropic: GATE } } }
const load = (file: object, env: Record<string, string> = {}) => loadAppConfig({ argv: ['--config', write(`s-${Math.random().toString(36).slice(2)}.json`, file)], env: { MYCEL_DEMO: freeFile, ...env } })

describe('a free-roam demo file starts only where only the gate reaches it', () => {
  test('managed AI, 127.0.0.1, no relay and the gate as upstream: accepted, with info logs and no dev features', () => {
    const cfg = load(GOOD)
    expect(cfg.demo?.kind).toBe('freeRoam')
    expect(cfg.logLevel).toBe('info')
    const f = featuresOf(cfg)
    expect(f.selfUpdate).toBe(false)
    expect(f.hostDiagnostics).toBe(false)
    expect(f.connectionChange).toBe(false)
    expect(f.connectedFolders).toBe(false)
    expect(f.pluginFileInstall).toBe(false)
    // a scripted demo keeps what it had
    expect(featuresOf({ ...cfg, demo: SCRIPTED }).selfUpdate).toBe(true)
  })

  test('refused without managed AI, on another listener, with a relay, TLS or a tunnel, another upstream, the dev environment or debug logs', () => {
    const bad: [object, Record<string, string>, RegExp][] = [
      [{ ...GOOD, engine: { ...GOOD.engine, authMode: 'local-login' } }, {}, /authMode must be "managed"/],
      [{ ...GOOD, listen: { host: '0.0.0.0', port: 0 } }, {}, /listen\.host must be 127\.0\.0\.1/],
      [GOOD, { MYCEL_HOST: '192.168.1.5' }, /listen\.host must be 127\.0\.0\.1/],
      [{ ...GOOD, relay: { url: 'wss://relay.example.com/connect' } }, {}, /the relay must be off/],
      [GOOD, { MYCEL_RELAY_URL: 'wss://relay.example.com/connect' }, /the relay must be off/],
      [{ ...GOOD, tunnel: { host: 'demo.example.com' } }, {}, /no tls, tunnel or tailnet/],
      [{ ...GOOD, engine: { authMode: 'managed' } }, {}, /modelUpstreams\.anthropic must be the gate/],
      [{ ...GOOD, engine: { authMode: 'managed', modelUpstreams: { anthropic: 'https://api.anthropic.com' } } }, {}, /modelUpstreams\.anthropic must be the gate/],
      [GOOD, { MYCEL_DEV_ENV: '1' }, /MYCEL_DEV_ENV must be off/],
      [GOOD, { MYCEL_LOG_LEVEL: 'debug' }, /no debug log level/],
    ]
    for (const [file, env, why] of bad) {
      let err: unknown
      try { load(file, env) } catch (e) { err = e }
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as Error).message).toMatch(why)
    }
    // and never outside a development server, like any demo
    expect(() => load({ ...GOOD, mode: 'prod' })).toThrow(/development demo server only/)
  })

  test('the file itself: one person, the free-roam fields only with kind freeRoam', () => {
    const two = write('two.json', { ...FREE, personas: [...FREE.personas, { key: 'lead', username: 'leo', intro: 'x', questions: [] }] })
    expect(() => loadAppConfig({ argv: ['--config', write('g1.json', GOOD)], env: { MYCEL_DEMO: two } })).toThrow(/exactly one persona/)
    const stray = write('stray.json', { ...SCRIPTED, limitTokens: 1000 })
    expect(() => loadAppConfig({ argv: ['--config', write('g2.json', { mode: 'dev' })], env: { MYCEL_DEMO: stray } })).toThrow(/for kind "freeRoam" only/)
  })
})

/** an endpoint's path with every :param filled */
const fill = (ep: Endpoint) => ep.path.replace(/:[A-Za-z]+/g, 'x0000000000000000')
const FENCED = Object.entries(API).filter(([, ep]) => freeRoamFenceOf(ep as Endpoint) !== null) as [string, Endpoint][]

describe('a free-roam demo server', () => {
  let h: Harness
  let owner: Client
  let mina: Client
  let minaId = ''
  beforeAll(async () => {
    // seeded as a scripted demo (the snapshot builder's part), then started as the free-roam instance it becomes
    h = await harness('demo-free-roam', { mode: 'dev', demo: SCRIPTED })
    owner = await withOwner(h)
    minaId = (await addMember(h, owner, { username: 'mina', password: PW })).id
    ;(h.ctx.config as { demo?: DemoFile }).demo = FREE
    startFreeRoam(h.ctx)
    mina = h.client()
    await mina.call('POST', API.demoSwitch.path, { key: 'newHire' })
  })
  afterAll(async () => { setDemoLimit(h.ctx.db, null); await h.close() })

  test('with the gate key in the demo file only the gate signs in: no key, a wrong key and another instance\'s key are refused', async () => {
    const hash = (k: string) => crypto.createHash('sha256').update(k).digest('hex')
    const KEY = 'this-instance-gate-key', OTHER = 'another-instance-gate-key'
    const config = h.ctx.config as { demo?: DemoFile }
    config.demo = { ...FREE, gateKeySha256: hash(KEY) }
    try {
      const sw = (key?: string) => { const c = h.client(); return c.try('POST', API.demoSwitch.path, { key: 'newHire' }, key === undefined ? {} : { [DEMO_GATE_KEY_HEADER]: key }) }
      for (const bad of [undefined, '', 'wrong', OTHER, hash(KEY)]) {
        const r = await sw(bad)
        expect(r.status).toBe(401)
        expect(r.headers.getSetCookie()).toEqual([])
      }
      const good = await sw(KEY)
      expect(good.status).toBe(200)
      expect(good.headers.getSetCookie().join()).toContain('__Host-sid=')
      // neither the key nor its hash in what a page or the API reads
      const info = JSON.stringify(await mina.call('GET', API.demoInfo.path))
      expect(info).not.toContain(hash(KEY)); expect(info).not.toContain(KEY); expect(info).not.toContain('gateKey')
    } finally { config.demo = FREE }
  })

  test('the gate key is for a free-roam demo only; without one the guided demo and the builder sign in as before', () => {
    expect(gateKeyOk({}, undefined)).toBe(true)
    expect(gateKeyOk({ gateKeySha256: 'a'.repeat(64) }, undefined)).toBe(false)
    expect(DemoFile.safeParse({ ...FREE, gateKeySha256: 'a'.repeat(64) }).success).toBe(true)
    expect(DemoFile.safeParse({ ...FREE, gateKeySha256: 'short' }).success).toBe(false)
    expect(DemoFile.safeParse({ ...SCRIPTED, gateKeySha256: 'a'.repeat(64) }).success).toBe(false)
  })

  test('the visitor signs in as the demo person (Mina) through the switch, and sees no development server', async () => {
    const me = await mina.call('GET', API.me.path)
    expect(me.user.username).toBe('mina')
    expect(me.user.role).toBe('member')
    expect(me.server.dev).toBe(false)
    expect(me.server.features.selfUpdate).toBe(false)
    expect(me.server.features.hostDiagnostics).toBe(false)
    const info = await mina.call('GET', API.demoInfo.path)
    expect(info).toMatchObject({ company: 'Steepling', current: 'newHire', kind: 'freeRoam', used: 0, cap: 5000, signupUrl: 'https://example.com/start' })
    // what demo-gate checks before an instance is warm (demo-gate/src/pool.ts checkFenced): freeRoam, no builder
    expect(info.builder).toBeUndefined()
    // QA TC-6790: the team default language, also signed out: the gate denies GET /api/setup, so the sign-in page reads
    // the instance's language here
    updateTeamSettings(h.ctx.db, { defaultLocale: 'ja' })
    try {
      expect((await mina.call('GET', API.demoInfo.path)).locale).toBe('ja')
      expect((await h.client().call('GET', API.demoInfo.path)).locale).toBe('ja')
    } finally { updateTeamSettings(h.ctx.db, { defaultLocale: info.locale }) }
    expect(JSON.stringify(info)).not.toContain(PW)
    // QA TC-5578 / review finding 2 on #105: the session cookie is __Host-sid on the instance's plain http too, never
    // the plain-http "mycel-dev-sid" nor a bare "sid"; it was read back (me above) over that http
    expect(FREE_ROAM_SESSION_COOKIE).toBe(SESSION_COOKIE)
    expect(mina.cookie).toMatch(/^__Host-sid=[A-Za-z0-9_-]{20,}$/)
    // what the browser needs for a __Host- cookie: Secure, Path=/ and no Domain (the gate keeps all three)
    const set = sessionCookie('http://127.0.0.1:4000/api/demo/persona', 'x'.repeat(32), 60, true)
    expect(set).toBe(`__Host-sid=${'x'.repeat(32)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`)
    expect(set).not.toMatch(/domain=/i)
    // every other server keeps its names: the plain-http one and __Host-sid on https (free roam too)
    expect(cookieFor('http://127.0.0.1:4000/api/auth/login')).toEqual({ name: DEV_SESSION_COOKIE, secure: false })
    expect(cookieFor('https://team.example/api/auth/login')).toEqual({ name: SESSION_COOKIE, secure: true })
    expect(cookieFor('http://127.0.0.1:4000/api/auth/login', true)).toEqual({ name: SESSION_COOKIE, secure: true })
    expect(cookieFor('https://team.example/api/auth/login', true)).toEqual({ name: SESSION_COOKIE, secure: true })
    expect(sessionCookie('http://127.0.0.1:4000/api/auth/login', 'x'.repeat(32), 60)).toBe(`mycel-dev-sid=${'x'.repeat(32)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`)
    // on that plain http the instance reads only its own name: the dev name or a bare "sid" is no session there
    const req = (cookie: string) => new Request('http://127.0.0.1:4000/api/me', { headers: { cookie } })
    const tok = 'y'.repeat(32)
    expect(readToken(req(`__Host-sid=${tok}`), true)).toEqual({ token: tok, via: 'cookie' })
    expect(readToken(req(`mycel-dev-sid=${tok}`), true)).toBeNull()
    expect(readToken(req(`sid=${tok}`), true)).toBeNull()
    // a normal plain-http server: the dev name only, as before
    expect(readToken(req(`mycel-dev-sid=${tok}`))).toEqual({ token: tok, via: 'cookie' })
    expect(readToken(req(`__Host-sid=${tok}`))).toBeNull()
  })

  test('the My setup card says demo: no tools row to do, so tools is sent done (QA TC-6473)', async () => {
    const { welcome } = await mina.call('GET', API.getMemberWelcome.path)
    expect(welcome).not.toBeNull()
    expect(welcome.demo).toBe(true)
    expect(welcome.steps.tools).toBe(true)
  })

  test('usage, cost, engine and model reads are refused in the visitor\'s words (QA TC-5578)', async () => {
    for (const p of [`${API.myUsage.path}?period=month`, API.chatEngines.path]) {
      const r = await mina.try('GET', p)
      expect(r.status).toBe(403)
      expect(r.body.error.params).toEqual({ reason: 'demo_fenced', area: 'usage' })
      expect(['데모에서는 사용량과 AI 엔진·모델을 볼 수 없어요.', "Not in the demo: usage and the AI's engine and model aren't shown."]).toContain(r.body.error.message)
      expect(JSON.stringify(r.body)).not.toMatch(/costUsd|claude-code|sonnet|opus/i)
    }
  })

  test('the team\'s AI is one "Demo AI" stand-in connection; every other one is off, members\' own are off', async () => {
    const rows = listRows(h.ctx.db)
    const demo = rows.filter((r) => r.label === DEMO_AI_LABEL && r.kind === 'anthropic-oauth' && r.owner_user_id === null)
    expect(demo.length).toBe(1)
    expect(demo[0]!.status).toBe('ok')
    expect(demo[0]!.disabled).toBe(0)
    expect(demo[0]!.expires_at).toBeNull()
    expect(rows.filter((r) => r.id !== demo[0]!.id).every((r) => r.disabled === 1)).toBe(true)
    // shaped like a Claude subscription token, and the server's own (not something a person typed)
    const token = (credentialsOf(h.ctx).vault.decrypt(demo[0]!.id, 'anthropic-oauth', demo[0]!.secret_enc, demo[0]!.key_version) as { token: string }).token
    expect(CLAUDE_TOKEN_RE.test(token)).toBe(true)
    // starting again keeps the one connection
    startFreeRoam(h.ctx)
    expect(listRows(h.ctx.db).filter((r) => r.label === DEMO_AI_LABEL).length).toBe(1)
  })

  test('every fenced endpoint is refused before its body is read, for the visitor, the owner and anyone signed out', async () => {
    const names = new Set(FENCED.map(([n]) => n))
    // what the plan's fences name, each refused
    for (const n of ['setup', 'login', 'changePassword', 'completePasswordReset', 'requestAccountDeletion', 'appSignIn',
      'createInvite', 'createGuestInvite', 'acceptInvite', 'createTeamLink', 'joinTeamLink', 'listUsers', 'updateUser',
      'createCredential', 'createMyCredential', 'startMyCredentialLogin', 'authorizeDrive', 'authorizeGoogleApp', 'createIntegration',
      'connectIntegrationTemplate', 'startSlackSignIn', 'decideRemoteConnectorConsent', 'createRoomApp',
      'createScheduleFromTemplate', 'runScheduleNow', 'registerPushDevice', 'subscribePush', 'connectInfo', 'installPlugin',
      'devEnv', 'myDevEnvRuns', 'transcribe', 'renderPromoVideo', 'pollLocalCalls', 'diagnostics', 'startUpdate',
      // QA TC-5578: the real AI account's engine, model and cost
      'myUsage', 'chatEngines',
      // the free-roam audit (QA TC-5613): "Bring my skills"
      'contributeSkills', 'createSkillShare']) {
      expect(names.has(n)).toBe(true)
    }
    // what a visitor uses stays
    for (const n of ['me', 'demoInfo', 'demoSwitch', 'logout', 'createChat', 'sendMessage', 'listSchedules', 'upload', 'uploadAttachment',
      'sendRoomMessage', 'listPeople', 'createMemory', 'mySlack', 'listRoomApps', 'getAiAccess', 'listIntegrations']) {
      expect(names.has(n)).toBe(false)
    }
    const anon = h.client()
    for (const [n, ep] of FENCED) {
      for (const who of [mina, owner, anon]) {
        const r = await who.try(ep.method, fill(ep), ep.method === 'GET' ? undefined : {})
        if (r.status !== 403 || r.body?.error?.params?.reason !== 'demo_fenced') throw new Error(`${n} (${ep.method} ${ep.path}) answered ${r.status} ${JSON.stringify(r.body)}`)
      }
    }
    // the owner's password stays out of reach too: no sign-in with it
    expect((await h.client().try('POST', API.login.path, { username: 'olga', password: 'x' })).status).toBe(403)
  })

  test('the profile keeps its name and e-mail; other preferences change', async () => {
    expect((await mina.try('PATCH', API.updateMe.path, { name: 'Someone Else' })).body.error.params).toEqual({ reason: 'demo_fenced', area: 'account' })
    expect((await mina.try('PATCH', API.updateMe.path, { email: 'x@example.com' })).status).toBe(403)
    expect((await mina.try('PATCH', API.updateMyProfile.path, { name: 'Someone Else' })).status).toBe(403)
    expect((await mina.try('PATCH', API.updateMe.path, { locale: 'en' })).status).toBe(200)
    expect((await mina.try('PATCH', API.updateMyProfile.path, { title: 'Marketing' })).status).toBe(200)
  })

  test('uploads: one file up to the file limit, all of them up to the instance limit', async () => {
    const up = (bytes: number, name: string) => {
      const fd = new FormData()
      fd.set('folder', `users/${minaId}`)
      fd.set('file', new File([new Uint8Array(bytes).fill(65)], name))
      return h.fetch('/api/files/upload', { method: 'POST', headers: { cookie: mina.cookie!, 'x-mycel-csrf': '1' }, body: fd })
    }
    const big = await up(5000, 'big.txt')
    expect(big.status).toBe(413)
    expect((await big.json()).error.params).toMatchObject({ reason: 'demo_upload', fileMax: 4000, totalMax: 6000 })
    expect((await up(3500, 'a.txt')).status).toBe(201)
    // 3500 + 3500 > 6000: the instance's total
    const second = await up(3500, 'b.txt')
    expect(second.status).toBe(413)
    expect((await second.json()).error.params.reason).toBe('demo_upload')
    expect((await up(2000, 'c.txt')).status).toBe(201)
    // a chunked upload says its size first
    const s = await mina.try('POST', API.createUploadSession.path, { target: { kind: 'path', path: `users/${minaId}/d.bin` }, size: 5000, sha256: 'a'.repeat(64) })
    expect(s.status).toBe(413)
  })

  test('the demo limit: cache reads and cache writes count 0.1; GET /api/demo says it; at the limit a send is refused with demo_limit', async () => {
    const cred = listRows(h.ctx.db).find((r) => r.label === DEMO_AI_LABEL)!.id
    const broker = createBroker(credentialsOf(h.ctx))
    const turn = (id: string) => h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', ?, 'claude-code', 'done')").run(id, minaId)
    turn('t-demo-1')
    broker.record(cred, 't-demo-1', 'claude-sonnet-5-5', { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 10_000, output_tokens: 50 })
    const row = h.ctx.db.query("SELECT input_tokens, output_tokens FROM turns WHERE id = 't-demo-1'").get() as { input_tokens: number; output_tokens: number }
    // 100 uncached + 0.1 x 200 cache writes + 0.1 x 10,000 cache reads; output as it is
    expect(row).toEqual({ input_tokens: 1120, output_tokens: 50 })
    expect(demoUsed(h.ctx.db)).toBe(1170)
    expect((await mina.call('GET', API.demoInfo.path)).used).toBe(1170)

    turn('t-demo-2')
    broker.record(cred, 't-demo-2', 'claude-sonnet-5-5', { input_tokens: 3000, output_tokens: 600 })
    expect(demoUsed(h.ctx.db)).toBe(4770)
    // under the limit: nothing refuses for the limit (asked of the check itself: a real send here would start the
    // engine, and on a checkout whose socket paths fit it is still answering when the next send comes, a 409)
    expect(budgetBlock(h.ctx.db, minaId, 'en')).toBeNull()
    const chat = await mina.call('POST', API.createChat.path, {})
    turn('t-demo-3')
    broker.record(cred, 't-demo-3', 'claude-sonnet-5-5', { input_tokens: 180, output_tokens: 50 })
    expect(demoLimitState(h.ctx.db)).toEqual({ used: 5000, cap: 5000 })
    const r =await mina.try('POST', `/api/chats/${chat.id}/messages`, { content: 'hello', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] })
    expect(r.status).toBe(429)
    expect(r.body.error.code).toBe('budget_exceeded')
    expect(r.body.error.params).toEqual({ reason: 'demo_limit', used: 5000, cap: 5000 })
    expect(r.body.error.message).toContain("You've used this demo's AI")
  })
})

describe('a free-roam demo started as one', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('demo-free-roam-start', { mode: 'dev', demo: FREE }) })
  afterAll(async () => { setDemoLimit(h.ctx.db, null); await h.close() })

  test('the default limit when the file names none, and the Demo AI connection from the start', () => {
    expect(demoLimitState(h.ctx.db)?.cap).toBe(5000)
    expect(DEMO_LIMIT_DEFAULT).toBe(300_000)
    expect(listRows(h.ctx.db).some((r) => r.label === DEMO_AI_LABEL)).toBe(true)
  })

  test('converters never read demo-gate\'s folders: the fixed one and the ones the gate names', () => {
    // started without MYCEL_DEMO_GATE_DIRS: the fixed folder only
    expect(demoDenyReadDirs()).toEqual([DEMO_GATE_DIR])
    expect(freeRoamDenyRead('/var/dg/state:/var/dg/secrets:relative::/')).toEqual([DEMO_GATE_DIR, '/var/dg/state', '/var/dg/secrets'])
    setDemoDenyRead(freeRoamDenyRead('/opt/dg/secrets'))
    try {
      const p = sandboxProfile({ cmd: '/bin/cat', workDir: tmp, readPaths: [], denyRead: [] })
      const denies = p.split('\n').find((l) => l.startsWith('(deny file-read-data (subpath'))!
      expect(denies).toContain('(subpath "/private/var/demo-gate")')
      expect(denies).toContain('(subpath "/opt/dg/secrets")')
    } finally { setDemoDenyRead([DEMO_GATE_DIR]) }
    // the engine's own sandbox denies by default and opens nothing of /private/var but system data
    const sb = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'scripts', 'macos', 'engine.sb'), 'utf8')
    expect(sb).toContain('(deny default)')
    expect(sb).not.toMatch(/\(allow file-read[^)]*\(subpath "\/private\/var"\)/)
    expect(sb).not.toContain('demo-gate')
  })

  test('sign-in callbacks, room app webhooks and the remote MCP server answer 404; the web app is no developer page', async () => {
    for (const [m, p] of [['POST', '/in/abc'], ['POST', '/oauth/register'], ['GET', '/oauth/authorize'], ['POST', '/oauth/token'], ['GET', '/mcp'], ['POST', '/mcp'],
      ['GET', '/.well-known/oauth-authorization-server'], ['GET', '/.well-known/oauth-protected-resource'], ['PUT', '/connector-uploads/abc']] as const) {
      const r = await h.fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })
      expect([p, r.status]).toEqual([p, 404])
    }
    for (const cb of ['/api/integrations/callback', '/api/integrations/google-drive/callback', '/api/slack/callback']) {
      const r = await h.fetch(cb + '?state=x&code=y')
      expect(r.status === 404 || r.status === 403).toBe(true)
    }
    const page = await h.fetch('/', { headers: { accept: 'text/html' } })
    expect(await page.text()).not.toContain('dev server')
  })
})

describe('a free-roam turn: its tools, no web search or sub-agents, the demo line', () => {
  let h: BHarness
  let alice: TestSocket
  const fake = (d: unknown) => '@fake ' + JSON.stringify(d)
  beforeAll(async () => {
    h = await startHarness({ name: 'demo-free-roam-turn' })
    ;(h.ctx.config as { demo?: DemoFile }).demo = { ...FREE, personas: [{ key: 'newHire', username: 'alice', intro: 'x', questions: [] }] }
    alice = await h.ws('alice', { windowId: 'win-free-roam' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h.close() })
  const chat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id

  test('every refused tool is left out; the rest of the registry is offered', async () => {
    const done = (await ask(h, alice, 'alice', await chat(), fake({ echo: 'tools' }))).done
    const offered = done.content.split(',')
    for (const t of Object.keys(FREE_ROAM_REFUSED_TOOLS)) expect(offered).not.toContain(t)
    for (const t of ['read', 'write', 'make_file', 'remember', 'ask_user', 'post_to_room', 'share_file', 'artifact', 'intro_deck', 'skill', 'rooms', 'save_connector_file']) expect(offered).toContain(t)
  })

  test('the snapshot builder\'s Higgsfield keeps the fake\'s tools, and the free-roam turn offers them (QA TC-5559)', async () => {
    const free = h.ctx.config.demo
    // the builder runs on the scripted demo the snapshot starts as (its routes are the owner's, fenced in free roam)
    ;(h.ctx.config as { demo?: DemoFile }).demo = { ...SCRIPTED, builder: true, personas: [{ key: 'newHire', username: 'alice', intro: 'x', questions: [] }] }
    try {
      const r = await h.api('dana').call(API.demoBuilderConnection, { body: { service: 'higgsfield', account: { name: 'Steepling', email: 'team@steepling.example' } } })
      const row = h.ctx.db.query('SELECT tools_json FROM integrations WHERE id = ?').get(r.id) as { tools_json: string }
      const saved = JSON.parse(row.tools_json) as { name: string }[]
      expect(saved.length).toBeGreaterThan(0)
      expect(saved.map((t) => t.name)).toEqual(HIGGSFIELD_TOOLS.map((t) => t.name))
    } finally { (h.ctx.config as { demo?: DemoFile | null }).demo = free }
    const offered = (await ask(h, alice, 'alice', await chat(), fake({ echo: 'tools' }))).done.content.split(',')
    expect(offered).toContain('team_higgsfield__generate_image')
    expect(offered.filter((n) => n.startsWith('team_higgsfield__')).sort()).toEqual(HIGGSFIELD_TOOLS.map((t) => `team_higgsfield__${t.name}`).sort())
  })

  test('a refused tool called anyway is unknown; intro_deck\'s site reader is refused, nothing fetched', async () => {
    const wf = (await ask(h, alice, 'alice', await chat(), fake({ tool: 'web_fetch', args: { url: 'https://example.com' }, sayResult: true }))).done.content
    expect(wf).toMatch(/unknown tool|not (offered|available)|Error/i)
    const sc = (await ask(h, alice, 'alice', await chat(), fake({ tool: 'schedule_create', args: {}, sayResult: true }))).done.content
    expect(sc).toMatch(/unknown tool|not (offered|available)|Error/i)
    const deck = (await ask(h, alice, 'alice', await chat(), fake({ tool: 'intro_deck', args: { step: 'read', urls: ['https://example.com'] }, sayResult: true }))).done.content
    expect(deck).toContain('reading web pages is not available in this demo')
  })

  test('the engine gets no WebSearch and no Agent; the instructions carry the demo line', async () => {
    const args = (await ask(h, alice, 'alice', await chat(), fake({ echo: 'args' }))).done.content
    const argv = JSON.parse(args) as string[]
    const denied = argv[argv.indexOf('--disallowedTools') + 1] ?? ''
    expect(denied.split(',')).toContain('WebSearch')
    expect(denied.split(',')).toContain('Agent')
    const system = (await ask(h, alice, 'alice', await chat(), fake({ echo: 'system' }))).done.content
    expect(system).toContain("This is a public demo of a fictional company (Steepling). The dev environment, scheduled tasks, connecting new services and inviting people aren't available in the demo: say so in one sentence and do what you can.")
    // QA TC-5572: account, email, usage and billing, AI providers: not in the demo, and no page named for them
    expect(system).toContain('Changing or deleting the account, changing their name or email address on their profile, changing the password, usage, costs and billing, and the AI providers (which AI answers, its account or plan) are not available in the demo either')
    expect(system).toContain('never point to a page or setting for it')
  })
})

describe('what a visitor reads when a free-roam answer fails', () => {
  test('a failed answer says the demo is busy, never what the engine said', async () => {
    const h = await startHarness({ name: 'demo-free-roam-fail' })
    try {
      ;(h.ctx.config as { demo?: DemoFile }).demo = { ...FREE, personas: [{ key: 'newHire', username: 'alice', intro: 'x', questions: [] }] }
      const sock = await h.ws('alice', { windowId: 'win-free-roam-fail' })
      await sock.next('hello')
      const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
      const done = (await ask(h, sock, 'alice', chat, '@fake ' + JSON.stringify({ fail: 'Claude AI usage limit reached|1767225600' }))).done
      sock.close()
      expect(done.status).toBe('error')
      expect(done.error).toEqual({ code: done.error!.code, message: 'The demo is busy, try again in a bit.', params: { reason: 'demo_busy' } })
    } finally { await h.close() }
  })

  test('the demo limit and the gate\'s rest stay budget stops in their own words; anything else is busy', () => {
    expect(demoRestError('en')).toEqual({ code: 'budget_exceeded', message: 'The live demo is resting, try again later.', params: { reason: 'demo_rest' } })
    const limit = { code: 'budget_exceeded' as const, message: "You've used this demo's AI.", params: { reason: 'demo_limit', used: 1, cap: 1 } }
    expect(freeRoamTurnError(limit, 'en')).toBe(limit)
    expect(freeRoamTurnError(demoRestError('ko'), 'ko').params?.reason).toBe('demo_rest')
    expect(freeRoamTurnError({ code: 'rate_limited', message: 'Your Claude subscription is limited until 3:00', params: { retryAt: 'x' } }, 'en'))
      .toEqual({ code: 'rate_limited', message: 'The demo is busy, try again in a bit.', params: { reason: 'demo_busy' } })
    // a team budget is not the demo's words either
    expect(freeRoamTurnError({ code: 'budget_exceeded', message: 'Ask an admin', params: { resetsAt: 'x' } }, 'en').message).toBe('The demo is busy, try again in a bit.')
  })
})

describe('the model proxy on a free-roam demo', () => {
  const env = makeEnv('demo-free-roam-proxy')
  let answer: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: {} }
  let hits = 0
  /** the next answers' usage, in order (then the default) */
  const usages: Record<string, number>[] = []
  const upstream = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch() {
      hits++
      if (answer.status !== 200) return Response.json(answer.body, { status: answer.status, headers: { 'request-id': 'req_011CTestDemo', ...answer.headers } })
      return Response.json({ id: 'm', model: 'claude-sonnet-5-5', content: [], usage: usages.shift() ?? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1000 } })
    },
  })
  const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: `http://127.0.0.1:${upstream.port}/i/inst.secret` } })
  ;(t.cc.config as { demo?: DemoFile }).demo = FREE
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
  const cred = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-demo' + 'x'.repeat(40), { label: DEMO_AI_LABEL })
  const events: { turn: string; ev: ProxyTurnEvent }[] = []
  let proxy: Awaited<ReturnType<typeof startModelProxy>>
  beforeAll(async () => { proxy = await startModelProxy({ db: env.db, broker: createBroker(t.cc), onTurnEvent: (turn, ev) => events.push({ turn, ev }) }) })
  afterAll(async () => { setDemoLimit(env.db, null); await proxy.stop(); upstream.stop(true) })
  let n = 0
  const call = () => {
    const turn = `pt-${++n}`
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'alice', 'claude-code', 'running')").run(turn)
    const token = issueProxyToken(env.db, turn, 'alice', { credentialId: cred, family: 'anthropic' })
    return fetch(proxy.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) })
  }
  const err = (type: string, message: string) => ({ type: 'error', error: { type, message } })

  test('upstream 400, 401, 402 and 403 from the loopback gate never mark the stand-in connection', async () => {
    for (const a of [
      { status: 403, body: err('permission_error', 'This organization has been disabled.') },
      { status: 403, body: err('authentication_error', 'OAuth token has been revoked. Please obtain a new token.') },
      { status: 402, body: err('billing_error', 'Payment required') },
      { status: 400, body: err('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.') },
      { status: 401, body: err('authentication_error', 'invalid bearer') },
    ]) {
      answer = a
      const r = await call()
      expect(r.status).toBe(a.status)
      const row = getRow(env.db, cred)!
      expect([row.status, row.status_code, row.limited_until]).toEqual(['ok', null, null])
    }
    expect(events.some((e) => e.ev.type === 'credential')).toBe(false)
  })

  test('no check, long limit or mark of any kind touches the stand-in; a check sends nothing anywhere', async () => {
    hits = 0
    expect(await verifySecret(t.cc, 'anthropic-oauth', 'sk-ant-oat01-demo' + 'x'.repeat(40))).toEqual({ result: 'unverified', upstreamStatus: null })
    expect(hits).toBe(0)
    markInvalid(t.cc, cred, 'upstream_401', 401)
    markNoCredit(t.cc, cred)
    markNeedsReconnect(t.cc, cred, 'refresh_failed')
    // a subscription's long limit: the answer ends, the connection is not held out
    answer = { status: 429, body: err('rate_limit_error', 'limit'), headers: { 'retry-after': '7200' } }
    expect((await call()).status).toBe(403)
    const row = getRow(env.db, cred)!
    expect([row.status, row.status_code, row.limited_until]).toEqual(['ok', null, null])
  })

  test('the gate\'s own stop (403 budget_exceeded, no request-id) ends the turn as a budget stop, nothing marked', async () => {
    events.length = 0
    answer = { status: 403, body: err('budget_exceeded', 'budget_exceeded') }
    const r = await call()
    expect(r.status).toBe(403)
    expect(events.map((e) => e.ev)).toContainEqual({ type: 'budget', demoRest: true })
    expect(getRow(env.db, cred)!.status).toBe('ok')
    // the gate's busy answer passes on as it came, and is no budget stop
    events.length = 0
    answer = { status: 503, body: err('api_error', 'The demo is busy, try again in a bit.') }
    expect((await call()).status).toBe(503)
    expect(events.some((e) => e.ev.type === 'budget')).toBe(false)
  })

  test('a fresh copy\'s first question writes the instructions to the cache: counted at 0.1, the bar still says about 7', async () => {
    answer = { status: 200, body: {} }
    setDemoLimit(env.db, DEMO_LIMIT_DEFAULT)
    const before = demoUsed(env.db)
    const first = n
    // one question, three requests, as a cold copy's first one on demo.trina.app (about 90k true tokens): the system
    // prompt and the tools written to the cache, then read back while the answer works
    usages.push(
      { input_tokens: 3, cache_creation_input_tokens: 68_000, output_tokens: 150 },
      { input_tokens: 3, cache_creation_input_tokens: 2_500, cache_read_input_tokens: 68_000, output_tokens: 400 },
      { input_tokens: 3, cache_creation_input_tokens: 1_800, cache_read_input_tokens: 70_500, output_tokens: 900 },
    )
    for (let i = 0; i < 3; i++) expect((await call()).status).toBe(200)
    // (3 + 6,800 + 150) + (3 + 250 + 6,800 + 400) + (3 + 180 + 7,050 + 900); with writes counted fully it was 87,609
    expect(demoUsed(env.db) - before).toBe(22_539)
    expect(demoQuestionsLeft(demoUsed(env.db), DEMO_LIMIT_DEFAULT)).toBe(7)
    // a warm question after it (the cache read back, a little written): 16,766, under one 35k question
    usages.push(
      { input_tokens: 3, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 72_300, output_tokens: 300 },
      { input_tokens: 3, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 75_300, output_tokens: 1_200 },
    )
    for (let i = 0; i < 2; i++) expect((await call()).status).toBe(200)
    expect(demoQuestionsLeft(demoUsed(env.db), DEMO_LIMIT_DEFAULT)).toBe(7)
    expect(usages).toEqual([])
    // the next test counts from a small limit: these turns go
    for (let k = first + 1; k <= n; k++) env.db.query('DELETE FROM turns WHERE id = ?').run(`pt-${k}`)
  })

  test('the weight goes through the proxy too, and at the limit the request ends on the budget path (403 budget_exceeded, never 529)', async () => {
    answer = { status: 200, body: {} }
    setDemoLimit(env.db, 500)
    const before = demoUsed(env.db)
    expect((await call()).status).toBe(200)
    // 10 + 0.1 x 1000 + 2
    expect(demoUsed(env.db) - before).toBe(112)
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, input_tokens, output_tokens, usage_source) VALUES ('pt-full', 'c', 'alice', 'claude-code', 'done', 500, 0, 'proxy')").run()
    events.length = 0
    const r = await call()
    expect(r.status).toBe(403)
    expect((await r.json()).error.message).toBe('budget_exceeded')
    expect(events.map((e) => e.ev.type)).toContain('budget')
  })
})

// The snapshot builder's room-times (server/src/routes/demo-builder.ts): a room's messages get the story's times, and so
// do the notices they made and the threads' follows, or Activity sorts the story's mentions at the build's time (and a
// notice older than 30 days drops out by its real age)
describe('the snapshot builder dates a room\'s notices and thread follows with its messages', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('demo-room-times', { mode: 'dev', demo: { ...SCRIPTED, builder: true } }); owner = await withOwner(h) })
  afterAll(async () => { await h.close() })

  test('a mention, a run of mentions and a thread reply: each notice at its message\'s time, a follow at the first reply\'s', async () => {
    const mina = await addMember(h, owner, { username: 'mina', password: PW })
    const sara = await addMember(h, owner, { username: 'sara' })
    const room = await sara.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mina.id], name: 'Story room' })
    const send = (c: Client, body: string, more: object = {}) => c.call('POST', `/api/rooms/${room.id}/messages`, { body, mentions: body.includes('@MINA') ? [mina.id] : [], fileIds: [], clientMessageId: crypto.randomUUID(), ...more })
    const first = await send(sara.client, '@MINA first mention')
    const second = await send(sara.client, '@MINA second mention, while the first is unread')
    const root = await send(sara.client, 'a thread root')
    const reply1 = await send(mina.client, 'my reply', { threadRootId: root.id })
    const reply2 = await send(sara.client, 'a reply Mina follows', { threadRootId: root.id })
    const day = 86_400_000, now = Date.now()
    const at = (days: number) => new Date(now - days * day).toISOString()
    const times = [[first, 10], [second, 9], [root, 8], [reply1, 7], [reply2, 6]].map(([m, d]) => ({ messageId: (m as { id: string }).id, at: at(d as number) }))
    const r = await owner.call('POST', '/api/demo/builder/room-times', { roomId: room.id, times })
    expect(r.updated).toBe(5)
    const timeOf = new Map(times.map((t) => [t.messageId, t.at]))
    const notices = h.ctx.db.query("SELECT event_type, source_id, created_at, last_seq, last_at FROM room_notices WHERE user_id = ? AND room_id = ? ORDER BY created_at").all(mina.id, room.id) as { event_type: string; source_id: string; created_at: string; last_seq: number | null; last_at: string | null }[]
    for (const n of notices) expect(n.created_at, n.source_id).toBe(timeOf.get(n.source_id)!)
    // each mention is a notice of its own (docs/decisions/20261120-push-every-message.md), each at its message's time;
    // the thread reply its own notice too
    const mentions = notices.filter((n) => n.event_type === 'room.mention')
    expect(mentions.map((n) => n.source_id)).toEqual([first.id, second.id])
    expect(mentions.map((n) => n.created_at)).toEqual([at(10), at(9)])
    expect(notices.some((n) => n.source_id === reply2.id)).toBe(true)
    const follows = h.ctx.db.query('SELECT user_id, created_at FROM room_thread_follows WHERE root_id = ? ORDER BY user_id').all(root.id) as { user_id: string; created_at: string }[]
    expect(follows.length).toBeGreaterThanOrEqual(2)
    for (const f of follows) expect(f.created_at).toBe(at(7))
    // nothing of the room keeps the build's time
    expect((h.ctx.db.query('SELECT count(*) n FROM room_notices WHERE room_id = ? AND created_at > ?').get(room.id, at(5)) as { n: number }).n).toBe(0)
  })

  test('a member is refused; without the demo file\'s builder: true the route is not there', async () => {
    const member = (await addMember(h, owner, { username: 'tom' })).client
    expect((await member.raw('POST', '/api/demo/builder/room-times', { roomId: '01a1f758-2656-7058-84d5-497e9999f691', times: [] })).status).toBeGreaterThanOrEqual(403)
    ;(h.ctx.config as { demo?: DemoFile }).demo = SCRIPTED
    try {
      expect((await owner.raw('POST', '/api/demo/builder/room-times', { roomId: '01a1f758-2656-7058-84d5-497e9999f691', times: [] })).status).toBe(404)
    } finally { (h.ctx.config as { demo?: DemoFile }).demo = { ...SCRIPTED, builder: true } }
  })
})
