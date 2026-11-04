// Demo mode (MYCEL_DEMO, `bun run demo:trina`; docs/DECISIONS.md "Demo company: a new hire at 트리나"). The product has no
// "sign in as someone else": the demo's person switch must not exist without the flag, the flag must stop any server
// that is not a development server, and the switch must be a normal sign-in of the seeded account (its password, its
// rate limits, its audit row), ending the previous session.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, type DemoFile } from '../../shared/src/api'
import { ConfigError, loadAppConfig, readDemoFile } from '../../server/src/app-config'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'

const PW = 'demo public words 42'
const DEMO: DemoFile = {
  company: 'Acme',
  password: PW,
  sameQuestion: '이번 분기 예산 요약해 줘',
  personas: [
    { key: 'newHire', username: 'newbie', intro: '오늘 입사한 신입이에요', questions: ['휴가 규정 알려줘'] },
    { key: 'lead', username: 'lead', intro: '팀장이에요', questions: ['이번 분기 예산 요약해 줘'] },
    { key: 'ceo', username: 'olga', intro: '대표예요', questions: [] },
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
  beforeAll(async () => {
    h = await harness('demo-on', { mode: 'dev', demo: DEMO })
    owner = await withOwner(h)
    await owner.call('POST', '/api/auth/password', { currentPassword: OWNER_PW, newPassword: PW })
    const g = await owner.call('POST', '/api/admin/groups', { name: '마케팅팀', description: '', memberIds: [] })
    await addMember(h, owner, { username: 'newbie', password: PW, groupIds: [g.id] })
    await addMember(h, owner, { username: 'lead', password: 'not the demo password 9' })
  })
  afterAll(async () => { await h.close() })

  test('the info names the people from the accounts and who the caller is', async () => {
    const anon = h.client()
    const info = await anon.call('GET', API.demoInfo.path)
    expect(info).toEqual({
      company: 'Acme', sameQuestion: '이번 분기 예산 요약해 줘', current: null,
      personas: [
        { key: 'newHire', name: 'NEWBIE', team: '마케팅팀', intro: '오늘 입사한 신입이에요', questions: ['휴가 규정 알려줘'] },
        { key: 'lead', name: 'LEAD', team: null, intro: '팀장이에요', questions: ['이번 분기 예산 요약해 줘'] },
        { key: 'ceo', name: 'Olga Owner', team: null, intro: '대표예요', questions: [] },
      ],
    })
    // no usernames or the password in the answer
    expect(JSON.stringify(info)).not.toContain(PW)
    expect((await owner.call('GET', API.demoInfo.path)).current).toBe('ceo')
  })

  test('switching is a real sign-in of that account: a session cookie, an audit row, the old session ended', async () => {
    const viewer = h.client()
    await viewer.call('POST', API.demoSwitch.path, { key: 'newHire' })
    expect(viewer.cookie).toMatch(/^mycel-dev-sid=/)
    const first = viewer.cookie
    expect((await viewer.call('GET', API.me.path)).user.username).toBe('newbie')
    expect((await viewer.call('GET', API.demoInfo.path)).current).toBe('newHire')
    const logins = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login'").all() as { detail: string }[]
    expect(logins.length).toBeGreaterThan(0)

    await viewer.call('POST', API.demoSwitch.path, { key: 'ceo' })
    expect(viewer.cookie).not.toBe(first)
    expect((await viewer.call('GET', API.me.path)).user.username).toBe('olga')
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

  test('the routes check the mode again: a non-development config never answers', async () => {
    const prod = await harness('demo-prod-guard', { mode: 'prod', demo: DEMO })
    try {
      expect((await prod.client().try('GET', API.demoInfo.path)).status).toBe(404)
      expect((await prod.client().try('POST', API.demoSwitch.path, { key: 'ceo' })).status).toBe(404)
    } finally { await prod.close() }
  })
})
