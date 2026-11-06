// Demo mode (MYCEL_DEMO, `bun run demo:company`; docs/DECISIONS.md "Demo company: a new hire at 트리나"). The product has no
// "sign in as someone else": the demo's person switch must not exist without the flag, the flag must stop any server
// that is not a development server, and the switch must be a sign-in of the seeded member account (its password, its
// audit row, its session), ending the previous session. A demo can be open to every network its Mac is on with a public
// password, so no demo person may be the owner or an admin, and what reaches the Mac or locks the demo is refused.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, type DemoFile } from '../../shared/src/api'
import { ConfigError, loadAppConfig, readDemoFile } from '../../server/src/app-config'
import { featuresOf } from '../../server/src/system/deployment'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'

const SEALED = { kid: '0123456789abcdef', epk: 'A'.repeat(87), iv: 'A'.repeat(16), ct: 'A'.repeat(40) } // well-formed, never opened
const PW = 'demo public words 42'
const DEMO: DemoFile = {
  company: 'Acme',
  password: PW,
  sameQuestion: '이번 분기 예산 요약해 줘',
  personas: [
    { key: 'newHire', username: 'newbie', intro: '오늘 입사한 신입이에요', questions: ['휴가 규정 알려줘'] },
    { key: 'lead', username: 'lead', intro: '팀장이에요', questions: ['이번 분기 예산 요약해 줘'] },
    { key: 'ceo', username: 'boss', intro: '대표예요', questions: [] },
  ],
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a-demo-mode-'))
const demoFile = path.join(tmp, 'demo.json')
fs.writeFileSync(demoFile, JSON.stringify(DEMO))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const config = (file: object) => {
  const p = path.join(tmp, `server-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(p, JSON.stringify(file))
  return p
}

describe('without MYCEL_DEMO there is no demo', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('demo-off') })
  afterAll(async () => { await h.close() })

  test('both endpoints answer 404, signed out and signed in, and nothing signs anyone in', async () => {
    const anon = h.client()
    expect((await anon.try('GET', API.demoInfo.path)).status).toBe(404)
    const sw = await anon.try('POST', API.demoSwitch.path, { key: 'ceo' })
    expect(sw.status).toBe(404)
    expect(sw.headers.getSetCookie()).toEqual([])
    const owner = await withOwner(h)
    expect((await owner.try('GET', API.demoInfo.path)).status).toBe(404)
    expect((await owner.try('POST', API.demoSwitch.path, { key: 'ceo' })).status).toBe(404)
    // the owner is still the owner
    expect((await owner.call('GET', API.me.path)).user.username).toBe('olga')
  })

  test('the loaded config has no demo when the variable is unset or empty', () => {
    const file = config({ mode: 'dev' })
    expect(loadAppConfig({ argv: ['--config', file], env: {} }).demo).toBeUndefined()
    expect(loadAppConfig({ argv: ['--config', file], env: { MYCEL_DEMO: '' } }).demo).toBeUndefined()
  })
})

describe('MYCEL_DEMO is refused anywhere but a development server', () => {
  test('production mode, the hosted service and office mode stop at start', () => {
    for (const [file, env] of [
      [config({ mode: 'prod' }), {}],
      [config({ mode: 'dev' }), { MYCEL_MODE: 'prod' }],
      [config({ mode: 'dev', deployment: 'hosted' }), {}],
      [config({ mode: 'dev' }), { MYCEL_DEPLOYMENT: 'hosted' }],
      [config({ mode: 'dev', office: true }), {}],
    ] as const) {
      expect(() => loadAppConfig({ argv: ['--config', file], env: { ...env, MYCEL_DEMO: demoFile } })).toThrow(/MYCEL_DEMO is for a development demo server only/)
    }
  })

  test('a development server with a demo file reads it; a missing or wrong file stops it', () => {
    expect(loadAppConfig({ argv: ['--config', config({ mode: 'dev' })], env: { MYCEL_DEMO: demoFile } }).demo).toEqual(DEMO)
    const where = { mode: 'dev' as const, office: false }
    expect(() => readDemoFile(path.join(tmp, 'missing.json'), where)).toThrow(ConfigError)
    const bad = path.join(tmp, 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ ...DEMO, personas: [...DEMO.personas, DEMO.personas[0]] }))
    expect(() => readDemoFile(bad, where)).toThrow(/not a demo file/)
    fs.writeFileSync(bad, JSON.stringify({ ...DEMO, extra: 1 }))
    expect(() => readDemoFile(bad, where)).toThrow(/not a demo file/)
  })
})

describe('with MYCEL_DEMO on a development server', () => {
  let h: Harness
  let owner: Client
  const ids: Record<string, string> = {}
  beforeAll(async () => {
    h = await harness('demo-on', { mode: 'dev', demo: DEMO })
    owner = await withOwner(h)
    const g = await owner.call('POST', '/api/admin/groups', { name: '마케팅팀', description: '', memberIds: [] })
    // the seed's own first change, from the temporary password to the demo password, is allowed in demo mode
    ids.newbie = (await addMember(h, owner, { username: 'newbie', password: PW, groupIds: [g.id] })).id
    ids.lead = (await addMember(h, owner, { username: 'lead', password: 'not the demo password 9' })).id
    ids.boss = (await addMember(h, owner, { username: 'boss', password: PW })).id
    ids.other = (await addMember(h, owner, { username: 'other', password: 'someone else words 8' })).id
  })
  afterAll(async () => { await h.close() })

  test('the info names the people from the accounts and who the caller is', async () => {
    const anon = h.client()
    const info = await anon.call('GET', API.demoInfo.path)
    expect(info).toEqual({
      company: 'Acme', sameQuestion: '이번 분기 예산 요약해 줘', current: null, network: false,
      personas: [
        { key: 'newHire', name: 'NEWBIE', team: '마케팅팀', intro: '오늘 입사한 신입이에요', questions: ['휴가 규정 알려줘'] },
        { key: 'lead', name: 'LEAD', team: null, intro: '팀장이에요', questions: ['이번 분기 예산 요약해 줘'] },
        { key: 'ceo', name: 'BOSS', team: null, intro: '대표예요', questions: [] },
      ],
    })
    // no usernames or the password in the answer
    expect(JSON.stringify(info)).not.toContain(PW)
    expect(JSON.stringify(info)).not.toContain('boss')
    expect((await owner.call('GET', API.demoInfo.path)).current).toBeNull()
  })

  test('switching is a sign-in of that account: a session cookie, an audit row, the old session ended', async () => {
    const viewer = h.client()
    await viewer.call('POST', API.demoSwitch.path, { key: 'newHire' })
    expect(viewer.cookie).toMatch(/^mycel-dev-sid=/)
    const first = viewer.cookie
    expect((await viewer.call('GET', API.me.path)).user.username).toBe('newbie')
    expect((await viewer.call('GET', API.demoInfo.path)).current).toBe('newHire')
    const logins = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'auth.login'").all() as { target: string; detail: string }[]
    expect(logins.some((l) => l.target === ids.newbie && JSON.parse(l.detail).demo === true)).toBe(true)

    await viewer.call('POST', API.demoSwitch.path, { key: 'ceo' })
    expect(viewer.cookie).not.toBe(first)
    const me = await viewer.call('GET', API.me.path)
    expect(me.user.username).toBe('boss')
    expect(me.user.role).toBe('member')
    // the new hire's session is gone, not just replaced in this browser
    const old = h.client()
    old.cookie = first
    expect((await old.try('GET', API.me.path)).status).toBe(401)
  })

  test('an account whose password is no longer the demo password cannot be entered; unknown people are refused', async () => {
    const viewer = h.client()
    const r = await viewer.try('POST', API.demoSwitch.path, { key: 'lead' })
    expect(r.status).toBe(401)
    expect(viewer.cookie).toBeNull()
    expect((await viewer.try('POST', API.demoSwitch.path, { key: 'admin' })).status).toBe(400)
    expect((await viewer.try('POST', API.demoSwitch.path, { username: 'olga' })).status).toBe(400)
  })

  test('wrong passwords on the sign-in page lock that page, not the switch', async () => {
    const stranger = h.client({ ip: '10.9.9.9' })
    let last = 0
    for (let i = 0; i < 14; i++) last = (await stranger.try('POST', API.login.path, { username: 'newbie', password: `wrong guess ${i}`, client: 'web', tokenMode: 'cookie' })).status
    expect(last).toBe(429)
    const viewer = h.client({ ip: '10.9.9.9' })
    await viewer.call('POST', API.demoSwitch.path, { key: 'newHire' })
    expect((await viewer.call('GET', API.me.path)).user.username).toBe('newbie')
  })

  test('the demo people stay as seeded: no password change, reset, disable, promotion or deletion', async () => {
    const viewer = h.client()
    await viewer.call('POST', API.demoSwitch.path, { key: 'newHire' })
    const ch = await viewer.try('POST', API.changePassword.path, { currentPassword: PW, newPassword: 'a brand new phrase 77' })
    expect(ch.status).toBe(403)
    expect(ch.body.error.message).toContain('데모')
    for (const [method, p, body] of [
      ['POST', `/api/admin/users/${ids.newbie}/reset-password`, {}],
      ['PATCH', `/api/admin/users/${ids.newbie}`, { status: 'disabled' }],
      ['PATCH', `/api/admin/users/${ids.boss}`, { role: 'admin' }],
      ['DELETE', `/api/admin/users/${ids.newbie}`, undefined],
    ] as const) expect((await owner.try(method, p, body)).status, `${method} ${p}`).toBe(403)
    // the switch still works with the public password
    await h.client().call('POST', API.demoSwitch.path, { key: 'newHire' })
    // someone who is not a demo person is not fenced
    expect((await owner.try('PATCH', `/api/admin/users/${ids.other}`, { status: 'disabled' })).status).toBe(200)
    expect((await owner.try('PATCH', `/api/admin/users/${ids.newbie}`, { name: '새 이름' })).status).toBe(200)
  })

  test('no owner password re-checks, no connected folders, no plugin files, no API engine on any address', async () => {
    const r = await owner.try('POST', API.transferOwnership.path, { userId: ids.other, password: OWNER_PW })
    expect(r.status).toBe(403)
    expect(r.body.error.message).toContain('데모')
    expect((await owner.try('POST', API.addConnected.path, { name: 'home', source: os.homedir(), password: OWNER_PW })).status).toBeGreaterThanOrEqual(400)
    expect((await owner.call('GET', API.listConnected.path)).available).toBe(false)
    const features = (await owner.call('GET', API.me.path)).server.features
    expect(features).toMatchObject({ connectedFolders: false, pluginFileInstall: false, apiEngineAnyUrl: false })
    expect(featuresOf({ mode: 'dev' })).toMatchObject({ connectedFolders: true, pluginFileInstall: true, apiEngineAnyUrl: true })
    // the owner is still the owner (transfer refused)
    expect((await owner.call('GET', API.me.path)).user.role).toBe('owner')
  })

  test('the password re-checks of the team\'s AI (admin-reauth: an admin\'s or the owner\'s own) are off in a demo too, before the password is looked at', async () => {
    const admin = await addMember(h, owner, { username: 'demoadmin', role: 'admin', password: 'admin demo words 77' })
    const probes: [string, string, object][] = [
      ['POST', API.createCredential.path, { kind: 'anthropic-api-key', label: 'x', sealed: SEALED, password: 'admin demo words 77' }],
      ['POST', API.startCredentialLogin.path, { kind: 'anthropic-oauth', label: 'x', assignments: [], priority: 1, acknowledgedPlanNotice: true, password: 'admin demo words 77' }],
      ['POST', API.replaceCredentialSecret.path.replace(':id', '00000000-0000-7000-8000-000000000000'), { sealed: SEALED, password: 'admin demo words 77' }],
      ['PUT', API.putApiEngine.path, { baseUrl: 'https://93.184.216.34/v1', model: 'm', password: 'admin demo words 77' }],
    ]
    for (const [m, path, body] of probes) {
      const r = await admin.client.try(m, path, body)
      expect(r.status, path).toBe(403)
      expect(r.body.error.message, path).toContain('데모')
    }
  })

  test('the routes check the mode again: a non-development config never answers', async () => {
    const prod = await harness('demo-prod-guard', { mode: 'prod', demo: DEMO })
    try {
      expect((await prod.client().try('GET', API.demoInfo.path)).status).toBe(404)
      expect((await prod.client().try('POST', API.demoSwitch.path, { key: 'ceo' })).status).toBe(404)
    } finally { await prod.close() }
  })
})

describe('the owner and admins are never demo people', () => {
  test('a demo file naming the owner or an admin cannot sign anyone in as them; a server open to the network says so', async () => {
    // the demo password is the owner's own here: still no way in
    const d: DemoFile = { ...DEMO, password: OWNER_PW, personas: [{ key: 'ceo', username: 'olga', intro: '대표예요', questions: [] }, { key: 'lead', username: 'adm', intro: '관리자예요', questions: [] }] }
    const h = await harness('demo-owner-persona', { mode: 'dev', demo: d, listen: { host: '0.0.0.0', port: 19110 } })
    try {
      const owner = await withOwner(h)
      await addMember(h, owner, { username: 'adm', role: 'admin', password: OWNER_PW })
      for (const key of ['ceo', 'lead']) {
        const viewer = h.client()
        expect((await viewer.try('POST', API.demoSwitch.path, { key })).status).toBe(401)
        expect(viewer.cookie).toBeNull()
      }
      expect((await h.client().call('GET', API.demoInfo.path)).network).toBe(true)
    } finally { await h.close() }
  })
})
