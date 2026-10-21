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
// stands in for the server's data folder (app.db) next to the agent root
const DATA = path.join(W, 'data')

beforeAll(() => {
  if (!mac) return
  fs.rmSync(W, { recursive: true, force: true })
  for (const d of [ENG, CHAT, OTHER, DATA]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(DATA, 'app.db'), 'SQLITE')
  const cc = Bun.spawnSync(['cc', '-O2', '-o', PROBE, path.resolve(import.meta.dir, '..', 'lib', 'g-sbprobe.c')])
  if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())
  fs.writeFileSync(path.join(CHAT, 'mine.txt'), 'mine')
  fs.writeFileSync(path.join(OTHER, 'theirs.txt'), 'theirs')
  fs.writeFileSync(TMP_SECRET, 'left in /tmp by someone')
})
afterAll(() => { fs.rmSync(TMP_SECRET, { force: true }) })

function probe(localLogin: boolean, ...args: string[]): boolean {
  return probeCode(localLogin, ...args) === 0
}
/** exit code of the probe; for `stat`: 0 found, 1 EPERM (sandbox), 3 ENOENT, 4 other */
function probeCode(localLogin: boolean, ...args: string[]): number | null {
  return probeWith({ localLogin }, ...args)
}
function probeWith(o: { localLogin: boolean; home?: string; sessionDir?: string; proxyPort?: number }, ...args: string[]): number | null {
  const p = Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', PROFILE,
    '-D', `CHAT_DIR=${CHAT}`, '-D', `AGENT_ROOT=${AGENT}`, '-D', `ENGINE_DIR=${ENG}`, '-D', 'BRIDGE=/nonexistent/bridge',
    '-D', `TOOLS_SOCK=${path.join(W, 'tools.sock')}`, '-D', `PROXY_PORT=${o.proxyPort ?? 19173}`, '-D', `LOCAL_LOGIN=${o.localLogin ? 1 : 0}`,
    '-D', `USER_HOME=${o.home ?? fs.realpathSync(os.homedir())}`, '-D', `SESSION_DIR=${o.sessionDir ?? CHAT}`,
    PROBE, ...args], { stdout: 'ignore', stderr: 'ignore' })
  return p.exitCode
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

  // security audit r1 (os-layer #1): `(allow file-read-metadata)` without a path let a turn stat() ANY path: whether
  // another chat's files exist, their size and mtime, the server's data folder (app.db), the owner's home. Only
  // the folders above the turn's own paths may be stat()ed now. (A name that does not exist still answers ENOENT
  // instead of EPERM: the kernel resolves the path before the sandbox looks at it, so only an exactly guessed name
  // can be tested. In role-account mode the data/team folders and homes are closed to the engine account by
  // permissions, which answers EACCES either way; see docs/DECISIONS.md.)
  for (const ll of [false, true]) {
    test(`LOCAL_LOGIN=${ll ? 1 : 0}: stat() only on the turn's own paths and the folders above them`, () => {
      const home = fs.realpathSync(os.homedir())
      // own chat folder and the path down to it (realpath walks it)
      expect(probeCode(ll, 'stat', path.join(CHAT, 'mine.txt'))).toBe(0)
      expect(probeCode(ll, 'stat', path.join(CHAT, 'missing.txt'))).toBe(3)
      expect(probeCode(ll, 'stat', CHAT)).toBe(0)
      expect(probeCode(ll, 'stat', AGENT)).toBe(0)
      expect(probeCode(ll, 'stat', '/')).toBe(0)
      expect(probeCode(ll, 'stat', '/usr/lib')).toBe(0)
      expect(probeCode(ll, 'stat', PROBE)).toBe(0)
      // another chat: neither its folder, its files, nor whether a chat id exists
      expect(probeCode(ll, 'stat', OTHER)).toBe(1)
      expect(probeCode(ll, 'stat', path.join(OTHER, 'theirs.txt'))).toBe(1)
      expect(probeCode(ll, 'stat', path.join(OTHER, 'not-there.txt'))).not.toBe(0)
      expect(probeCode(ll, 'stat', path.join(AGENT, 'no-such-chat'))).not.toBe(0)
      // the server's data folder next to the agent root, /tmp, the home folder's contents
      expect(probeCode(ll, 'stat', DATA)).toBe(1)
      expect(probeCode(ll, 'stat', path.join(DATA, 'app.db'))).toBe(1)
      expect(probeCode(ll, 'stat', TMP_SECRET)).toBe(1)
      if (fs.existsSync(path.join(home, '.ssh'))) expect(probeCode(ll, 'stat', path.join(home, '.ssh'))).toBe(1)
      if (fs.existsSync(path.join(home, 'Documents'))) expect(probeCode(ll, 'stat', path.join(home, 'Documents'))).toBe(1)
      expect(probeCode(ll, 'stat', path.join(home, 'no-such-folder-' + process.pid))).not.toBe(0)
      expect(probeCode(ll, 'stat', '/Volumes/no-such-volume')).not.toBe(0)
    })
  }

  // security audit r1 (os-layer #1): `(allow sysctl-read)` let a turn list every process on the Mac (KERN_PROC_ALL),
  // other turns' engines included. (Reading one pid's argv, KERN_PROCARGS2, is not a sandbox operation at all: the
  // kernel only checks the uid, see docs/DECISIONS.md; argv carries no secrets.)
  test('no process list', () => {
    for (const ll of [false, true]) expect(probe(ll, 'procs')).toBe(false)
  })

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
    // no metadata of another chat (os-layer #1)
    expect(await turn('chat1', ['stat', '{CHAT_DIR}/mine.txt'])).toBe(0)
    expect(await turn('chat2', ['stat', path.join(CHAT, 'mine.txt')])).toBe(1)
    expect(await turn('chat2', ['stat', path.join(DATA, 'app.db')])).toBe(1)
  })
})
