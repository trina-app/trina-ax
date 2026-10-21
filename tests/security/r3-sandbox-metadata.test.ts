// Security round 3 (os-layer #1, fix incomplete after r1/r2): what an engine turn whose tool lockdown failed can
// still learn with stat() inside scripts/macos/engine.sb.
// r1 replaced the bare (allow file-read-metadata) with "the turn's own paths and the folders above them"; r2 took the
// chat folders out of every argv. Left open:
//  - the agent root itself, the folder above every chat folder: on APFS its st_size / st_nlink grow with every
//    entry, so a turn could count the team's chats and, from st_mtime, see when someone else's chat was created or
//    deleted;
//  - a pattern for every entry of /, which answered stat() of /Users, /Volumes, /Applications, /opt.
// The fixture lives in the system temp folder (not under /Users), like an installed server's folders, so /Users is
// not one of the turn's own ancestors. Probe: tests/lib/g-sbprobe.c (stat exits 0 found, 1 EPERM, 3 ENOENT).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') && !!Bun.which('cc')
const PROFILE = path.resolve(import.meta.dir, '..', '..', 'scripts', 'macos', 'engine.sb')
let B = '', ENG = '', PROBE = '', AGENT = '', A = '', V = '', DATA = '', TEAM = ''

beforeAll(() => {
  if (!mac) return
  B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-r3-sbmeta-')))
  ENG = path.join(B, 'app', 'engine'); PROBE = path.join(ENG, 'probe')
  AGENT = path.join(B, 'agent'); A = path.join(AGENT, 'c_attacker'); V = path.join(AGENT, 'c_victim')
  DATA = path.join(B, 'data'); TEAM = path.join(B, 'team')
  for (const d of [ENG, A, path.join(V, '.claude', 'projects', 'p'), DATA, path.join(TEAM, 'HR')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(A, 'mine.txt'), 'mine')
  fs.writeFileSync(path.join(V, '.claude', 'projects', 'p', 'session.jsonl'), 'victim transcript')
  fs.writeFileSync(path.join(DATA, 'app.db'), 'SQLITE')
  fs.writeFileSync(path.join(TEAM, 'HR', 'layoff-list.xlsx'), 'secret')
  const cc = Bun.spawnSync(['cc', '-O2', '-o', PROBE, path.resolve(import.meta.dir, '..', 'lib', 'g-sbprobe.c')])
  if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())
})
afterAll(() => { if (B) fs.rmSync(B, { recursive: true, force: true }) })

/** run the probe as the attacker chat's engine turn, exactly as the launcher parameterises the profile */
function turn(o: { localLogin?: boolean; sessionDir?: string }, ...args: string[]) {
  const p = Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', PROFILE,
    '-D', `CHAT_DIR=${A}`, '-D', `AGENT_ROOT=${AGENT}`, '-D', `ENGINE_DIR=${ENG}`, '-D', `BRIDGE=${path.join(ENG, 'bridge')}`,
    '-D', `TOOLS_SOCK=${path.join(B, 'run', 'tools.sock')}`, '-D', 'PROXY_PORT=0', '-D', `LOCAL_LOGIN=${o.localLogin ? 1 : 0}`,
    '-D', `USER_HOME=${fs.realpathSync(os.homedir())}`, '-D', `SESSION_DIR=${o.sessionDir ?? A}`,
    PROBE, ...args], { cwd: A, stdout: 'pipe', stderr: 'ignore' })
  return { code: p.exitCode, out: p.stdout.toString() }
}
const stat = (p: string, o: { localLogin?: boolean; sessionDir?: string } = {}) => turn(o, 'stat', p).code

describe.skipIf(!mac)('r3 os-layer #1: engine sandbox metadata', () => {
  for (const ll of [false, true]) {
    test(`LOCAL_LOGIN=${ll ? 1 : 0}: the agent root cannot be stat()ed, so other chats cannot be counted or timed`, () => {
      // before the fix: 0, and st_size / st_nlink / st_mtime moved with every chat someone else created
      expect(stat(AGENT, { localLogin: ll })).toBe(1)
      expect(stat(AGENT + '/', { localLogin: ll })).toBe(1)
      expect(stat(path.join(A, '..'), { localLogin: ll })).toBe(1)
      // dev Codex: the session folder is the chat folder itself, whose ancestors include the agent root
      expect(stat(AGENT, { localLogin: ll, sessionDir: A })).toBe(1)
      expect(turn({ localLogin: ll }, 'list', AGENT).code).not.toBe(0)
    })
  }

  test('the turn still resolves its own working folder and paths in it (getcwd, realpath)', () => {
    const r = turn({}, 'realpath', './mine.txt')
    expect(r.code).toBe(0)
    expect(r.out.trim().split('\n')).toEqual([A, path.join(A, 'mine.txt')])
    expect(stat(A)).toBe(0)
    expect(stat(path.join(A, 'mine.txt'))).toBe(0)
    expect(stat(PROBE)).toBe(0)
    expect(stat(B)).toBe(0) // above the agent root: the install base, a fixed set of folders
  })

  test('another chat, the data folder and the team folder stay closed (the original exploit)', () => {
    expect(stat(V)).toBe(1)
    expect(stat(path.join(V, '.claude', 'projects', 'p', 'session.jsonl'))).toBe(1)
    expect(stat(path.join(A, '..', 'c_victim'))).toBe(1)
    expect(stat(path.join(DATA, 'app.db'))).toBe(1)
    expect(stat(path.join(TEAM, 'HR', 'layoff-list.xlsx'))).toBe(1)
    expect(turn({}, 'read', path.join(DATA, 'app.db')).code).not.toBe(0)
  })

  test('of the entries of / only the system folders answer stat(); /Users, /Volumes, /Applications, /opt do not', () => {
    for (const p of ['/Users', '/Volumes', '/Applications', '/opt']) if (fs.existsSync(p)) expect(stat(p)).toBe(1)
    expect(stat(path.join(fs.realpathSync(os.homedir()), '.ssh'))).not.toBe(0)
    for (const p of ['/', '/usr', '/System', '/Library', '/private', '/etc/hosts', '/usr/lib']) expect(stat(p)).toBe(0)
  })
})
