// TC-358 (Pras's QA, 2026-11-15): with the Mac user's own Claude login (office local-login mode, and dev), the engine
// sandbox let a turn run /usr/bin/security, which reads every keychain item `security` made without a prompt (the
// Claude login and the tokens of other command-line tools), list and read ~/Library/Keychains and read
// ~/.claude/.credentials.json. Now engine.sb closes all of that (exec of /usr/bin/security, the keychain files, the
// Security services, the login file) and Claude Code's own `security` calls go to the launcher's Claude login broker
// (native/cmd/mycel-launcher/keychain.go) through a shim that the launcher puts first in the engine's PATH. The broker
// answers only the Claude login item (its claudeAiOauth part) and saves only a refreshed login. Its rules are in the Go
// tests (keychain_test.go); here: the profile on a fake home, and a real launcher + bridge with a stand-in keychain
// (--keychain-test-store). The real keychain and the real Claude login are never opened.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { SocketLauncher } from '../../server/src/native'
import { WORK } from '../lib/env'
import { ENGINE_PROFILE, sbAvailable } from '../lib/sb-local-login'

const bins = sbAvailable && fs.existsSync(path.join(nativeBinDir(), 'mycel-launcher')) && fs.existsSync(path.join(nativeBinDir(), 'mycel-bridge'))
fs.mkdirSync(path.join(WORK, 'r4c'), { recursive: true })
const W = fs.realpathSync(path.join(WORK, 'r4c'))
const ENG = path.join(W, 'engine'), PROBE = path.join(ENG, 'probe'), AGENT = path.join(W, 'agent'), H = path.join(W, 'home')
const KC = path.join(W, 'kc'), KEYS = path.join(H, 'Library', 'Keychains')
const ME = os.userInfo().username
const LOGIN = { claudeAiOauth: { accessToken: 'sk-ant-oat01-R4C-FAKE', refreshToken: 'sk-ant-ort01-R4C-FAKE', expiresAt: 1999999999000, scopes: ['user:inference'] }, mcpOAuth: { 'slack|x': { accessToken: 'xoxp-R4C-OTHER' } } }

beforeAll(() => {
  fs.rmSync(W, { recursive: true, force: true })
  for (const d of [ENG, path.join(AGENT, 'c_me'), KEYS, path.join(H, '.claude', 'projects'), KC]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(H, '.claude.json'), '{}')
  fs.writeFileSync(path.join(KEYS, 'login.keychain-db'), 'KEYCHAIN-CANARY')
  fs.writeFileSync(path.join(H, '.claude', '.credentials.json'), JSON.stringify(LOGIN))
  fs.writeFileSync(path.join(KC, 'other'), '')
  if (!sbAvailable) return
  const cc = Bun.spawnSync(['cc', '-O2', '-o', PROBE, path.resolve(import.meta.dir, '..', 'lib', 'g-sbprobe.c')])
  if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())
})
afterAll(() => { fs.rmSync(W, { recursive: true, force: true }) })

/** the probe as an engine turn under engine.sb with the local-login parameters and the broker folder */
function turn(o: { proxyPort?: number; codex?: boolean; kc?: string }, ...args: string[]): number | null {
  const chatDir = path.join(AGENT, 'c_me')
  const sess = path.join(H, '.claude', 'projects', '-agent-c_me')
  fs.mkdirSync(sess, { recursive: true })
  return Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', ENGINE_PROFILE,
    '-D', `CHAT_DIR=${chatDir}`, '-D', `AGENT_ROOT=${AGENT}`, '-D', `ENGINE_DIR=${ENG}`, '-D', `BRIDGE=${path.join(ENG, 'bridge')}`,
    '-D', `TOOLS_SOCK=${path.join(W, 'tools.sock')}`, '-D', `PROXY_PORT=${o.proxyPort ?? 0}`, '-D', 'LOCAL_LOGIN=1', '-D', `LOCAL_CODEX=${o.codex ? 1 : 0}`,
    '-D', `USER_HOME=${H}`, '-D', `SESSION_DIR=${sess}`, '-D', `KEYCHAIN_DIR=${o.kc ?? KC}`, PROBE, ...args],
  { cwd: chatDir, stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }).exitCode
}

describe.skipIf(!sbAvailable)('engine.sb LOCAL_LOGIN=1: no keychain, no Claude login file (TC-358)', () => {
  // dev (direct HTTPS), office (proxy only), dev with Codex on
  const modes = [{ name: 'dev', o: {} }, { name: 'office', o: { proxyPort: 47831 } }, { name: 'dev + Codex', o: { codex: true } }]
  for (const { name, o } of modes) {
    test(`${name}: /usr/bin/security does not run, the keychain and the login file do not open`, () => {
      expect(turn(o, 'exec', '/usr/bin/security')).not.toBe(0) // was 0 (engine.sb allowed it with LOCAL_LOGIN=1)
      expect(turn(o, 'run', '/usr/bin/security', 'find-generic-password', '-s', 'qa-canary', '-w')).not.toBe(0)
      for (const p of [path.join(KEYS, 'login.keychain-db'), path.join(H, '.claude', '.credentials.json')]) {
        expect(turn(o, 'read', p)).not.toBe(0) // was 0
        expect(turn(o, 'stat', p)).toBe(1) // EPERM, not even its existence
        expect(turn(o, 'write', p)).not.toBe(0) // was 0
      }
      expect(turn(o, 'list', KEYS)).not.toBe(0) // was 0 (Pras: ~/Library/Keychains could be listed)
      expect(turn(o, 'write', path.join(KEYS, 'login.keychain-db-wal'))).not.toBe(0) // was 0 (round 4 left the keychain writable)
      expect(fs.readFileSync(path.join(KEYS, 'login.keychain-db'), 'utf8')).toBe('KEYCHAIN-CANARY')
    })
  }

  test('the broker folder: its socket and its `security` link only', async () => {
    const srv = Bun.listen({ unix: path.join(KC, 'sock'), socket: { data() {} } })
    const other = Bun.listen({ unix: path.join(KC, 'other.sock'), socket: { data() {} } })
    try {
      expect(turn({}, 'unix', path.join(KC, 'sock'))).toBe(0)
      expect(turn({}, 'unix', path.join(KC, 'other.sock'))).not.toBe(0)
      expect(turn({ kc: '' }, 'unix', path.join(KC, 'sock'))).not.toBe(0)
    } finally { srv.stop(true); other.stop(true) }
    expect(turn({}, 'stat', path.join(KC, 'other'))).toBe(1)
    expect(turn({}, 'read', path.join(KC, 'other'))).not.toBe(0)
    expect(turn({}, 'write', path.join(KC, 'planted'))).not.toBe(0)
    // without the broker (a Claude sign-in: KEYCHAIN_DIR empty) nothing of that folder opens
    expect(turn({ kc: '' }, 'stat', path.join(KC, 'other'))).toBe(1)
  })
})

describe.skipIf(!bins)('launcher + bridge: the engine\'s `security` reaches only the Claude login (TC-358)', () => {
  let p: ReturnType<typeof Bun.spawn> | null = null
  const store = path.join(W, 'store.json')
  const sock = path.join(W, 'launcher.sock')
  beforeAll(async () => {
    fs.writeFileSync(store, JSON.stringify({ 'Claude Code-credentials': JSON.stringify(LOGIN), 'qa-canary': 'CANARY-KC', 'gh:github.com': 'gho_R4C' }))
    p = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock, '--agent-root', AGENT, '--bridge', path.join(nativeBinDir(), 'mycel-bridge'),
      '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', PROBE, '--sandbox-profile', ENGINE_PROFILE, '--local-login', '--proxy-port', '47831',
      '--keychain-dir', path.join(W, 'kcl'), '--keychain-test-store', store], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: { HOME: os.homedir() } })
    const r = (p.stdout as ReadableStream<Uint8Array>).getReader()
    expect(new TextDecoder().decode((await r.read()).value)).toContain('ready')
    r.releaseLock()
  })
  afterAll(() => { p?.kill() })

  async function engine(args: string[], stdin = ''): Promise<{ code: number; out: string }> {
    const h = new SocketLauncher(sock).launch({ op: 'run', turnId: 'r4c' + Math.random().toString(36).slice(2, 8), chatDir: path.join(AGENT, 'c_me'), cmd: PROBE, args,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: ME }, token: 'x', systemPrompt: '', stdin, timeoutMs: 20_000 })
    let out = '', code = -1
    for await (const ev of h.events) {
      if (ev.ev === 'stdout') out += Buffer.from(ev.b64, 'base64').toString()
      if (ev.ev === 'exit') code = ev.code
      if (ev.ev === 'error') throw new Error(ev.message)
    }
    return { code, out }
  }

  test('Claude Code\'s read: the login, without the rest of the item', async () => {
    const r = await engine(['run', 'security', 'find-generic-password', '-a', ME, '-w', '-s', 'Claude Code-credentials'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ claudeAiOauth: LOGIN.claudeAiOauth })
    expect(r.out).not.toContain('xoxp-R4C-OTHER')
  })

  test('other items, other commands and the real tool are refused', async () => {
    for (const args of [['find-generic-password', '-a', ME, '-w', '-s', 'qa-canary'], ['find-generic-password', '-s', 'gh:github.com', '-w'],
      ['dump-keychain', '-d'], ['find-generic-password', '-a', ME, '-g', '-s', 'Claude Code-credentials'], ['delete-generic-password', '-a', ME, '-s', 'Claude Code-credentials']]) {
      const r = await engine(['run', 'security', ...args])
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain('CANARY')
      expect(r.out).not.toContain('gho_')
    }
    expect((await engine(['exec', '/usr/bin/security'])).code).not.toBe(0)
  })

  test('Claude Code\'s save (security -i): only the login part goes into the item', async () => {
    const fresh = { claudeAiOauth: { ...LOGIN.claudeAiOauth, accessToken: 'sk-ant-oat01-R4C-NEW' }, mcpOAuth: { planted: { accessToken: 'p' } } }
    const hex = Buffer.from(JSON.stringify(fresh)).toString('hex')
    const r = await engine(['run', 'security', '-i'], `add-generic-password -U -a "${ME}" -s "Claude Code-credentials" -X "${hex}"\n`)
    expect(r.code).toBe(0)
    const item = JSON.parse(JSON.parse(fs.readFileSync(store, 'utf8'))['Claude Code-credentials'])
    expect(item.claudeAiOauth.accessToken).toBe('sk-ant-oat01-R4C-NEW')
    expect(item.mcpOAuth).toEqual(LOGIN.mcpOAuth)
    const bad = await engine(['run', 'security', '-i'], `add-generic-password -U -a "${ME}" -s "qa-canary" -w "x"\n`)
    expect(bad.code).not.toBe(0)
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))['qa-canary']).toBe('CANARY-KC')
  })

  test('a process outside every turn gets nothing from the broker', async () => {
    const shim = path.join(W, 'kcl', 'security')
    expect(fs.readlinkSync(shim)).toBe(fs.realpathSync(path.join(nativeBinDir(), 'mycel-bridge')))
    const r = Bun.spawnSync([shim, 'find-generic-password', '-a', ME, '-w', '-s', 'Claude Code-credentials'], { env: { MYCEL_KEYCHAIN_SOCK: path.join(W, 'kcl', 'sock') } })
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout.toString()).not.toContain('R4C')
  })
})
