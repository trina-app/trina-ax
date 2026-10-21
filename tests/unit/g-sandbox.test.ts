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
function probeWith(o: { localLogin: boolean; localCodex?: boolean; home?: string; sessionDir?: string; proxyPort?: number }, ...args: string[]): number | null {
  const p = Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', PROFILE,
    '-D', `CHAT_DIR=${CHAT}`, '-D', `AGENT_ROOT=${AGENT}`, '-D', `ENGINE_DIR=${ENG}`, '-D', 'BRIDGE=/nonexistent/bridge',
    '-D', `TOOLS_SOCK=${path.join(W, 'tools.sock')}`, '-D', `PROXY_PORT=${o.proxyPort ?? PROXY}`, '-D', `LOCAL_LOGIN=${o.localLogin ? 1 : 0}`,
    '-D', `LOCAL_CODEX=${o.localLogin && (o.localCodex ?? true) ? 1 : 0}`, '-D', `USER_HOME=${o.home ?? fs.realpathSync(os.homedir())}`, '-D', `SESSION_DIR=${o.sessionDir ?? CHAT}`,
    PROBE, ...args], { stdout: 'ignore', stderr: 'ignore' })
  return p.exitCode
}

// stand-ins for the model proxy port and the tools socket. The proxy takes a free port: a fixed one (19173) failed
// with "Failed to listen at 127.0.0.1" whenever another checkout ran this test at the same time.
let proxy: net.Server | null = null
let tools: net.Server | null = null
let PROXY = 0
beforeAll(async () => {
  if (!mac) return
  const srv = net.createServer((c) => c.end())
  await new Promise<void>((ok, fail) => { srv.once('error', fail); srv.listen(0, '127.0.0.1', ok) })
  proxy = srv
  PROXY = (srv.address() as net.AddressInfo).port
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
      expect(probe(ll, 'tcp', '127.0.0.1', String(PROXY))).toBe(true)
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
      expect(probeCode(ll, 'stat', '/')).toBe(0)
      expect(probeCode(ll, 'stat', '/usr/lib')).toBe(0)
      expect(probeCode(ll, 'stat', PROBE)).toBe(0)
      // not the agent root above it either (security audit r3): its size / link count / mtime counted and timed every
      // chat of the team (tests/security/r3-sandbox-metadata.test.ts)
      expect(probeCode(ll, 'stat', AGENT)).toBe(1)
      // another chat: neither its folder, its files, nor whether a chat id exists
      expect(probeCode(ll, 'stat', OTHER)).toBe(1)
      expect(probeCode(ll, 'stat', path.join(OTHER, 'theirs.txt'))).toBe(1)
      expect(probeCode(ll, 'stat', path.join(OTHER, 'not-there.txt'))).not.toBe(0)
      expect(probeCode(ll, 'stat', path.join(AGENT, 'no-such-chat'))).not.toBe(0)
      // security audit r2 (re-attack): neither through "..", nor through a link the turn makes in its own folder
      expect(probeCode(ll, 'stat', path.join(CHAT, '..', path.basename(OTHER), 'theirs.txt'))).toBe(1)
      const link = path.join(CHAT, 'to-theirs-' + (ll ? 1 : 0))
      fs.rmSync(link, { force: true }); fs.symlinkSync(path.join(OTHER, 'theirs.txt'), link)
      expect(probeCode(ll, 'stat', link)).toBe(1)
      fs.rmSync(link, { force: true })
      // the server's data folder next to the agent root, /tmp, the home folder's contents
      expect(probeCode(ll, 'stat', DATA)).toBe(1)
      expect(probeCode(ll, 'stat', path.join(DATA, 'app.db'))).toBe(1)
      expect(probeCode(ll, 'stat', TMP_SECRET)).toBe(1)
      if (fs.existsSync(path.join(home, '.ssh'))) expect(probeCode(ll, 'stat', path.join(home, '.ssh'))).toBe(1)
      if (fs.existsSync(path.join(home, 'Documents'))) expect(probeCode(ll, 'stat', path.join(home, 'Documents'))).toBe(1)
      expect(probeCode(ll, 'stat', path.join(home, 'no-such-folder-' + process.pid))).not.toBe(0)
      if (fs.existsSync(path.join(home, '.codex', 'sessions'))) expect(probeCode(ll, 'stat', path.join(home, '.codex', 'sessions'))).toBe(1)
      expect(probeCode(ll, 'stat', path.join(home, '.claude', 'projects', 'some-other-project'))).not.toBe(0)
      expect(probeCode(ll, 'stat', '/Volumes/no-such-volume')).not.toBe(0)
    })
  }

  // security audit r1 (os-layer #1): `(allow sysctl-read)` let a turn list every process on the Mac (KERN_PROC_ALL),
  // other turns' engines included. (Reading one pid's argv and environment, KERN_PROCARGS2, is not a sandbox
  // operation at all: the kernel only checks the uid. So no argv or environment names a chat: see the launcher test
  // "another turn cannot learn a chat folder from any argv" below and docs/DECISIONS.md.)
  test('Codex: files that change what the engine may do cannot be written in CODEX_HOME; its state files can (design tab 2)', () => {
    const cx = path.join(CHAT, '.codex')
    fs.mkdirSync(path.join(cx, 'sessions'), { recursive: true })
    for (const ll of [false, true]) {
      for (const f of ['config.toml', 'models_cache.json', 'catalog.json', 'AGENTS.md', 'hooks.json', 'skills/x/SKILL.md', 'skills/.system/marker', 'plugins/p.json']) expect(probe(ll, 'write', path.join(cx, f)), f).toBe(false)
      for (const f of ['auth.json', 'logs_2.sqlite', 'state_5.sqlite', 'sessions/rollout.jsonl', 'installation_id']) expect(probe(ll, 'write', path.join(cx, f)), f).toBe(true)
    }
  })

  test('no process list', () => {
    for (const ll of [false, true]) expect(probe(ll, 'procs')).toBe(false)
  })

  test('without local login: no direct internet, no other localhost ports', () => {
    expect(probe(false, 'tcp', '1.1.1.1', '443')).toBe(false)
    expect(probe(false, 'tcp', '127.0.0.1', '22')).toBe(false)
  })

  test('local login: other home files are not readable', () => {
    const home = fs.realpathSync(os.homedir())
    expect(probe(false, 'list', path.join(home, '.claude'))).toBe(false)
    expect(probe(true, 'list', path.join(home, 'Documents'))).toBe(false)
  })

  test('PROXY_PORT=0 (dev, no model proxy): the profile loads and opens no localhost port', () => {
    expect(probeWith({ localLogin: true, proxyPort: 0 }, 'read', path.join(CHAT, 'mine.txt'))).toBe(0)
    expect(probeWith({ localLogin: false, proxyPort: 0 }, 'tcp', '127.0.0.1', String(PROXY))).not.toBe(0)
  })

  // security audit r1 (os-layer #2): LOCAL_LOGIN=1 (dev: the engine runs as the owner) opened the owner's whole
  // ~/.claude and ~/.codex read-write: transcripts of every other Claude Code / Codex session of the owner, the
  // live-session registry with its messaging keys, and settings / hooks / skills / config.toml that the owner's own
  // unsandboxed CLIs load. Now: ~/.claude.json, backups, this turn's session folder, read-only settings.json and the
  // model cache, ~/.codex/auth.json. Checked against a stand-in home folder.
  test('local login: only the CLI login files and this turn\'s session folder of the owner\'s home', () => {
    const H = path.join(W, 'home')
    const P = path.join(H, '.claude', 'projects')
    const mine = path.join(P, '-agent-chat1'), other = path.join(P, '-Users-owner-private-project')
    for (const d of [mine, other, path.join(H, '.claude', 'sessions'), path.join(H, '.claude', 'backups'), path.join(H, '.claude', 'cache'),
      path.join(H, '.claude', 'hooks'), path.join(H, '.codex', 'sessions'), path.join(H, '.ssh')]) fs.mkdirSync(d, { recursive: true })
    const put = (p: string, c = 'x') => fs.writeFileSync(p, c)
    put(path.join(H, '.claude.json'), '{}'); put(path.join(H, '.claude', 'settings.json'), '{}'); put(path.join(H, '.claude', 'CLAUDE.md'))
    put(path.join(H, '.claude', 'history.jsonl')); put(path.join(H, '.claude', 'sessions', '123.json')); put(path.join(H, '.claude', 'sessions', '123.abc.key'))
    put(path.join(other, 's.jsonl'), 'the owner\'s other project'); put(path.join(mine, 'old.jsonl'))
    put(path.join(H, '.codex', 'auth.json'), '{}'); put(path.join(H, '.codex', 'config.toml')); put(path.join(H, '.codex', 'history.jsonl'))
    put(path.join(H, '.codex', 'sessions', 'x.jsonl')); put(path.join(H, '.ssh', 'id_ed25519'))
    const ll = (...a: string[]) => probeWith({ localLogin: true, home: H, sessionDir: mine }, ...a)
    // what the CLIs need
    expect(ll('read', path.join(H, '.claude.json'))).toBe(0)
    expect(ll('write', path.join(H, '.claude.json.tmp.1.abc'))).toBe(0)
    expect(ll('write', path.join(H, '.claude', 'backups', '.claude.json.backup.1'))).toBe(0)
    expect(ll('read', path.join(H, '.claude', 'settings.json'))).toBe(0)
    expect(ll('read', path.join(mine, 'old.jsonl'))).toBe(0)
    expect(ll('write', path.join(mine, 'new.jsonl'))).toBe(0)
    expect(ll('read', path.join(H, '.codex', 'auth.json'))).toBe(0)
    expect(ll('stat', path.join(H, '.claude'))).toBe(0)
    // the owner's other sessions, the session registry and its keys, history
    expect(ll('read', path.join(other, 's.jsonl'))).not.toBe(0)
    expect(ll('stat', path.join(other, 's.jsonl'))).toBe(1)
    expect(ll('list', P)).not.toBe(0)
    expect(ll('list', path.join(H, '.claude', 'sessions'))).not.toBe(0)
    expect(ll('read', path.join(H, '.claude', 'sessions', '123.abc.key'))).not.toBe(0)
    expect(ll('read', path.join(H, '.claude', 'history.jsonl'))).not.toBe(0)
    expect(ll('list', path.join(H, '.claude'))).not.toBe(0)
    expect(ll('read', path.join(H, '.codex', 'history.jsonl'))).not.toBe(0)
    expect(ll('read', path.join(H, '.codex', 'sessions', 'x.jsonl'))).not.toBe(0)
    expect(ll('read', path.join(H, '.codex', 'config.toml'))).not.toBe(0)
    expect(ll('read', path.join(H, '.ssh', 'id_ed25519'))).not.toBe(0)
    // nothing the owner's own CLIs load can be changed
    expect(ll('write', path.join(H, '.claude', 'settings.json'))).not.toBe(0)
    expect(ll('write', path.join(H, '.claude', 'CLAUDE.md'))).not.toBe(0)
    expect(ll('write', path.join(H, '.claude', 'hooks', 'h.sh'))).not.toBe(0)
    expect(ll('write', path.join(H, '.claude', 'settings.local.json'))).not.toBe(0)
    expect(ll('write', path.join(H, '.codex', 'config.toml'))).not.toBe(0)
    expect(ll('write', path.join(H, '.zshrc'))).not.toBe(0)
    expect(ll('write', path.join(other, 'planted.jsonl'))).not.toBe(0)
  })
})

describe.skipIf(!mac)('mycel-launcher --sandbox-profile', () => {
  let proc: Bun.Subprocess<"ignore", "pipe", "inherit">
  const sock = path.join(W, 'launcher.sock')
  beforeAll(async () => {
    proc = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge',
      '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', PROBE, '--sandbox-profile', PROFILE, '--proxy-port', String(PROXY)], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
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
    expect(await turn('chat1', ['tcp', '127.0.0.1', String(PROXY)])).toBe(0)
    // the per-turn files the launcher writes (.turn/) are inside the chat folder and readable by the engine
    expect(await turn('chat1', ['list', '{TURN_DIR}'])).toBe(0)
    // no metadata of another chat (os-layer #1)
    expect(await turn('chat1', ['stat', '{CHAT_DIR}/mine.txt'])).toBe(0)
    expect(await turn('chat2', ['stat', path.join(CHAT, 'mine.txt')])).toBe(1)
    expect(await turn('chat2', ['stat', path.join(DATA, 'app.db')])).toBe(1)
    expect(await turn('chat2', ['stat', AGENT])).toBe(1)
    expect(await turn('chat1', ['realpath', '{CHAT_DIR}/mine.txt'])).toBe(0)
  })

  // security audit r2 (os-layer #1, re-attack): any process of the engine account may read another process's argv
  // (KERN_PROCARGS2) and walk every pid one by one (KERN_PROC_PID); the sandbox cannot stop either (not even a bare
  // `(deny sysctl-read)` does: the kernel only checks the uid). The argv of other turns carried their chat folder:
  // the engine's `--mcp-config <agent>/<chat>/.turn/mcp.json`, Codex's bridge `--turn-dir <agent>/<chat>` and dev
  // catalog path, the bridge's own argv, and for the first milliseconds sandbox-exec's `-D CHAT_DIR=…`. A turn whose
  // tool lockdown failed could so learn which chats exist and are answering right now. Now nothing per chat is in any
  // argv: paths are relative to the engine's working folder (the chat folder) and the sandbox parameters travel in a
  // profile file with a random name that engines cannot read.
  test('another turn cannot learn a chat folder from any argv (KERN_PROCARGS2)', async () => {
    const { buildClaudeLaunch } = await import('../../server/src/engine/claude')
    const { buildCodexLaunch } = await import('../../server/src/engine/codex')
    const victim = 'c_victim' + Math.random().toString(36).slice(2, 8)
    const vdir = path.join(AGENT, victim)
    const sid = crypto.randomUUID()
    const claude = buildClaudeLaunch({ turnId: 'tv', chatDir: vdir, token: 'x', systemPrompt: 's', message: 'm', sessionId: sid, resume: false, stash: null, maxTurns: 1, timeoutMs: 10_000 },
      { bin: PROBE, authMode: 'local-login', agentHome: '/nonexistent' })
    const codex = buildCodexLaunch({ turnId: 'tv', chatDir: vdir, token: 'x', systemPrompt: 's', message: 'm', timeoutMs: 10_000 },
      { bin: PROBE, codexHome: path.join(W, 'codex-home'), agentHome: path.join(W, 'codex-agent-home'), catalog: path.join(W, 'catalog.json'), model: 'm', auth: 'dev-owner-symlink' })
    // the attacker: a turn in another chat watching every new process's argv
    const out: string[] = []
    const attacker = (async () => {
      const h = new SocketLauncher(sock).launch({ op: 'run', turnId: 'ta', chatDir: OTHER, cmd: PROBE, args: ['watchargv', victim, sid, '5000'], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 15_000 })
      for await (const ev of h.events) {
        if (ev.ev === 'stdout') out.push(Buffer.from(ev.b64, 'base64').toString())
        if (ev.ev === 'exit') return
        if (ev.ev === 'error') throw new Error(ev.message)
      }
    })()
    await Bun.sleep(300)
    let mcpJson = ''
    // victim turns with the real Claude and Codex arguments (the probe holds, ignoring them)
    for (const lr of [claude, codex, claude]) {
      const h = new SocketLauncher(sock).launch({ ...lr, sessionCollect: undefined, sessionRestore: undefined, cmd: PROBE, args: ['hold', '1200', ...lr.args, sid], token: 'x', timeoutMs: 10_000 })
      for await (const ev of h.events) {
        if (ev.ev === 'started') { await Bun.sleep(300); mcpJson ||= fs.readFileSync(path.join(vdir, '.turn', 'mcp.json'), 'utf8') }
        if (ev.ev === 'exit') break
        if (ev.ev === 'error') throw new Error(ev.message)
      }
    }
    await attacker
    const text = out.join('')
    // the attack itself works (the victims' argv were read) ...
    expect(text).toContain('SEEN')
    // ... but none of them named the victim's chat
    expect(text.split('\n').filter((l) => l.startsWith('LEAK'))).toEqual([])
    // the bridge's argv (from mcp.json) names no chat folder either
    expect(mcpJson).not.toContain(victim)
    expect(JSON.parse(mcpJson).mcpServers.team.args).toEqual(['--turn-dir', '.', '--sock', path.join(W, 'tools.sock')])
  }, 30_000)

  test('a profile parameter the launcher does not know refuses the turn (fail closed)', async () => {
    const bogus = path.join(W, 'bogus.sb')
    fs.writeFileSync(bogus, fs.readFileSync(PROFILE, 'utf8') + '\n(allow file-read* (subpath (param "NOT_SET")))\n')
    const sock3 = path.join(W, 'launcher3.sock')
    const p3 = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock3, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge',
      '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', PROBE, '--sandbox-profile', bogus], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
    try {
      const r = p3.stdout.getReader()
      expect(new TextDecoder().decode((await r.read()).value)).toContain('ready')
      r.releaseLock()
      const h3 = new SocketLauncher(sock3).launch({ op: 'run', turnId: 'tb', chatDir: CHAT, cmd: PROBE, args: ['read', '{CHAT_DIR}/mine.txt'], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 10_000 })
      let err = '', started = false
      for await (const ev of h3.events) { if (ev.ev === 'error') err = ev.message; if (ev.ev === 'started') started = true }
      expect(started).toBe(false)
      expect(err).toContain('NOT_SET')
    } finally { p3.kill() }
  })

  // security audit r1: the server starts the launcher with an empty environment; USER_HOME came from $HOME, so it was
  // "" and the LOCAL_LOGIN rules opened "/.claude" instead of the owner's login (dev engines: "Not logged in").
  test('--local-login with an empty environment: USER_HOME is the account\'s home', async () => {
    const home = fs.realpathSync(os.homedir())
    const sock2 = path.join(W, 'launcher2.sock')
    const p2 = Bun.spawn([path.join(nativeBinDir(), 'mycel-launcher'), '--listen', sock2, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge',
      '--tools-sock', path.join(W, 'tools.sock'), '--allow-cmd', PROBE, '--sandbox-profile', PROFILE, '--local-login'], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: {} })
    try {
      const r = p2.stdout.getReader()
      expect(new TextDecoder().decode((await r.read()).value)).toContain('ready')
      r.releaseLock()
      const h2 = new SocketLauncher(sock2).launch({ op: 'run', turnId: 'th', chatDir: CHAT, cmd: PROBE, args: ['stat', path.join(home, '.claude')], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 10_000 })
      let code = -1
      for await (const ev of h2.events) if (ev.ev === 'exit') code = ev.code
      // ~/.claude is opened (metadata) only for the account's real home
      expect(code).toBe(fs.existsSync(path.join(home, '.claude')) ? 0 : 3)
    } finally { p2.kill() }
  })
})

// security audit r1 (os-layer #2): DEV mode (`bun run dev`, the owner's dev service that team members reach through
// the relay) started the launcher without --sandbox-profile, so an engine turn ran as the owner with no OS layer:
// a turn whose CLI lockdown failed could read and write the owner's whole home, the server's data folder (every
// user's data, sessions, secrets) and the team folder directly. The dev core now runs every turn under engine.sb with
// LOCAL_LOGIN=1. The probe stands in for an engine whose tool lockdown was bypassed.
describe.skipIf(!mac)('DEV core (startLocalCore): every engine turn runs in the sandbox', () => {
  let h: { ctx: import('../../server/src/context').AppContext; core: import('../../server/src/server').Running } | null = null
  beforeAll(async () => {
    const { testConfig } = await import('./a-lib')
    const { createContext } = await import('../../server/src/context')
    const { openDb } = await import('../../server/src/db')
    const { silentLogger } = await import('../../server/src/log')
    const cfg = testConfig('g-sb', { engine: { authMode: 'local-login', claudeBin: PROBE } })
    fs.mkdirSync(cfg.teamRoot, { recursive: true })
    const db = openDb(path.join(cfg.dataDir, 'app.db'))
    const ctx = createContext({ config: cfg, db, log: silentLogger })
    ctx.onClose(() => db.close())
    fs.mkdirSync(path.join(cfg.teamRoot, 'groups', 'hr'), { recursive: true })
    fs.writeFileSync(path.join(cfg.teamRoot, 'groups', 'hr', 'salaries.xlsx'), 'secret')
    h = { ctx, core: await ctx.core() }
  })
  afterAll(async () => { await h?.ctx.close() })

  async function devTurn(chat: string, args: string[]): Promise<number> {
    const req = { op: 'run' as const, turnId: 't' + Math.random().toString(36).slice(2, 8), chatDir: path.join(h!.core.cfg.agentRoot, chat), cmd: PROBE, args, env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 10_000 }
    for await (const ev of h!.core.launcher!.launch(req).events) {
      if (ev.ev === 'exit') return ev.code
      if (ev.ev === 'error') throw new Error(ev.message)
    }
    throw new Error('no exit event')
  }

  test('own chat folder yes; data folder, team folder, other chats, home and writes outside no', async () => {
    const { dataDir, teamRoot } = h!.ctx.config
    const home = fs.realpathSync(os.homedir())
    expect(await devTurn('c_a', ['write', '{CHAT_DIR}/note.txt'])).toBe(0)
    expect(await devTurn('c_a', ['read', '{TURN_DIR}/mcp.json'])).toBe(0)
    expect(await devTurn('c_b', ['write', '{CHAT_DIR}/theirs.txt'])).toBe(0)
    // the server's data folder (every user's data, sessions, secrets) and the team folder (bypassing the policy)
    expect(await devTurn('c_a', ['read', path.join(dataDir, 'app.db')])).not.toBe(0)
    expect(await devTurn('c_a', ['stat', path.join(dataDir, 'app.db')])).not.toBe(0)
    expect(await devTurn('c_a', ['read', path.join(teamRoot, 'groups', 'hr', 'salaries.xlsx')])).not.toBe(0)
    expect(await devTurn('c_a', ['list', teamRoot])).not.toBe(0)
    // another member's chat
    expect(await devTurn('c_a', ['read', path.join(h!.core.cfg.agentRoot, 'c_b', 'theirs.txt')])).not.toBe(0)
    // the owner's home and writes anywhere else
    expect(await devTurn('c_a', ['list', home])).not.toBe(0)
    if (fs.existsSync(path.join(home, '.ssh'))) expect(await devTurn('c_a', ['list', path.join(home, '.ssh')])).not.toBe(0)
    expect(await devTurn('c_a', ['write', path.join(dataDir, 'planted')])).not.toBe(0)
    expect(fs.existsSync(path.join(dataDir, 'planted'))).toBe(false)
    expect(await devTurn('c_a', ['exec', '/bin/sh'])).not.toBe(0)
  })
})

describe('devEngineSandbox', () => {
  test('macOS: the repository profile with the owner login opened; missing profile = no engines; elsewhere none', async () => {
    const { devEngineSandbox, CoreUnavailableError } = await import('../../server/src/context')
    if (mac) expect(devEngineSandbox('darwin')).toEqual({ profile: PROFILE, localLogin: true })
    expect(() => devEngineSandbox('darwin', path.join(W, 'no-such.sb'))).toThrow(CoreUnavailableError)
    expect(devEngineSandbox('linux')).toBeNull()
  })
})
