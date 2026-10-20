// Component G: the engine sandbox profile (scripts/macos/engine.sb) on macOS — directly through sandbox-exec and
// end to end through mycel-launcher --sandbox-profile. Uses a small C probe as the "engine" (tests/lib/g-sbprobe.c).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { SocketLauncher } from '../../server/src/native'
import { WORK } from '../lib/env'

const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') && !!Bun.which('cc')
const PROFILE = path.resolve(import.meta.dir, '..', '..', 'scripts', 'macos', 'engine.sb')
// sandbox paths are matched after symlink resolution: keep the work folder under a real path
fs.mkdirSync(path.join(WORK, 'g-sandbox'), { recursive: true })
const W = fs.realpathSync(path.join(WORK, 'g-sandbox'))
const ENG = path.join(W, 'engine')
const PROBE = path.join(ENG, 'probe')
const AGENT = path.join(W, 'agent')
const CHAT = path.join(AGENT, 'chat1')
const OTHER = path.join(AGENT, 'chat2')
const TMP_SECRET = path.join('/private/tmp', `mycel-g-sandbox-${process.pid}`)

beforeAll(() => {
  if (!mac) return
  fs.rmSync(W, { recursive: true, force: true })
  for (const d of [ENG, CHAT, OTHER]) fs.mkdirSync(d, { recursive: true })
  const cc = Bun.spawnSync(['cc', '-O2', '-o', PROBE, path.resolve(import.meta.dir, '..', 'lib', 'g-sbprobe.c')])
  if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())
  fs.writeFileSync(path.join(CHAT, 'mine.txt'), 'mine')
  fs.writeFileSync(path.join(OTHER, 'theirs.txt'), 'theirs')
  fs.writeFileSync(TMP_SECRET, 'left in /tmp by someone')
})
afterAll(() => { fs.rmSync(TMP_SECRET, { force: true }) })

function probe(localLogin: boolean, ...args: string[]): boolean {
  const p = Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', PROFILE,
    '-D', `CHAT_DIR=${CHAT}`, '-D', `AGENT_ROOT=${AGENT}`, '-D', `ENGINE_DIR=${ENG}`, '-D', 'BRIDGE=/nonexistent/bridge',
    '-D', `TOOLS_SOCK=${path.join(W, 'tools.sock')}`, '-D', 'PROXY_PORT=19173', '-D', `LOCAL_LOGIN=${localLogin ? 1 : 0}`, '-D', `USER_HOME=${fs.realpathSync(os.homedir())}`,
    PROBE, ...args], { stdout: 'ignore', stderr: 'ignore' })
  return p.exitCode === 0
}

// stand-ins for the model proxy port and the tools socket
let proxy: net.Server | null = null
let tools: net.Server | null = null
beforeAll(async () => {
  if (!mac) return
  proxy = net.createServer((c) => c.end()).listen(19173, '127.0.0.1')
  tools = net.createServer((c) => c.end()).listen(path.join(W, 'tools.sock'))
  await Bun.sleep(50)
})
afterAll(() => { proxy?.close(); tools?.close() })

describe.skipIf(!mac)('engine.sb (sandbox-exec)', () => {

  for (const ll of [false, true]) {
    test(`LOCAL_LOGIN=${ll ? 1 : 0}: own chat folder yes; /tmp, other chats, /Users, /Volumes, shells no`, () => {
      expect(probe(ll, 'read', path.join(CHAT, 'mine.txt'))).toBe(true)
      expect(probe(ll, 'write', path.join(CHAT, 'new.txt'))).toBe(true)
      expect(probe(ll, 'read', path.join(OTHER, 'theirs.txt'))).toBe(false)
      expect(probe(ll, 'list', AGENT)).toBe(false)
      expect(probe(ll, 'read', TMP_SECRET)).toBe(false)
      expect(probe(ll, 'list', '/private/tmp')).toBe(false)
      expect(probe(ll, 'write', '/private/tmp/mycel-g-sb-write')).toBe(false)
      expect(probe(ll, 'write', '/private/var/tmp/mycel-g-sb-write')).toBe(false)
      expect(probe(ll, 'list', '/Users')).toBe(false)
      expect(probe(ll, 'list', '/Volumes')).toBe(false)
      expect(probe(ll, 'read', path.join(os.homedir(), '.zshrc'))).toBe(false)
      expect(probe(ll, 'exec', '/bin/sh')).toBe(false)
      expect(probe(ll, 'read', '/etc/hosts')).toBe(true) // system files for name resolution / TLS stay readable
      // network: our tools socket and the model proxy port only
      expect(probe(ll, 'unix', path.join(W, 'tools.sock'))).toBe(true)
      expect(probe(ll, 'tcp', '127.0.0.1', '19173')).toBe(true)
    })
  }

  test('without local login: no direct internet, no other localhost ports', () => {
    expect(probe(false, 'tcp', '1.1.1.1', '443')).toBe(false)
    expect(probe(false, 'tcp', '127.0.0.1', '22')).toBe(false)
  })

  test('local login: the owner\'s ~/.claude is readable (keychain login), other home files are not', () => {
    const home = fs.realpathSync(os.homedir())
    if (fs.existsSync(path.join(home, '.claude'))) expect(probe(true, 'list', path.join(home, '.claude'))).toBe(true)
    expect(probe(false, 'list', path.join(home, '.claude'))).toBe(false)
    expect(probe(true, 'list', path.join(home, 'Documents'))).toBe(false)
  })
})

describe.skipIf(!mac)('mycel-launcher --sandbox-profile', () => {
  let proc: Bun.Subprocess<"ignore", "pipe", "inherit">
  const sock = path.join(W, 'launcher.sock')
  beforeAll(async () => {
    proc = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge',
      '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', PROBE, '--sandbox-profile', PROFILE, '--proxy-port', '19173'], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
    const r = proc.stdout.getReader()
    const { value } = await r.read()
    expect(new TextDecoder().decode(value)).toContain('ready')
    r.releaseLock()
  })
  afterAll(() => proc.kill())

  async function turn(chat: string, args: string[]): Promise<number> {
    const h = new SocketLauncher(sock).launch({ op: 'run', turnId: 't' + Math.random().toString(36).slice(2, 8), chatDir: path.join(AGENT, chat), cmd: PROBE, args, env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 10_000 })
    for await (const ev of h.events) {
      if (ev.ev === 'exit') return ev.code
      if (ev.ev === 'error') throw new Error(ev.message)
    }
    throw new Error('no exit event')
  }

  test('every turn runs inside the profile with its own chat folder', async () => {
    expect(await turn('chat1', ['read', '{CHAT_DIR}/mine.txt'])).toBe(0)
    expect(await turn('chat1', ['read', path.join(OTHER, 'theirs.txt')])).not.toBe(0)
    expect(await turn('chat2', ['read', '{CHAT_DIR}/theirs.txt'])).toBe(0)
    expect(await turn('chat2', ['read', path.join(CHAT, 'mine.txt')])).not.toBe(0)
    expect(await turn('chat1', ['read', TMP_SECRET])).not.toBe(0)
    expect(await turn('chat1', ['tcp', '1.1.1.1', '443'])).not.toBe(0)
    expect(await turn('chat1', ['tcp', '127.0.0.1', '19173'])).toBe(0)
    // the per-turn files the launcher writes (.turn/) are inside the chat folder and readable by the engine
    expect(await turn('chat1', ['list', '{TURN_DIR}'])).toBe(0)
  })
})
