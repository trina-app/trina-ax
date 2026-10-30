// Three ways to run the same server (docs/DECISIONS.md "클라우드 리눅스 서버"): the deployment switch and its feature
// table (server/src/system/deployment.ts), the Linux defaults of the layout (L02), and what Team AX Cloud refuses: changing
// the connection, the in-app update / roll-back, office updates, connected folders, and an API engine address that is
// not public https (review SEC-01..03, UX-07, UX-08). Connected folders on a Linux self-host take /mnt, /media, /srv.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { FirewallStatus } from '@mycel/shared/install'
import { ConfigError, allowedCredentialKinds, loadAppConfig, prodBase, prodLogDir } from '../../server/src/app-config'
import { deploymentOf, featuresOf, hostKind, isHosted, runKindOf } from '../../server/src/system/deployment'
import { resolveLayout } from '../../server/src/system/layout'
import { apiEngineFetch, assertPublicHttps, checkApiEngineUrl, EgressError, setApiEnginePublicOnly } from '../../server/src/system/egress'
import { checkSource, ConnectedError } from '../../server/src/team-files/connected'
import { HttpError } from '../../server/src/http/errors'
import { OWNER_PW, harness, withOwner, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-cloud-deployment')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

describe('deployment switch (server.json / MYCEL_DEPLOYMENT)', () => {
  const file = (o: object) => { const f = path.join(W, `server-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f }
  test('absent: a self-installed server; office and dev stay what office / mode say, so every existing install keeps its behaviour', () => {
    const k = (o: object, env = {}) => { const c = loadAppConfig({ argv: ['--config', file(o)], env }); return [deploymentOf(c), runKindOf(c)] }
    expect(k({})).toEqual(['self', 'dev'])
    expect(k({ mode: 'prod' })).toEqual(['self', 'selfhost'])
    expect(k({ office: true })).toEqual(['self', 'office'])
    expect(k({ mode: 'prod', deployment: 'hosted' })).toEqual(['hosted', 'hosted'])
    expect(k({ mode: 'prod', deployment: 'self' })).toEqual(['self', 'selfhost'])
    expect(k({ mode: 'prod' }, { MYCEL_DEPLOYMENT: 'hosted' })).toEqual(['hosted', 'hosted'])
    expect(isHosted({ deployment: 'hosted' })).toBe(true)
    expect(isHosted({})).toBe(false)
  })
  test('only self or hosted; hosted is never office mode', () => {
    expect(() => loadAppConfig({ argv: ['--config', file({})], env: { MYCEL_DEPLOYMENT: 'cloud' } })).toThrow(ConfigError)
    expect(() => loadAppConfig({ argv: ['--config', file({ deployment: 'office' })], env: {} })).toThrow(ConfigError)
    expect(() => loadAppConfig({ argv: ['--config', file({ office: true, deployment: 'hosted' })], env: {} })).toThrow(/cannot be office mode/)
  })
  test('update.auto defaults to off (the Mac installer never writes it)', () => {
    expect(loadAppConfig({ argv: ['--config', file({ mode: 'prod' })], env: {} }).update.auto).toBe(false)
    expect(loadAppConfig({ argv: ['--config', file({ mode: 'prod', update: { auto: true } })], env: {} }).update.auto).toBe(true)
  })
  test('the feature table', () => {
    expect(featuresOf({ mode: 'prod', deployment: 'hosted' })).toEqual({ connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false })
    expect(featuresOf({ mode: 'prod' })).toMatchObject({ connectionChange: true, selfUpdate: true, connectedFolders: true, apiEngineAnyUrl: true })
    expect(featuresOf({ mode: 'dev', office: true })).toMatchObject({ connectionChange: false, officeUpdate: true, connectedFolders: true })
    expect(hostKind({ mode: 'prod', deployment: 'hosted' }, 'linux')).toBe('hosted')
    expect(hostKind({ mode: 'prod' }, 'linux')).toBe('linux')
    expect(hostKind({ mode: 'prod' }, 'darwin')).toBe('mac')
    expect(hostKind({ mode: 'dev', office: true }, 'linux')).toBe('mac')
  })
})

describe('AI connection kinds by deployment (ADDENDUM 3, credentials D22)', () => {
  test('without engine.credentialKinds: all four self-hosted, API keys only on the hosted service; a list in the file wins', () => {
    fs.mkdirSync(W, { recursive: true })
    const file = (o: object) => { const f = path.join(W, `kinds-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f }
    const k = (o: object) => [...allowedCredentialKinds(loadAppConfig({ argv: ['--config', file(o)], env: {} }))].sort()
    expect(k({ mode: 'prod' })).toEqual(['anthropic-api-key', 'anthropic-oauth', 'chatgpt', 'openai-api-key'])
    expect(k({ mode: 'prod', deployment: 'hosted' })).toEqual(['anthropic-api-key', 'anthropic-oauth', 'chatgpt', 'openai-api-key'])
    expect(k({ mode: 'prod', deployment: 'hosted', engine: { credentialKinds: ['anthropic-oauth', 'anthropic-api-key'] } })).toEqual(['anthropic-api-key', 'anthropic-oauth'])
  })
})

describe('layout (L02): Linux defaults, macOS values unchanged', () => {
  const cfg = { mode: 'prod' as const, configFile: null, dataDir: '/x/data', teamRoot: '/x/team', logDir: null, office: false } as never
  test('base, firewall status, unit prefix, plan file', () => {
    expect(prodBase('linux')).toBe('/var/lib/mycel')
    expect(prodBase('darwin')).toBe('/Library/Application Support/mycel')
    expect(prodLogDir('linux')).toBeNull()
    expect(prodLogDir('darwin')).toBe('/Library/Logs/mycel')
    const lin = resolveLayout(cfg, {}, 'linux')
    expect(lin).toMatchObject({ base: '/var/lib/mycel', firewallStatusFile: '/var/lib/mycel/run/firewall.json', pfStatusFile: '/var/lib/mycel/run/pf.json',
      label: 'mycel', unitDir: '/etc/systemd/system', planFile: '/var/lib/mycel/root/plan.json', secretsDir: '/var/lib/mycel/secrets' })
    const mac = resolveLayout(cfg, {}, 'darwin')
    expect(mac).toMatchObject({ base: '/Library/Application Support/mycel', firewallStatusFile: '/Library/Application Support/mycel/run/pf.json',
      pfStatusFile: '/Library/Application Support/mycel/run/pf.json', label: 'app.treesoop.mycel', launchDaemonsDir: '/Library/LaunchDaemons' })
    expect(resolveLayout(cfg, { MYCEL_INSTALL_BASE: '/var/lib/mycel-test', MYCEL_PLAN_FILE: '/p.json' }, 'linux')).toMatchObject({ label: 'mycel-test', planFile: '/p.json' })
    expect(resolveLayout({ ...(cfg as object), mode: 'dev' } as never, {}, 'linux').planFile).toBeNull()
  })
  test('FirewallStatus: the file mycel-ctl writes', () => {
    const ok = { format: 1 as const, at: new Date().toISOString(), backend: 'nftables' as const, table: 'inet mycel', loaded: true, rules: 7, engineUid: 990, proxyPort: 47821, sha256: 'ab', nftVersion: '1.1.3', error: null }
    expect(FirewallStatus.parse(ok)).toEqual(ok)
    expect(FirewallStatus.safeParse({ ...ok, backend: 'pf' }).success).toBe(false)
    expect(FirewallStatus.safeParse({ ...ok, proxyPort: -1 }).success).toBe(false)
  })
})

describe('API engine address on Team AX Cloud (SEC-01)', () => {
  const lookup = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  test('https to public addresses only, after resolving the name', async () => {
    const l = lookup({ 'api.example.com': ['93.184.216.34'], 'evil.example.com': ['169.254.169.254'], 'mixed.example.com': ['93.184.216.34', '10.0.0.5'], 'v6.example.com': ['fd00::1'] })
    await expect(assertPublicHttps('https://api.example.com/v1', { lookup: l })).resolves.toBeInstanceOf(URL)
    for (const bad of ['http://api.example.com/v1', 'https://evil.example.com/v1', 'https://mixed.example.com', 'https://v6.example.com', 'https://127.0.0.1/v1',
      'https://169.254.169.254/latest', 'https://[::1]/', 'https://localhost/v1', 'https://ollama.local/v1', 'https://user:pw@api.example.com/', 'https://intranet/v1', 'https://100.64.1.2/']) {
      await expect(assertPublicHttps(bad, { lookup: l }), bad).rejects.toBeInstanceOf(EgressError)
    }
  })
  test('the save is refused (400) only in the cloud', async () => {
    const l = async () => [{ address: '10.1.2.3', family: 4 }]
    await expect(checkApiEngineUrl({ mode: 'prod', deployment: 'self' }, 'http://192.168.0.5:11434/v1', 'ko', { lookup: l })).resolves.toBeUndefined()
    const e = await checkApiEngineUrl({ mode: 'prod', deployment: 'hosted' }, 'https://llm.example.com/v1', 'ko', { lookup: l }).catch((x) => x)
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).status).toBe(400)
    expect((e as HttpError).message).toContain(`${PRODUCT.displayName} Cloud`)
  })
  test('every call is checked again in the cloud, and redirects are not followed', async () => {
    const seen: RequestInit[] = []
    const base = (async (_u: string, init?: RequestInit) => { seen.push(init ?? {}); return new Response('ok') }) as unknown as typeof fetch
    setApiEnginePublicOnly(false)
    expect(await (await apiEngineFetch(base)('http://10.0.0.1/v1/models')).text()).toBe('ok')
    setApiEnginePublicOnly(true, { lookup: async (h) => [{ address: h === 'good.example.com' ? '93.184.216.34' : '127.0.0.1', family: 4 }] })
    try {
      await expect(apiEngineFetch(base)('https://bad.example.com/v1/models')).rejects.toBeInstanceOf(EgressError)
      expect(await (await apiEngineFetch(base)('https://good.example.com/v1/models')).text()).toBe('ok')
      expect(seen.at(-1)!.redirect).toBe('error')
    } finally { setApiEnginePublicOnly(false) }
  })
})

describe('connected folders on a Linux self-host (L15)', () => {
  // outside the work folder: its ".work" / ".mw" name is itself a hidden segment, which the rules refuse
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-linux-roots-')))
  const mnt = path.join(root, 'mnt'), home = path.join(root, 'home')
  const team = path.join(root, 'var-lib-mycel', 'team'), data = path.join(root, 'var-lib-mycel', 'data')
  beforeAll(() => {
    for (const d of [path.join(mnt, 'nas', 'a'), path.join(home, 'x'), team, data, path.join(mnt, '.hidden')]) fs.mkdirSync(d, { recursive: true })
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const o = { teamRoot: team, dataDir: data, platform: 'linux' as const, linuxRoots: [mnt], installBase: path.join(root, 'var-lib-mycel') }
  test('below /mnt (or /media, /srv) only; never the install, /home, or hidden folders', () => {
    expect(checkSource(path.join(mnt, 'nas', 'a'), o)).toBe(fs.realpathSync(path.join(mnt, 'nas', 'a')))
    expect(checkSource(path.join(mnt, 'nas'), o)).toBe(fs.realpathSync(path.join(mnt, 'nas')))
    const code = (p: string) => { try { checkSource(p, o); return 'ok' } catch (e) { return (e as ConnectedError).message } }
    expect(code(mnt)).toBe('not_allowed_linux')
    expect(code(path.join(home, 'x'))).toBe('not_allowed_linux')
    expect(code(team)).toBe('team_folder')
    expect(code(path.join(root, 'var-lib-mycel'))).toBe('team_folder')
    expect(code(path.join(mnt, '.hidden'))).toBe('hidden')
    expect(code('relative/x')).toBe('not_absolute_linux')
    expect(code('~/x')).toBe('not_absolute_linux')
    expect(code(path.join(mnt, 'none'))).toBe('not_found_linux')
  })
})

describe('Team AX Cloud refuses what the operator owns (UX-07, SEC-02)', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('cloud-refusals', { deployment: 'hosted' })
    owner = await withOwner(h)
  })
  // the hosted app turned the process-wide API-engine egress check on (routes/system.ts, one team per process); later
  // files in the same bun process are not the cloud
  afterAll(async () => { await h.close(); setApiEnginePublicOnly(false) })

  test('/api/me tells the web the deployment, its features and the team time zone', async () => {
    const me = await owner.call('GET', '/api/me')
    expect(me.server.deployment).toBe('hosted')
    expect(me.server.features).toMatchObject({ connectionChange: false, selfUpdate: false, connectedFolders: false })
    expect(typeof me.server.timeZone).toBe('string')
  })
  test('connection change, update, roll-back and office update: 409', async () => {
    const conn = await owner.try('PUT', '/api/admin/connection', { mode: 'self-relay', relayUrl: 'wss://relay.example.com/connect', teamName: 'acme', password: OWNER_PW })
    expect(conn.status).toBe(409)
    expect(conn.body.error.message).toContain(`${PRODUCT.displayName} Cloud`)
    const up = await owner.try('POST', '/api/admin/update', { password: OWNER_PW })
    expect(up.status).toBe(409)
    expect((await owner.try('POST', '/api/admin/update', { password: OWNER_PW, rollback: true })).status).toBe(409)
    expect((await owner.try('POST', '/api/admin/office-update', { action: 'pause' })).status).toBe(409)
    const st = await owner.call('GET', '/api/admin/update')
    expect(st.managed).toBe(true)
  })
  test('connected folders: none listed (available false), adding or syncing one is refused', async () => {
    expect(await owner.call('GET', '/api/admin/connected')).toEqual({ items: [], available: false })
    const add = await owner.try('POST', '/api/admin/connected', { name: 'nas', source: '/mnt/nas', password: OWNER_PW })
    expect(add.status).toBe(409)
    expect(add.body.error.message).toContain(`${PRODUCT.displayName} Cloud`)
    expect((await owner.try('POST', '/api/admin/connected/00000000-0000-7000-8000-000000000000/sync')).status).toBe(409)
  })
  test('the API engine address must be public https', async () => {
    const r = await owner.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama' })
    expect(r.status).toBe(400)
    expect(r.body.error.fields['body.baseUrl']).toBe('not_public_https')
  })
  test('a self-hosted install still may (the same requests are not refused for those reasons)', async () => {
    h.ctx.config.deployment = 'self'
    try {
      expect((await owner.call('GET', '/api/admin/connected')).available).toBe(true)
      const r = await owner.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama' })
      expect(r.status).toBe(200)
      const up = await owner.try('POST', '/api/admin/update', { password: OWNER_PW })
      expect(up.body.error?.message ?? '').not.toContain(`${PRODUCT.displayName} Cloud`)
    } finally { h.ctx.config.deployment = 'hosted' }
  })
})
