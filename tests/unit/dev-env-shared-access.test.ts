// The folder access of a dev environment run in a shared chat (docs/decisions/20261118-devenv-shared-chats.md): the
// same folder rules (RuleSet.access) for the person of the run AND everyone who sees the chat. Pure functions: the
// view (srt/access.ts sharedFolderView), what the answer records as read (sharedReadable), the settings file and the
// environment of such a run (srt/config.ts). Real srt runs are Linux only (tests/linux, the Docker suite).
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { atLeast, type Access, type Principal } from '../../server/src/policy/access'
import { sharedFolderView, sharedReadable, viewAccess, type FolderView } from '../../server/src/devenv/srt/access'
import { chatHome, chatLogs, personHome, personLogs, runEnv, settingsProblems, sharedWork, sharedWorkKey, srtSettings } from '../../server/src/devenv/srt/config'
import { ruleWorld } from '../lib/rule-world'

const who = (id: string, role: Principal['role'] = 'member', groups: string[] = []): Principal => ({ id, name: id, role, groups })
const rows = (xs: (string | null)[][]) => xs.map(([p, t, s, a]) => ({ path: p!, subject_type: t as never, subject_id: s ?? null, access: a as Access }))
// falcon: alice writes, finance (bob) reads; falcon/secret: alice only (a limited folder); falcon/public: everyone reads
const RULES = ruleWorld(rows([
  ['shared', 'everyone', null, 'write'], ['skills', 'everyone', null, 'read'],
  ['groups/marketing', 'group', 'marketing', 'write'], ['groups/finance', 'group', 'finance', 'write'],
  ['projects/falcon', 'user', 'alice', 'write'], ['projects/falcon', 'group', 'finance', 'read'],
  ['projects/falcon/secret', 'user', 'alice', 'write'], ['projects/falcon/public', 'everyone', null, 'read'],
]), ['projects/falcon', 'projects/falcon/secret', 'projects/falcon/public'])
const alice = who('alice', 'member', ['marketing']), bob = who('bob', 'member', ['finance']), erin = who('erin', 'member', ['marketing'])
const carol = who('carol', 'admin'), dana = who('dana', 'owner')
const F = 'projects/falcon'
const PATHS = ['', 'shared/a.md', 'skills/x/SKILL.md', 'groups/marketing/a.md', 'groups/finance/b.md', `${F}`, `${F}/notes.md`, `${F}/secret/s.md`, `${F}/public/p.md`,
  `${F}/skills/x/SKILL.md`, 'projects/atlas/n.md', 'users/alice/diary.md', 'users/bob/n.md', 'users', '.system/x']

/** the expected access, worked out straight from the rules: a path in reach, read only when everyone reads it */
function expected(p: Principal, audience: Principal[], within: string | null, rel: string): Access {
  const s = rel === '' ? [] : rel.split('/')
  if (s[0] === 'users' || s[0] === '.system') return 'none'
  if (within !== null && !(rel === within || rel.startsWith(within + '/'))) return 'none'
  const a = RULES.access(p, s)
  if (a === 'none' || audience.some((q) => !atLeast(RULES.access(q, s), 'read'))) return 'none'
  // writes: only in the project folder (people chats write no team folder), never a skill folder
  if (a === 'write' && within !== null && !/(^|\/)skills(\/|$)/.test(rel.slice(within.length))) return 'write'
  return 'read'
}
const projectView = (p: Principal, audience: Principal[]) => sharedFolderView(RULES, p, { start: F }, { audience, within: F })
const peopleView = (p: Principal, audience: Principal[]) => sharedFolderView(RULES, p, { start: null }, { audience, within: null })
const at = (v: FolderView, rel: string) => viewAccess(v, rel)
const folderViewOf = (): FolderView => ({ read: ['shared'], write: ['users/alice'], denyRead: ['users'], denyWrite: [] })

describe('a shared project chat', () => {
  test('alice with bob: the project folder only, without the folder bob cannot open; she writes where she may', () => {
    const v = projectView(alice, [alice, bob])
    expect(at(v, `${F}/notes.md`)).toBe('write')
    // public is a limited folder everyone reads: read-only for her too
    expect(at(v, `${F}/public/p.md`)).toBe('read')
    expect(at(v, `${F}/secret/s.md`)).toBe('none')
    // readable by both, but outside the project folder
    expect(at(v, 'shared/a.md')).toBe('none')
    expect(at(v, 'skills/x/SKILL.md')).toBe('none')
    // her own folder: never, though she alone may open it
    expect(at(v, 'users/alice/diary.md')).toBe('none')
    expect(at(v, 'groups/marketing/a.md')).toBe('none')
    expect(at(v, `${F}/skills/x/SKILL.md`)).toBe('read')
  })
  test('bob (reads the project) runs it: read-only, the restricted folder hidden', () => {
    const v = projectView(bob, [alice, bob])
    expect(at(v, `${F}/notes.md`)).toBe('read')
    expect(at(v, `${F}/secret/s.md`)).toBe('none')
    expect(v.write).toEqual([])
  })
  test('alice alone in the chat: the restricted folder comes back (her own access, still nothing outside)', () => {
    const v = projectView(alice, [alice])
    expect(at(v, `${F}/secret/s.md`)).toBe('write')
    expect(at(v, 'shared/a.md')).toBe('none')
  })
  test('every path, every audience: the view is the rules for everyone in the chat (an admin and the owner too)', () => {
    for (const audience of [[alice], [alice, bob], [alice, bob, carol], [alice, dana], [alice, erin]]) {
      for (const p of audience.filter((q) => atLeast(RULES.access(q, F.split('/')), 'read'))) {
        if (!audience.every((q) => atLeast(RULES.access(q, F.split('/')), 'read'))) continue
        const v = projectView(p, audience)
        for (const rel of PATHS) expect({ p: p.id, audience: audience.map((q) => q.id), rel, a: at(v, rel) }).toEqual({ p: p.id, audience: audience.map((q) => q.id), rel, a: expected(p, audience, F, rel) })
      }
    }
  })
  test('someone who joins and cannot open the project: the run sees nothing of it but what they read too', () => {
    const v = projectView(alice, [alice, bob, erin])
    for (const rel of PATHS) expect({ rel, a: at(v, rel) }).toEqual({ rel, a: rel === `${F}/public/p.md` ? 'read' : 'none' })
  })
  test('what the answer records as read: every folder the run may read, never the restricted one', () => {
    expect(sharedReadable(RULES, alice, { start: F }, { audience: [alice, bob], within: F })).toEqual([F, `${F}/public`, `${F}/skills`])
    expect(sharedReadable(RULES, alice, { start: F }, { audience: [alice], within: F })).toEqual([F, `${F}/public`, `${F}/secret`, `${F}/skills`])
  })
  test('fails closed: a person not in the audience, a run that does not start in the project folder, a bad folder', () => {
    expect(() => projectView(alice, [bob])).toThrow()
    expect(() => sharedFolderView(RULES, alice, { start: null }, { audience: [alice], within: F })).toThrow()
    expect(() => sharedFolderView(RULES, alice, { start: 'shared' }, { audience: [alice], within: F })).toThrow()
    expect(() => sharedFolderView(RULES, alice, { start: '' }, { audience: [alice], within: '' })).toThrow()
    expect(() => sharedFolderView(RULES, alice, { start: 'projects/../shared' }, { audience: [alice], within: 'projects/../shared' })).toThrow()
  })
})

describe('a chat shared with people and groups', () => {
  test('alice and bob: only the folders both may open, all read-only; no personal folder', () => {
    const v = peopleView(alice, [alice, bob])
    expect(at(v, 'shared/a.md')).toBe('read')
    expect(at(v, 'skills/x/SKILL.md')).toBe('read')
    expect(at(v, `${F}/notes.md`)).toBe('read')
    expect(at(v, `${F}/secret/s.md`)).toBe('none')
    expect(at(v, 'groups/marketing/a.md')).toBe('none')
    expect(at(v, 'groups/finance/b.md')).toBe('none')
    expect(at(v, 'users/alice/diary.md')).toBe('none')
    expect(v.write).toEqual([])
    for (const rel of PATHS) expect({ rel, a: at(v, rel) }).toEqual({ rel, a: expected(alice, [alice, bob], null, rel) })
  })
  test('nothing everyone may open: no team folder at all (the run has its work folder only)', () => {
    const none = ruleWorld(rows([['groups/a', 'user', 'alice', 'write'], ['groups/b', 'user', 'bob', 'write']]), [])
    const v = sharedFolderView(none, alice, { start: null }, { audience: [alice, bob], within: null })
    expect([...v.read, ...v.write]).toEqual([])
    for (const rel of ['', 'groups/a/x', 'groups/b/x', 'users/alice/x']) expect(at(v, rel)).toBe('none')
  })
})

describe('the settings and environment of a shared run', () => {
  const base = '/var/lib/mycel', teamRoot = '/var/lib/mycel/team', chat = 'chat_1', runId = 'abcdefgh12345678'
  const home = path.join(chatHome(base, chat), runId), logs = path.join(chatLogs(base, chat), runId)
  const input = (view: FolderView, start: string | null, sharedChat: string | null, work?: string) => ({
    base, id: 'mycel', teamRoot, userId: 'alice', view, start, work: start === null ? work ?? path.join(base, 'devenv/work', chat) : null, network: 'open' as const,
    extraDomains: [], denyHosts: ['team.example.com'], denyAddrs: [], platform: 'linux' as const, ...(sharedChat ? { sharedChat, runId } : {}),
  })
  test('the chat\'s home and logs, not the person\'s; no personal folder readable; the settings pass their check', () => {
    const i = input(projectView(alice, [alice, bob]), F, chat)
    const s = srtSettings(i)
    // a home and logs of this command alone
    expect(s.filesystem.allowWrite).toContain(home)
    expect(s.filesystem.allowRead).toContain(logs)
    expect(s.filesystem.allowWrite).not.toContain(chatHome(base, chat))
    const all = [...new Set([...s.filesystem.allowRead, ...s.filesystem.allowWrite])]
    expect(all).not.toContain(personHome(base, 'alice'))
    expect(all).not.toContain(personLogs(base, 'alice'))
    expect(all.some((p) => p.startsWith(path.join(teamRoot, 'users')))).toBe(false)
    expect(all.filter((p) => p.startsWith(teamRoot + '/')).every((p) => p === path.join(teamRoot, F) || p.startsWith(path.join(teamRoot, F) + '/'))).toBe(true)
    expect(s.filesystem.denyRead).toContain(path.join(teamRoot, F, 'secret'))
    expect(s.filesystem.denyRead).toContain(path.join(teamRoot, 'users'))
    expect(settingsProblems(s, i)).toEqual([])
  })
  test('the check refuses a shared run that would read a personal folder or a folder outside the project', () => {
    // the person's own view (her own folder, shared/) as if it were the shared run's: refused
    const own: FolderView = { read: ['shared'], write: ['projects/falcon', 'users/alice'], denyRead: ['users'], denyWrite: [] }
    const i = input(own, F, chat)
    const problems = settingsProblems(srtSettings(i), i)
    expect(problems.some((p) => p.includes('a personal folder is readable in a shared chat'))).toBe(true)
    expect(problems.some((p) => p.includes('outside the project folder is readable in a shared chat'))).toBe(true)
    // the same view in her own chat passes (her folder and shared/ are hers to read there)
    const mine = input(own, F, null)
    expect(settingsProblems(srtSettings(mine), mine).filter((p) => p.includes('shared chat'))).toEqual([])
  })
  test('the environment names the chat\'s folders and nothing of the person', () => {
    const env = runEnv({ base, userId: 'alice', teamRoot, work: null, platform: 'linux', sharedChat: chat, runId })
    expect(env.HOME).toBe(home)
    // a short temp folder of its own: srt's sockets there must fit a unix socket path (dev-env-socket-path.test.ts)
    expect(env.TMPDIR).toBe(path.join(base, 'devenv', 'rt', runId))
    expect(env.CLAUDE_CODE_TMPDIR).toBe(env.TMPDIR)
    expect(env.TRINA_LOGS).toBe(logs)
    expect(env.npm_config_cache.startsWith(home)).toBe(true)
    // a shared chat's run with no run id: refused (no shared home to fall back to)
    expect(() => runEnv({ base, userId: 'alice', teamRoot, work: null, platform: 'linux', sharedChat: chat })).toThrow()
    expect(Object.values(env).some((v) => v.includes('alice'))).toBe(false)
    // her own chat: her home, as before
    expect(runEnv({ base, userId: 'alice', teamRoot, work: null, platform: 'linux' }).HOME).toBe(personHome(base, 'alice'))
  })
  test('a shared run never gets the chat\'s private work folder, only its own for the people who see it now', () => {
    const view = peopleView(alice, [alice, bob])
    const priv = input(view, null, chat)
    expect(settingsProblems(srtSettings(priv), priv).some((p) => p.includes('work folder is not in'))).toBe(true)
    expect(settingsProblems(srtSettings(priv), priv).some((p) => p.includes('a private work folder is readable in a shared chat'))).toBe(true)
    const own = input(view, null, chat, sharedWork(base, chat, sharedWorkKey(['alice', 'bob'])))
    expect(settingsProblems(srtSettings(own), own)).toEqual([])
    // the key: the same people, the same folder; anyone more, another one
    expect(sharedWorkKey(['bob', 'alice'])).toBe(sharedWorkKey(['alice', 'bob']))
    expect(sharedWorkKey(['alice'])).not.toBe(sharedWorkKey(['alice', 'bob']))
    // and a private run never gets a shared chat's folder
    const wrong = input(folderViewOf(), null, null, sharedWork(base, chat, sharedWorkKey(['alice'])))
    expect(settingsProblems(srtSettings(wrong), wrong).some((p) => p.includes('work folder is not in'))).toBe(true)
  })
  test('macOS: every personal folder is hidden by name, her own too', () => {
    const i = { ...input(projectView(alice, [alice, bob]), F, chat), platform: 'darwin' as const }
    const s = srtSettings(i)
    expect(s.filesystem.allowRead.some((p) => p.includes('/users/'))).toBe(false)
  })
})
