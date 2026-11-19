// srt's proxy sockets must fit a unix socket path (QA TC-4848, qa.trina.app 2026-11-18): srt 0.0.81 makes two bridge
// sockets in TMPDIR (claude-http-<16 hex>.sock, claude-socks-<16 hex>.sock), and a unix socket path has at most 107
// bytes on Linux. A shared chat's per-command home, /var/lib/mycel/devenv/chat-home/<chat uuid>/<run>/tmp, made them 124
// bytes long, and every command of a shared chat failed with "Failed to create bridge sockets after 5 attempts". The
// Docker suite did not see it: its chat ids were short. This checks the paths for a production base and production ids.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { runEnv, settingsProblems, srtSettings, srtSocketProblems } from '../../server/src/devenv/srt/config'
import * as config from '../../server/src/devenv/srt/config'
import type { FolderView } from '../../server/src/devenv/srt/access'

const BASE = '/var/lib/mycel', TEAM = '/var/lib/mycel/team'
// production ids: uuid v7 chat and user ids (36 characters), a 16-character run id (runner.ts newRunId)
const CHAT = '01a1ed7a-7af4-7154-a36d-2d3319166871', USER = '01a1ed7a-5b10-7c2e-9d4f-3e2a1b0c9d8e', RUN = 'k3v9q2m8x1z7p4w6'
const MAX = 107
/** srt 0.0.81's socket names (sandbox/linux-sandbox-utils.js initializeLinuxNetworkBridge) */
const sockets = (tmp: string) => [`${tmp}/claude-http-0123456789abcdef.sock`, `${tmp}/claude-socks-0123456789abcdef.sock`]
const VIEW: FolderView = { read: [], write: ['projects/one'], denyRead: [], denyWrite: [] }

describe('srt\'s socket paths on a production base', () => {
  test('srt is still 0.0.81 (another version: check its socket names and this test again)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'scripts/dev-env/srt/package.json'), 'utf8'))
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe('0.0.81')
    expect((config.srtSocketPaths('/t')).map((p) => path.basename(p).replace(/0{16}/, 'X'))).toEqual(['claude-http-X.sock', 'claude-socks-X.sock'])
  })
  for (const [what, o] of [['a shared chat\'s command', { sharedChat: CHAT, runId: RUN, logKey: 'b'.repeat(32) }], ['a person\'s own run', {}]] as const) {
    test(`${what}: every socket fits, and the settings check agrees`, () => {
      const env = runEnv({ base: BASE, userId: USER, teamRoot: TEAM, work: null, platform: 'linux', ...o })
      for (const s of sockets(env.TMPDIR!)) expect({ s, n: Buffer.byteLength(s) <= MAX }).toEqual({ s, n: true })
      const input = { base: BASE, id: 'mycel', teamRoot: TEAM, userId: USER, view: VIEW, start: 'projects/one', work: null, network: 'open' as const, extraDomains: [], denyHosts: [], denyAddrs: [], platform: 'linux' as const, ...o }
      const st = srtSettings(input)
      // srt binds TMPDIR writable: the settings give it
      expect(st.filesystem.allowWrite.some((w) => env.TMPDIR === w || env.TMPDIR!.startsWith(w + '/'))).toBe(true)
      expect(settingsProblems(st, input).filter((p) => p.includes('socket'))).toEqual([])
    })
  }
  test('a shared chat\'s temp folder is not longer than a person\'s: a base that works for one works for the other', () => {
    const shared = runEnv({ base: BASE, userId: USER, teamRoot: TEAM, work: null, platform: 'linux', sharedChat: CHAT, runId: RUN, logKey: 'b'.repeat(32) }).TMPDIR!
    const own = runEnv({ base: BASE, userId: USER, teamRoot: TEAM, work: null, platform: 'linux' }).TMPDIR!
    expect(shared.length).toBeLessThanOrEqual(own.length)
  })
  test('a base too long for srt\'s sockets: the run is refused with the reason, not by srt', () => {
    const base = `/var/lib/${'x'.repeat(70)}`
    const tmp = runEnv({ base, userId: USER, teamRoot: `${base}/team`, work: null, platform: 'linux', sharedChat: CHAT, runId: RUN, logKey: 'b'.repeat(32) }).TMPDIR!
    expect(srtSocketProblems(tmp).length).toBe(2)
    expect(srtSocketProblems(runEnv({ base: BASE, userId: USER, teamRoot: TEAM, work: null, platform: 'linux', sharedChat: CHAT, runId: RUN, logKey: 'b'.repeat(32) }).TMPDIR!)).toEqual([])
    // on a Linux host settingsProblems says so (the sockets are made on this machine)
    const input = { base, id: 'mycel', teamRoot: `${base}/team`, userId: USER, view: VIEW, start: 'projects/one', work: null, network: 'open' as const, extraDomains: [], denyHosts: [], denyAddrs: [], platform: 'linux' as const, sharedChat: CHAT, runId: RUN, logKey: 'b'.repeat(32) }
    if (process.platform === 'linux') expect(settingsProblems(srtSettings(input), input).some((p) => p.includes('socket path is too long'))).toBe(true)
  })
})
