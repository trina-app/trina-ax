// Dev environment on a Mac team server (docs/DECISIONS.md "Dev environment on a Mac team server"): the macOS settings
// file, the Seatbelt rules that srt-mac.mjs adds (the run's own port; on a Mac they are also applied with sandbox-exec),
// the RAM watchdog and clean-up of run-wrap-mac (with a process group in place of a dev slot account), and the macOS
// SrtSystem (slots, state files, sudo argv) against a fake Mac. The real accounts, sudoers and pf are checked by the
// attack checks on a real Mac (tests/macos/srt-attack-mac.sh).
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DENIED_RANGES, MAC_DENIED_SYSTEM_PATHS, MAC_ETC_SECRETS, MAC_SYSTEM_READ_PATHS, SLOT_ACCOUNT_RE, SRT_PATHS, devenvPaths, macArgv, runEnv, settingsProblems, srtSettings } from '../../server/src/devenv/srt/config'
import { macConfig, macSystem, parsePs, psSeconds, type MacHost, type MacProc } from '../../server/src/devenv/srt/system-mac'
import type { SpawnSpec } from '../../server/src/devenv/srt/system'

setDefaultTimeout(60_000)
const REPO = path.join(import.meta.dir, '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-mac-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ---------------- the settings file on macOS ----------------

const BASE = '/Library/Application Support/mycel'
const TEAM = `${BASE}/team`
const view = { read: ['', 'projects/falcon'], write: ['projects/falcon', 'users/alice'], denyRead: [], denyWrite: [] }
const input = { base: BASE, id: 'mycel', teamRoot: TEAM, userId: 'alice', view, start: 'projects/falcon', work: null, network: 'open' as const, extraDomains: [], denyHosts: ['team.example.com'], denyAddrs: [], platform: 'darwin' as const }

describe('the srt settings file on macOS', () => {
  test('localhost stays closed: allowLocalBinding false (srt-mac.mjs adds the run\'s own port)', () => {
    const s = srtSettings(input)
    expect(s.network.allowLocalBinding).toBe(false)
    expect(settingsProblems(s, input)).toEqual([])
    expect(settingsProblems({ ...s, network: { ...s.network, allowLocalBinding: true } }, input).join()).toContain('localhost is open')
    // Linux keeps its own localhost per run
    expect(srtSettings({ ...input, platform: 'linux' }).network.allowLocalBinding).toBe(true)
  })
  test('the Mac is hidden but for programs, a few /etc files and the Trina tools; the base folder and the homes are hidden', () => {
    const s = srtSettings(input)
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining([BASE, ...MAC_DENIED_SYSTEM_PATHS]))
    expect(s.filesystem.allowRead).toEqual(expect.arrayContaining(MAC_SYSTEM_READ_PATHS))
    expect(s.filesystem.allowRead).not.toContain('/etc')
    expect(s.filesystem.allowRead).not.toContain('/Library')
    for (const r of s.filesystem.allowRead) expect(r.startsWith('/Users') || r.startsWith('/Volumes')).toBe(false)
    // the Linux file outside the base folder does not exist on a Mac
    expect(s.filesystem.denyRead).not.toContain('/etc/default/mycel')
    // the private ranges are denied on a Mac too
    expect(s.network.deniedResolvedAddresses).toEqual(expect.arrayContaining(DENIED_RANGES))
  })
  test('no host secret is in the read list, and a settings file that reads one is refused', () => {
    for (const r of MAC_SYSTEM_READ_PATHS) for (const e of MAC_ETC_SECRETS) expect(r === e || r.startsWith(e + '/') || e.startsWith(r + '/')).toBe(false)
    const s = srtSettings(input)
    const bad = { ...s, filesystem: { ...s.filesystem, allowRead: [...s.filesystem.allowRead, '/private/etc/sudoers.d'] } }
    expect(settingsProblems(bad, input).join()).toContain('a host secret is readable')
    const open = { ...s, filesystem: { ...s.filesystem, denyRead: s.filesystem.denyRead.filter((d) => d !== '/Users') } }
    expect(settingsProblems(open, input).join()).toContain('a host path is not hidden: /Users')
  })
  test('the environment: Homebrew in PATH, a Mac locale, nothing from the server', () => {
    const e = runEnv({ base: BASE, userId: 'alice', teamRoot: TEAM, work: null, platform: 'darwin' })
    expect(e.PATH).toBe('/opt/trina/node/bin:/opt/trina/python3/bin:/Library/Developer/CommandLineTools/usr/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(e.LANG).toBe('en_US.UTF-8')
    expect(Object.keys(e).some((k) => k.startsWith('MYCEL'))).toBe(false)
  })
  test('the argv: sudo to the slot account, the environment, run-wrap-mac with the limits, srt-mac', () => {
    const a = macArgv({ account: '_axdev3', env: { HOME: '/h', PORT: '47903' }, limits: { cpus: 1, memoryMiB: 2048, pids: 384, runtimeMaxSec: 150 }, poolMiB: 8192, exitFile: '/x/r.exit', settingsFile: '/r/s.json', command: 'echo hi' })
    expect(a).toEqual([SRT_PATHS.sudo, '-n', '-u', '_axdev3', 'HOME=/h', 'PORT=47903', SRT_PATHS.runWrapMac, 'run', '/x/r.exit', '2048', '384', '150', '8192', '--', SRT_PATHS.node, SRT_PATHS.cliMac, '--settings', '/r/s.json', '-c', 'echo hi'])
    // never a person's account (run-wrap-mac kills every process of the account it runs as)
    expect(() => macArgv({ account: 'alice', env: {}, limits: { cpus: 1, memoryMiB: 1, pids: 1, runtimeMaxSec: 1 }, poolMiB: 1, exitFile: '', settingsFile: '', command: '' })).toThrow('not a dev slot account')
    expect(() => macArgv({ account: '_axdev1', env: { 'A B': 'x' }, limits: { cpus: 1, memoryMiB: 1, pids: 1, runtimeMaxSec: 1 }, poolMiB: 1, exitFile: '', settingsFile: '', command: '' })).toThrow('bad environment variable')
    for (const ok of ['_axdev1', '_mycelteamdev12']) expect(SLOT_ACCOUNT_RE.test(ok)).toBe(true)
    for (const no of ['axdev1', '_axdev', '_axserver', '_axdev123', 'root', '_AXdev1']) expect(SLOT_ACCOUNT_RE.test(no)).toBe(false)
  })
})

// ---------------- the Seatbelt rules of srt-mac.mjs ----------------

/** srt-mac.mjs with stand-ins for srt's modules: SandboxManager is not needed for patch(), and quote() is srt 0.0.81's
 * (dist/utils/shell-quote.js), copied here as it is. */
function loadSrtMac() {
  const dir = path.join(tmp, 'srtmac')
  const dist = path.join(dir, 'node_modules/@anthropic-ai/sandbox-runtime/dist')
  fs.mkdirSync(path.join(dist, 'utils'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.js'), 'export const SandboxManager = {}\n')
  fs.writeFileSync(path.join(dist, 'utils/shell-quote.js'), `export function quote(args) {
  return args.map((arg) => { if (arg === '') return "''"; if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) return arg; return "'" + arg.replace(/'/g, \`'"'"'\`) + "'" }).join(' ')
}\n`)
  fs.copyFileSync(path.join(REPO, 'scripts/dev-env/srt/srt-mac.mjs'), path.join(dir, 'mac.mjs'))
  return { dir, mod: import(path.join(dir, 'mac.mjs') + '?test') as Promise<typeof import('../../scripts/dev-env/srt/srt-mac.mjs')> }
}

describe('srt-mac.mjs', () => {
  const quoteOf = async (dir: string) => (await import(path.join(dir, 'node_modules/@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js'))).quote as (a: string[]) => string
  /** a profile the shape of srt 0.0.81's (allowLocalBinding false): sysctl allows, the network section, file rules */
  const PROFILE = '(version 1)\n(deny default)\n(allow sysctl-read (sysctl-name-prefix "kern.proc.all"))\n\n; Network\n(allow network-outbound (remote ip "localhost:41000"))\n\n; File read\n(deny file-read* (subpath "/"))\n(allow file-read* (subpath "/team/Bob\'s project"))\n'

  test('adds the run\'s own port (bind, accept, connect) after srt\'s network rules, kern.proc.all deny, and the /etc link at the end', async () => {
    const { dir, mod } = loadSrtMac()
    const m = await mod, quote = await quoteOf(dir)
    const wrapped = quote(['env', 'HTTP_PROXY=http://localhost:41000', '/usr/bin/sandbox-exec', '-p', PROFILE, '/bin/bash', '-c', "echo 'a' && x!=y"])
    const w = m.words(m.patch(wrapped, 47903))
    // the other words are srt's, unchanged
    expect(w.filter((_, i) => i !== 4)).toEqual(['env', 'HTTP_PROXY=http://localhost:41000', '/usr/bin/sandbox-exec', '-p', '/bin/bash', '-c', "echo 'a' && x!=y"])
    const p = w[4]!
    const at = (s: string) => p.indexOf(s)
    expect(at('(allow network-bind (local ip "*:47903"))')).toBeGreaterThan(at('; Network'))
    expect(at('(allow network-outbound (remote ip "localhost:47903"))')).toBeGreaterThan(at('; Network'))
    expect(at('(deny sysctl-read (sysctl-name-prefix "kern.proc.all"))')).toBeGreaterThan(at('(allow sysctl-read'))
    expect(p.endsWith(m.END_RULES)).toBe(true)
    expect(p).toContain("Bob's project")
    // no port: no bind and no connect rule of its own
    expect(m.words(m.patch(wrapped, null))[4]).not.toContain('network-bind')
  })
  test('fails closed on a profile of another shape, an open localhost, or a bad port', async () => {
    const { dir, mod } = loadSrtMac()
    const m = await mod, quote = await quoteOf(dir)
    const cmd = (profile: string) => quote(['env', '/usr/bin/sandbox-exec', '-p', profile, '/bin/bash', '-c', 'x'])
    expect(() => m.patch(cmd(PROFILE.replace('\n; Network\n', '\n')), 1)).toThrow('network sections')
    expect(() => m.patch(cmd(PROFILE + '\n; Network\n'), 1)).toThrow('network sections')
    expect(() => m.patch(cmd(PROFILE.replace('localhost:41000', 'localhost:*')), 1)).toThrow('every localhost port')
    expect(() => m.patch(quote(['env', '/usr/bin/other', '-p', PROFILE]), 1)).toThrow('sandbox-exec')
    expect(() => m.patch(cmd(PROFILE) + ' "x"', 1)).toThrow()
    for (const v of ['80', '70000', '1e4', '4000;', ' 4000']) expect(() => m.portOf(v)).toThrow()
    expect(m.portOf(undefined)).toBe(null)
    expect(m.portOf('47901')).toBe(47901)
  })
  test.skipIf(process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec'))('Seatbelt: a run binds and reaches its own port only (real sandbox-exec)', async () => {
    const { mod } = loadSrtMac()
    const m = await mod
    const free = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)) }) })
    const own = await free(), other = await free()
    // the server's port: something listens there outside the sandbox
    let reached = 0
    const server = net.createServer((c) => { reached++; c.end('server') }).listen(other, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    try {
      // srt's network section with no proxy (allowLocalBinding false), then the rules of srt-mac.mjs
      const profile = `(version 1)\n(allow default)\n(deny network*)\n(allow network* (remote unix-socket))\n${m.extraRules(own)}`
      const js = `const net=require('net');const out=[];
        const srv=net.createServer(c=>c.end('own')).listen(${own},()=>{
          const c=net.connect(${own},'127.0.0.1');c.on('data',d=>out.push('own:'+d));c.on('error',e=>out.push('own:'+e.code));c.on('close',()=>{
            const d=net.connect(${other},'127.0.0.1');d.on('data',x=>out.push('other:'+x));d.on('error',e=>out.push('other:'+e.code));d.on('close',()=>{
              const b=net.createServer().listen(${other + 1});b.on('error',e=>{out.push('bind:'+e.code);console.log(out.join(' '));process.exit(0)});b.on('listening',()=>{out.push('bind:ok');console.log(out.join(' '));process.exit(0)})})})})`
      // not spawnSync: this process must answer on the server port meanwhile
      const p = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', js], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      p.stdout!.on('data', (d) => { stdout += d })
      await new Promise((r) => p.on('exit', r))
      // Seatbelt refuses the connect with EPERM (bun reports it as ECONNREFUSED); the server port saw nothing
      expect(stdout.trim()).toMatch(/^own:own other:(EPERM|ECONNREFUSED) bind:EPERM$/)
      expect(reached).toBe(0)
    } finally { server.close() }
  })
})

// ---------------- run-wrap-mac: limits, watchdog, clean-up ----------------

/** run-wrap-mac with the slot = a process group of this test's account (TEST_PGID) in place of a dev slot account's
 * uid. Only the two slot lines and the account check change; the rest is the file as shipped. */
function wrapCopy(): string {
  const src = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/run-wrap-mac'), 'utf8')
  const swap = (s: string, from: RegExp, to: string) => { if (!from.test(s)) throw new Error(`run-wrap-mac changed: ${from}`); return s.replace(from, () => to) }
  let s = swap(src, /^\[\[ "\$ME" =~ .*$/m, ': # the test runs as its own account')
  s = swap(s, /^slot_ps\(\) \{.*$/m, `slot_ps() { ps -A -o pid=,ppid=,stat=,rss=,pgid=,command= | awk -v g="$TEST_PGID" '$5 == g'; }`)
  s = swap(s, /^pool_ps\(\) \{.*$/m, `pool_ps() { ps -A -o uid=,rss=,pgid= | awk -v g="$TEST_PGID" '$3 == g { print $1, $2 }'; }`)
  const f = path.join(tmp, `run-wrap-mac-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(f, s, { mode: 0o755 })
  return f
}
/** run the copy in a process group of its own; resolves with its exit code */
function runWrap(args: string[], env: Record<string, string> = {}) {
  const f = wrapCopy()
  const p = spawn('/bin/bash', [f, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, TEST_PGID: '' } })
  // the group is the child's own pid (detached: setsid)
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    let out = '', err = ''
    p.stdout!.on('data', (d) => { out += d }); p.stderr!.on('data', (d) => { err += d })
    p.on('exit', (code) => resolve({ code, out, err }))
  })
  return { pid: p.pid!, done, file: f }
}
/** the same, with TEST_PGID set to the child's own group: the script's env is read when it starts, so the group id is
 * passed through a tiny launcher that knows its own pid */
function runSlot(args: string[]) {
  const f = wrapCopy()
  const launcher = `export TEST_PGID=$$; exec /bin/bash "${f}" "$@"`
  const p = spawn('/bin/bash', ['-c', launcher, 'launcher', ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    let out = '', err = ''
    p.stdout!.on('data', (d) => { out += d }); p.stderr!.on('data', (d) => { err += d })
    p.on('exit', (code) => resolve({ code, out, err }))
  })
  return { pgid: p.pid!, done, file: f }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true } catch { return false } }
/** the watchdog may still check the slot for a moment after the run ended */
const groupGone = async (pgid: number) => { for (let i = 0; i < 50 && groupAlive(pgid); i++) await Bun.sleep(100); return !groupAlive(pgid) }
const bun = process.execPath

describe('run-wrap-mac', () => {
  const exitFile = (n: string) => path.join(tmp, `${n}.exit`)
  test('the exit code goes to the exit file; what the command left behind is killed', async () => {
    const ef = exitFile('a'), pidFile = path.join(tmp, 'left.pid')
    const r = runSlot(['run', ef, '512', '2000', '60', '4096', '--', '/bin/bash', '-c', `sleep 300 & echo $! > ${pidFile}; exit 3`])
    const res = await r.done
    expect(res.err).toBe('')
    expect(res.code).toBe(3)
    expect(fs.readFileSync(ef, 'utf8').trim()).toBe('3')
    const left = Number(fs.readFileSync(pidFile, 'utf8'))
    await Bun.sleep(300)
    expect(alive(left)).toBe(false)
    expect(groupAlive(r.pgid)).toBe(false)
  })
  test('over the memory limit: the watchdog writes .oom and kills the run (no exit code)', async () => {
    const ef = exitFile('b')
    const r = runSlot(['run', ef, '64', '2000', '60', '4096', '--', bun, '-e', 'const a=[];setInterval(()=>a.push(Buffer.alloc(32<<20,1)),100)'])
    const res = await r.done
    expect(res.code).not.toBe(0)
    expect(fs.existsSync(`${ef}.oom`)).toBe(true)
    expect(fs.existsSync(ef)).toBe(false)
    expect(await groupGone(r.pgid)).toBe(true)
  })
  test('over the pool limit (all slots together) the slot that uses the most ends', async () => {
    const ef = exitFile('c')
    const r = runSlot(['run', ef, '4096', '2000', '60', '64', '--', bun, '-e', 'const a=[];setInterval(()=>a.push(Buffer.alloc(32<<20,1)),100)'])
    await r.done
    expect(fs.readFileSync(`${ef}.oom`, 'utf8')).toStartWith('pool ')
  })
  test('past the time limit: .timeout, and the run is killed', async () => {
    const ef = exitFile('d')
    const t0 = Date.now()
    const r = runSlot(['run', ef, '512', '2000', '1', '4096', '--', '/bin/sleep', '60'])
    await r.done
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(fs.existsSync(`${ef}.timeout`)).toBe(true)
    expect(fs.existsSync(ef)).toBe(false)
  })
  test('stop: SIGTERM to the slot, then SIGKILL', async () => {
    const ef = exitFile('e')
    const r = runSlot(['run', ef, '512', '2000', '60', '4096', '--', '/bin/bash', '-c', 'trap "" TERM; sleep 60'])
    await Bun.sleep(1500)
    const f = wrapCopy()
    const s = spawnSync('/bin/bash', [f, 'stop'], { env: { ...process.env, TEST_PGID: String(r.pgid) }, timeout: 20_000 })
    expect(s.status).toBe(0)
    await r.done
    expect(await groupGone(r.pgid)).toBe(true)
    expect(fs.existsSync(ef)).toBe(false)
  })
  test('a busy slot is refused; bad limits and a relative exit file are refused', async () => {
    const sleeper = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    try {
      const f = wrapCopy()
      const s = spawnSync('/bin/bash', [f, 'run', exitFile('f'), '512', '2000', '60', '4096', '--', '/bin/true'], { env: { ...process.env, TEST_PGID: String(sleeper.pid) }, encoding: 'utf8' })
      expect(s.status).toBe(2)
      expect(s.stderr).toContain('busy')
    } finally { sleeper.kill('SIGKILL') }
    for (const args of [['run', 'rel.exit', '512', '2000', '60', '4096', '--', '/bin/true'], ['run', exitFile('g'), '5x', '2000', '60', '4096', '--', '/bin/true'], ['run', exitFile('g'), '512', '2000', '60', '4096', '/bin/true']]) {
      const r = runWrap(args)
      expect((await r.done).code).toBe(2)
    }
  })
  test('the shipped file refuses any account that is not a dev slot account, and root', () => {
    const r = spawnSync('/bin/bash', [path.join(REPO, 'scripts/dev-env/srt/run-wrap-mac'), 'check'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/not a dev slot account|never as root/)
  })
})

// ---------------- the macOS SrtSystem against a fake Mac ----------------

function fakeMac(o: { uids: Record<string, number>; procs?: MacProc[] }) {
  const calls: string[][] = []
  const spawned: string[][] = []
  const host: MacHost = {
    procs: (uids) => (o.procs ?? []).filter((p) => uids.includes(p.uid)),
    uid: (a) => o.uids[a] ?? null,
    spawn: (argv) => { spawned.push(argv); return { pid: 4242, exited: new Promise(() => {}) } },
    run: async (argv) => { calls.push(argv); return { code: 0, out: argv.includes('check') ? `ok ${argv[3]}` : '', err: '' } },
  }
  return { host, calls, spawned }
}
const ACL = ['group:_axdev allow read,write,file_inherit,directory_inherit', 'user:_axserver allow read,write,file_inherit,directory_inherit']
function macBase() {
  const base = fs.mkdtempSync(path.join(tmp, 'base-'))
  fs.mkdirSync(devenvPaths(base).run, { recursive: true })
  return base
}
const spec = (base: string, runId: string): SpawnSpec => ({
  runId, id: 'mycel', cwd: base, env: { HOME: '/h' }, limits: { cpus: 1, memoryMiB: 9000, pids: 2000, runtimeMaxSec: 150 },
  exitFile: path.join(base, `${runId}.exit`), settingsFile: path.join(base, 's.json'), command: 'echo hi', stdoutFile: path.join(base, 'out'), stderrFile: path.join(base, 'out'),
  writable: ['/team/projects/falcon'],
})

describe('the macOS SrtSystem (fake Mac)', () => {
  test('macConfig: the slots, the port base, the pool and the ACL from the environment; anything wrong is a reason', () => {
    const env = { MYCEL_DEV_ENV_SLOTS: '_axdev1,_axdev2', MYCEL_DEV_ENV_PORT_BASE: '47900', MYCEL_DEV_ENV_POOL_MIB: '8192', MYCEL_DEV_ENV_PIDS_MAX: '384', MYCEL_DEV_ENV_ACL: ACL.join(';') }
    const c = macConfig('/b', env)
    expect(c.ok && c.c).toEqual({ base: '/b', slots: ['_axdev1', '_axdev2'], portBase: 47900, poolMiB: 8192, pidsMax: 384, acl: ACL })
    expect(macConfig('/b', { ...env, MYCEL_DEV_ENV_SLOTS: '' }).ok).toBe(false)
    expect(macConfig('/b', { ...env, MYCEL_DEV_ENV_SLOTS: '_axdev1,alice' }).ok).toBe(false)
    expect(macConfig('/b', { ...env, MYCEL_DEV_ENV_PORT_BASE: '80' }).ok).toBe(false)
    expect(macConfig('/b', { ...env, MYCEL_DEV_ENV_ACL: 'everyone allow read' }).ok).toBe(false)
  })
  test('a run takes the first free slot, its port, and the limits cut to the pool; the writable folders get the ACL first', async () => {
    const base = macBase()
    const f = fakeMac({ uids: { _axdev1: 451, _axdev2: 452 } })
    const sys = macSystem({ base, slots: ['_axdev1', '_axdev2'], portBase: 47900, poolMiB: 4096, pidsMax: 384, acl: ACL }, f.host)
    await sys.spawn(spec(base, 'aaaaaaaaaaaaaaaa'))
    const argv = f.spawned[0]!
    expect(argv.slice(0, 4)).toEqual([SRT_PATHS.sudo, '-n', '-u', '_axdev1'])
    expect(argv).toContain('PORT=47901')
    expect(argv).toContain('TRINA_PREVIEW_PORT=47901')
    const at = argv.indexOf('run')
    expect(argv.slice(at + 2, at + 6)).toEqual(['4096', '384', '150', '4096'])
    expect(f.calls.filter((c) => c[0] === '/bin/chmod')).toEqual(ACL.map((a) => ['/bin/chmod', '-R', '+a', a, '/team/projects/falcon']))
    expect(sys.slotOf('aaaaaaaaaaaaaaaa')).toEqual({ account: '_axdev1', port: 47901 })
    expect(await sys.units()).toEqual(['trina-dev-aaaaaaaaaaaaaaaa.scope'])
    // the second run: the next slot
    await sys.spawn(spec(base, 'bbbbbbbbbbbbbbbb'))
    expect(f.spawned[1]!.slice(0, 4)).toEqual([SRT_PATHS.sudo, '-n', '-u', '_axdev2'])
    // no slot left
    await expect(Promise.resolve(sys.spawn(spec(base, 'cccccccccccccccc')))).rejects.toThrow('every dev slot account is in use')
  })
  test('a slot with processes and no run (a crash) is stopped and skipped; a stop goes to the run\'s slot', async () => {
    const base = macBase()
    const f = fakeMac({ uids: { _axdev1: 451, _axdev2: 452 }, procs: [{ uid: 451, pid: 9, rssKiB: 10, cpuSec: 0, ageSec: 5, command: 'sleep' }] })
    const sys = macSystem({ base, slots: ['_axdev1', '_axdev2'], portBase: 47900, poolMiB: 4096, pidsMax: 384, acl: ACL }, f.host)
    await sys.spawn(spec(base, 'dddddddddddddddd'))
    expect(f.calls).toContainEqual([SRT_PATHS.sudo, '-n', '-u', '_axdev1', SRT_PATHS.runWrapMac, 'stop'])
    expect(f.spawned[0]!.slice(0, 4)).toEqual([SRT_PATHS.sudo, '-n', '-u', '_axdev2'])
    f.calls.length = 0
    await sys.stop('dddddddddddddddd')
    expect(f.calls).toEqual([[SRT_PATHS.sudo, '-n', '-u', '_axdev2', SRT_PATHS.runWrapMac, 'stop']])
  })
  test('unit, memory, OOM and time-limit markers; forget removes the state', async () => {
    const base = macBase()
    const procs: MacProc[] = []
    const f = fakeMac({ uids: { _axdev1: 451 }, procs })
    const sys = macSystem({ base, slots: ['_axdev1'], portBase: 47900, poolMiB: 4096, pidsMax: 384, acl: ACL }, f.host)
    const s = spec(base, 'eeeeeeeeeeeeeeee')
    await sys.spawn(s)
    expect((await sys.unit('eeeeeeeeeeeeeeee')).state).toBe('activating')
    procs.push({ uid: 451, pid: 10, rssKiB: 1024, cpuSec: 2.5, ageSec: 3, command: 'node' }, { uid: 451, pid: 11, rssKiB: 1024, cpuSec: 0.5, ageSec: 3, command: 'bash' })
    expect(await sys.unit('eeeeeeeeeeeeeeee')).toEqual({ state: 'active', result: '', memoryBytes: 2048 * 1024 })
    expect(sys.cpuUsec('eeeeeeeeeeeeeeee')).toBe(3_000_000)
    expect(sys.procs('eeeeeeeeeeeeeeee').map((p) => p.pid)).toEqual([10, 11])
    expect(sys.oomKills('eeeeeeeeeeeeeeee')).toBe(0)
    procs.length = 0
    fs.writeFileSync(`${s.exitFile}.oom`, '99999')
    expect(sys.oomKills('eeeeeeeeeeeeeeee')).toBe(1)
    expect(await sys.unit('eeeeeeeeeeeeeeee')).toEqual({ state: 'failed', result: 'oom-kill', memoryBytes: null })
    await sys.forget('eeeeeeeeeeeeeeee')
    expect(fs.existsSync(`${s.exitFile}.oom`)).toBe(false)
    expect(await sys.units()).toEqual([])
    expect(sys.oomKills('eeeeeeeeeeeeeeee')).toBe(null)
  })
  test('the self test runs run-wrap-mac check as a slot account through sudo', async () => {
    const f = fakeMac({ uids: { _axdev1: 451 } })
    const sys = macSystem({ base: macBase(), slots: ['_axdev1'], portBase: 47900, poolMiB: 4096, pidsMax: 384, acl: ACL }, f.host)
    expect(await sys.selfTest('mycel')).toBe('')
    expect(f.calls).toEqual([[SRT_PATHS.sudo, '-n', '-u', '_axdev1', SRT_PATHS.runWrapMac, 'check']])
    const none = macSystem({ base: macBase(), slots: ['_axdev1'], portBase: 47900, poolMiB: 4096, pidsMax: 384, acl: ACL }, fakeMac({ uids: {} }).host)
    expect(await none.selfTest('mycel')).toContain('no dev slot account exists')
  })
  test('ps: times and lines', () => {
    expect(psSeconds('0:02.50')).toBe(2.5)
    expect(psSeconds('01:02:03')).toBe(3723)
    expect(psSeconds('2-00:00:01')).toBe(172801)
    const t = '  451   10 S     2048   0:01.00    00:05 node /opt/trina/srt/x.js\n  501   11 S  1 0:00.00 00:01 other\n  451   12 Z  0 0:00.00 00:09 <defunct>\n'
    expect(parsePs(t, new Set([451]))).toEqual([{ uid: 451, pid: 10, rssKiB: 2048, cpuSec: 1, ageSec: 5, command: 'node /opt/trina/srt/x.js' }])
  })
})
