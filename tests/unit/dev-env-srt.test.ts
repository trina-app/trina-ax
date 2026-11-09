// Dev environment on srt (docs/research/srt-dev-env.md): the folder access of a run (built from the folder rules of
// the person who owns the chat), the settings file, the environment and the argv of a run, the plan file parser, the
// team setting, and box_shell, the queue and the tracker against a fake system (no systemd, no srt). The sandbox itself
// is tested in Docker (tests/linux/srt-attack.ts); systemd, polkit and the memory limits on a VM
// (docs/research/srt-dev-env.md 10.3).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, DEV_ENV_SRT_WARNING_VERSION, DEV_ENV_WARNING_VERSION } from '@mycel/shared/api'
import { DEV_ENV_DEFAULT_DOMAINS, LOCAL_SUFFIXES, extraDomainProblem } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { CANARIES, EXPECTED } from '../lib/fixtures'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { folderView, runMayWrite, viewAccess, type FolderView } from '../../server/src/devenv/srt/access'
import { DENIED_NAMES, DENIED_RANGES, RUN_ID_RE, isFull, SRT_PATHS, SRT_VERSION, UNIT_RE, chatWork, personHome, personLogs, runEnv, scopeArgv, serverFilesOutsideBase, settingsProblems, srtSettings, unitName } from '../../server/src/devenv/srt/config'
import { effectiveLimits, parsePlan, sliceValues, type DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { _active, newRunId, readExit, setSrtSystem, teamHosts, WAIT_MAX_MS } from '../../server/src/devenv/srt/runner'
import { _held, holdPlaceholders, SRT_DENY_DIRS, SRT_DENY_FILES } from '../../server/src/devenv/srt/placeholders'
import { cgroupDir, slicePath, type SpawnSpec, type SrtSystem, type UnitInfo } from '../../server/src/devenv/srt/system'
import { pollSrt, runResultsForAI } from '../../server/src/devenv/jobs'
import { mayUseDevEnv, newConsent, requiredWarningVersion, saveTeamSetting, teamInForce, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
import { fullInternet, grantUserSite, setFullInternet, userSites } from '../../server/src/devenv/sites'
import { configureStorageGuard } from '../../server/src/system/storage'

setDefaultTimeout(40_000)
const REPO = path.join(import.meta.dir, '..', '..')

// ---------------- the folder access of a run ----------------

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const who = (id: string, role: Principal['role'] = 'member', groups: string[] = []): Principal => ({ id, name: id, role, groups })

/** the fixture's rules (tests/lib/fixtures.ts seed) */
const FIXTURE_RULES = new RuleSet([
  ['shared', 'everyone', null, 'write'], ['skills', 'everyone', null, 'read'],
  ['groups/marketing', 'group', 'marketing', 'write'], ['groups/marketing/salaries', 'group', 'marketing', 'none'],
  ['groups/finance', 'group', 'finance', 'write'],
  ['projects/falcon', 'user', 'alice', 'write'], ['projects/falcon', 'group', 'finance', 'read'], ['projects/falcon/public', 'everyone', null, 'read'],
  ['projects/atlas', 'group', 'finance', 'write'],
].map(([p, t, s, a]) => ({ path: p!, subject_type: t as never, subject_id: s, access: a as Access })))
const PEOPLE: Record<string, Principal> = { alice: who('alice', 'member', ['marketing']), bob: who('bob', 'member', ['finance']), carol: who('carol', 'admin'), dana: who('dana', 'owner'), erin: who('erin', 'member', ['marketing']) }

describe('the folder access of a run (from the folder rules)', () => {
  test('alice: her folders, read-only where she reads, hidden where she may not look', () => {
    expect(folderView(FIXTURE_RULES, PEOPLE.alice!)).toEqual({
      read: ['skills'],
      write: ['shared', 'groups/marketing', 'projects/falcon', 'users/alice'],
      denyRead: ['groups/marketing/salaries'],
      denyWrite: ['projects/falcon/public'],
    })
  })
  test('an admin: the whole team folder, but never .system/ or other people\'s personal folders', () => {
    const v = folderView(FIXTURE_RULES, PEOPLE.carol!)
    expect(v.write).toEqual(['', 'users/carol'])
    expect(v.denyRead).toEqual(['.system', 'users'])
    expect(viewAccess(v, 'users/bob/notes.md')).toBe('none')
    expect(viewAccess(v, 'users/carol/x.md')).toBe('write')
    expect(viewAccess(v, '.system/history/old.bin')).toBe('none')
    expect(viewAccess(v, 'groups/finance/budget.md')).toBe('write')
  })
  test('the model of srt gives every fixture path the access the rules give (users/ itself: hidden)', () => {
    for (const [user, rel, want] of EXPECTED) {
      const v = folderView(FIXTURE_RULES, PEOPLE[user]!)
      // users/<other> in another case is a different folder on a case-sensitive disk: still under users/, so hidden
      expect([user, rel, viewAccess(v, rel)]).toEqual([user, rel, want])
    }
    for (const p of Object.values(PEOPLE)) expect(viewAccess(folderView(FIXTURE_RULES, p), 'users')).toBe('none')
  })
  test('random rule trees: never more than the rules give; the same except write below a read-only folder below write', () => {
    const names = ['a', 'b', 'c']
    const folders: string[] = []
    const walk = (pre: string, d: number) => { for (const n of names) { const f = pre ? `${pre}/${n}` : n; folders.push(f); if (d < 3) walk(f, d + 1) } }
    walk('', 1)
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const acc: Access[] = ['none', 'read', 'write']
    let stricter = 0, cases = 0
    for (let round = 0; round < 200; round++) {
      const rows: { path: string; subject_type: 'everyone' | 'user' | 'group'; subject_id: string | null; access: Access }[] = []
      for (const f of ['', ...folders]) {
        if (rnd(4) !== 0) continue
        const t = rnd(3)
        rows.push(t === 0 ? { path: f, subject_type: 'everyone', subject_id: null, access: acc[rnd(3)]! } : t === 1 ? { path: f, subject_type: 'user', subject_id: 'u', access: acc[rnd(3)]! } : { path: f, subject_type: 'group', subject_id: 'g', access: acc[rnd(3)]! })
      }
      const rules = new RuleSet(rows)
      const p = who('u', 'member', rnd(2) ? ['g'] : [])
      const v = folderView(rules, p)
      for (const f of folders) {
        cases++
        const want = rules.access(p, f.split('/')), got = viewAccess(v, f)
        expect(RANK[got]).toBeLessThanOrEqual(RANK[want])
        if (got !== want) {
          // the only allowed difference: write below a read-only folder below a write folder (srt's denyWrite wins)
          expect([want, got]).toEqual(['write', 'read'])
          const segs = f.split('/')
          const above = segs.map((_, i) => rules.access(p, segs.slice(0, i)))
          expect(above.some((a, i) => a === 'read' && above.slice(0, i).includes('write'))).toBe(true)
          stricter++
        }
      }
    }
    expect(cases).toBeGreaterThan(1000)
    expect(stricter).toBeLessThan(cases / 10)
  })
})

describe('a run writes only its starting folder and the person\'s own folder (Q0 (b))', () => {
  const runOf = (start: string | null) => folderView(FIXTURE_RULES, PEOPLE.alice!, { start })
  test('a shared writable group folder is read-only in a run; the start folder and the own folder are writable', () => {
    const v = runOf('projects/falcon')
    expect(v).toEqual({ read: ['shared', 'skills', 'groups/marketing'], write: ['projects/falcon', 'users/alice'], denyRead: ['groups/marketing/salaries'], denyWrite: ['projects/falcon/public'] } as FolderView)
    expect(viewAccess(v, 'groups/marketing/brief.md')).toBe('read')
    expect(viewAccess(v, 'shared/s.md')).toBe('read')
    expect(viewAccess(v, 'projects/falcon/src/x.ts')).toBe('write')
    expect(viewAccess(v, 'projects/falcon/public/notice.md')).toBe('read')
    expect(viewAccess(v, 'users/alice/todo.md')).toBe('write')
    expect(viewAccess(v, 'groups/marketing/salaries/2026.md')).toBe('none')
    expect(viewAccess(v, 'groups/finance/budget.md')).toBe('none')
  })
  test('.git/hooks, package.json and a Makefile in a shared folder cannot be written (G-SRT-11)', () => {
    for (const start of ['projects/falcon', null]) {
      const v = runOf(start)
      for (const f of ['shared/repo/.git/hooks/pre-commit', 'shared/repo/package.json', 'groups/marketing/Makefile', 'groups/marketing/.envrc']) expect([start, f, viewAccess(v, f)]).toEqual([start, f, 'read'])
    }
  })
  test('a chat with no project (the work folder): every team folder is read-only, except the own folder', () => {
    const v = runOf(null)
    expect(v.write).toEqual(['users/alice'])
    expect(viewAccess(v, 'projects/falcon/readme.md')).toBe('read')
    expect(viewAccess(v, 'shared/s.md')).toBe('read')
    expect(viewAccess(v, 'users/alice/x.md')).toBe('write')
  })
  test('an admin\'s run: the team root is read-only, the start folder writable; a start below a rule folder', () => {
    const v = folderView(FIXTURE_RULES, PEOPLE.carol!, { start: 'projects/falcon/app' })
    expect(viewAccess(v, 'groups/finance/budget.md')).toBe('read')
    expect(viewAccess(v, 'projects/falcon/readme.md')).toBe('read')
    expect(viewAccess(v, 'projects/falcon/app/x')).toBe('write')
    expect(viewAccess(v, 'users/carol/x')).toBe('write')
    expect(viewAccess(v, 'users/bob/x')).toBe('none')
  })
  test('a start folder that the person can only read stays read-only; the team root or ".." is refused', () => {
    expect(viewAccess(folderView(FIXTURE_RULES, PEOPLE.bob!, { start: 'projects/falcon' }), 'projects/falcon/x')).toBe('read')
    expect(() => folderView(FIXTURE_RULES, PEOPLE.alice!, { start: '' })).toThrow()
    expect(() => folderView(FIXTURE_RULES, PEOPLE.alice!, { start: 'projects/../shared' })).toThrow()
  })
  test('random rule trees: a run gets the rules\' access, with write only in the start folder and the own folder', () => {
    const names = ['a', 'b', 'c']
    const folders: string[] = []
    const walk = (pre: string, d: number) => { for (const n of names) { const f = pre ? `${pre}/${n}` : n; folders.push(f); if (d < 3) walk(f, d + 1) } }
    walk('', 1)
    let seed = 11
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const acc: Access[] = ['none', 'read', 'write']
    let writes = 0, cases = 0
    for (let round = 0; round < 200; round++) {
      const rows: { path: string; subject_type: 'everyone' | 'user' | 'group'; subject_id: string | null; access: Access }[] = []
      for (const f of ['', ...folders]) {
        if (rnd(4) !== 0) continue
        const t = rnd(3)
        rows.push(t === 0 ? { path: f, subject_type: 'everyone', subject_id: null, access: acc[rnd(3)]! } : t === 1 ? { path: f, subject_type: 'user', subject_id: 'u', access: acc[rnd(3)]! } : { path: f, subject_type: 'group', subject_id: 'g', access: acc[rnd(3)]! })
      }
      const rules = new RuleSet(rows)
      const p = who('u', 'member', rnd(2) ? ['g'] : [])
      const run = { start: rnd(5) === 0 ? null : folders[rnd(folders.length)]! }
      const v = folderView(rules, p, run)
      for (const f of folders) {
        cases++
        const rule = rules.access(p, f.split('/'))
        const capped: Access = rule === 'write' && !runMayWrite(run, p.id, f) ? 'read' : rule
        const got = viewAccess(v, f)
        if (got === 'write') { writes++; expect(runMayWrite(run, p.id, f)).toBe(true) }
        expect(RANK[got]).toBeLessThanOrEqual(RANK[capped])
        // the same as the capped rules, except write below a read-only folder below write (srt's denyWrite wins)
        if (got !== capped) expect([capped, got]).toEqual(['write', 'read'])
        // what the person can see does not change
        expect(got === 'none').toBe(rule === 'none')
      }
    }
    expect(cases).toBeGreaterThan(1000)
    expect(writes).toBeGreaterThan(100)
  })
})

// ---------------- the settings file ----------------

const BASE = '/var/lib/mycel'
const TEAM = `${BASE}/team`
const aliceView = folderView(FIXTURE_RULES, PEOPLE.alice!, { start: 'projects/falcon' })
const input = { base: BASE, id: 'mycel', teamRoot: TEAM, userId: 'alice', view: aliceView, start: 'projects/falcon' as string | null, work: null as string | null, network: 'open' as const, extraDomains: ['api.example.net'], denyHosts: ['Team.Trina.App'], denyAddrs: ['3.3.3.3'] }

describe('the srt settings file', () => {
  test('hides the base folder, users/ and .system/; gives back the person\'s folders, home and logs', () => {
    const s = srtSettings(input)
    expect(s.filesystem.denyRead).toEqual([BASE, '/etc/default/mycel', '/tmp', '/var/log', '/run', '/home', '/root', `${TEAM}/users`, `${TEAM}/.system`, `${TEAM}/groups/marketing/salaries`])
    expect(s.filesystem.allowRead).toEqual([`${TEAM}/shared`, `${TEAM}/skills`, `${TEAM}/groups/marketing`, `${TEAM}/projects/falcon`, `${TEAM}/users/alice`, `${BASE}/devenv/home/alice`, `${BASE}/devenv/logs/alice`])
    expect(s.filesystem.allowWrite).toEqual([`${TEAM}/projects/falcon`, `${TEAM}/users/alice`, `${BASE}/devenv/home/alice`])
    expect(s.filesystem.denyWrite).toEqual([`${TEAM}/projects/falcon/public`])
    expect(settingsProblems(s, input)).toEqual([])
  })
  test('a chat with no project: its work folder is writable too, and no team folder but the own one', () => {
    const work = chatWork(BASE, 'chat-1')
    const w = { ...input, view: folderView(FIXTURE_RULES, PEOPLE.alice!, { start: null }), start: null, work }
    const s = srtSettings(w)
    expect(s.filesystem.allowWrite).toEqual([`${TEAM}/users/alice`, `${BASE}/devenv/home/alice`, work])
    expect(settingsProblems(s, w)).toEqual([])
    expect(settingsProblems(s, { ...w, work: `${BASE}/data` }).join()).toContain('work folder')
  })
  test('a writable folder inside a read-only one is a denyRead landing too, so srt binds it back writable (A28c, A28d)', () => {
    const v = folderView(FIXTURE_RULES, PEOPLE.carol!, { start: 'projects/falcon' })
    const c = { ...input, userId: 'carol', view: v }
    const s = srtSettings(c)
    expect(v.read).toEqual([''])
    expect(s.filesystem.allowRead).toContain(TEAM)
    expect(s.filesystem.allowWrite).toEqual([`${TEAM}/projects/falcon`, `${TEAM}/users/carol`, `${BASE}/devenv/home/carol`])
    expect(s.filesystem.denyRead).toContain(`${TEAM}/projects/falcon`)
    // her own folder is below the team root too: it gets a landing as well (A28d: still writable)
    expect(s.filesystem.denyRead).toContain(`${TEAM}/users/carol`)
    expect(settingsProblems(s, c)).toEqual([])
    // alice's project folder is not inside a folder she reads: no extra landing
    expect(srtSettings(input).filesystem.denyRead).not.toContain(`${TEAM}/projects/falcon`)
  })
  test('the check refuses a team folder outside the starting folder that is writable (a view of the person, not of the run)', () => {
    const personOnly = { ...input, view: folderView(FIXTURE_RULES, PEOPLE.alice!) }
    const problems = settingsProblems(srtSettings(personOnly), personOnly).join('\n')
    expect(problems).toContain(`outside the starting folder is writable: ${TEAM}/shared`)
    expect(problems).toContain(`outside the starting folder is writable: ${TEAM}/groups/marketing`)
    expect(problems).not.toContain(`${TEAM}/projects/falcon\n`)
    const noStart = { ...input, start: null }
    expect(settingsProblems(srtSettings(noStart), noStart).join()).toContain(`writable: ${TEAM}/projects/falcon`)
  })
  test('the network: the default list plus the team list; offline is an empty list; addresses and host names denied', () => {
    const s = srtSettings(input)
    expect(s.network.allowedDomains).toEqual([...DEV_ENV_DEFAULT_DOMAINS, 'api.example.net'])
    expect(s.network.strictAllowlist).toBe(true)
    expect(s.network.deniedDomains).toEqual(['team.trina.app', ...DENIED_NAMES])
    expect(s.network.deniedResolvedAddresses).toEqual([...DENIED_RANGES, '3.3.3.3'])
    expect(srtSettings({ ...input, network: 'offline' }).network.allowedDomains).toEqual([])
  })
  test('the person\'s sites join the list of her run; Full internet turns the strict list off; the deny lists stay', () => {
    const s = srtSettings({ ...input, userDomains: ['example.com', 'API.example.net', '*.cdn.example.org'] })
    expect(s.network.allowedDomains).toEqual([...DEV_ENV_DEFAULT_DOMAINS, 'api.example.net', 'example.com', '*.cdn.example.org'])
    expect(s.network.strictAllowlist).toBe(true)
    expect(isFull(s)).toBe(false)
    const f = srtSettings({ ...input, full: true })
    expect(isFull(f)).toBe(true)
    expect(f.network.deniedResolvedAddresses).toEqual([...DENIED_RANGES, '3.3.3.3'])
    expect(f.network.deniedDomains).toEqual(['team.trina.app', ...DENIED_NAMES])
    expect(settingsProblems(f, input)).toEqual([])
  })
  test('No network wins over the person\'s sites and over Full internet', () => {
    const s = srtSettings({ ...input, network: 'offline', userDomains: ['example.com'], full: true })
    expect(s.network.allowedDomains).toEqual([])
    expect(s.network.strictAllowlist).toBe(true)
    expect(isFull(s)).toBe(false)
  })
  test('the check refuses a run that lost a denied range or name, or allows an address or a denied host', () => {
    const s = srtSettings(input)
    const net = (n: Partial<typeof s.network>) => ({ ...s, network: { ...s.network, ...n } })
    expect(settingsProblems(net({ deniedResolvedAddresses: ['3.3.3.3'] }), input).join()).toContain('a denied range is missing: 10.0.0.0/8')
    expect(settingsProblems(net({ deniedDomains: ['team.trina.app'] }), input).join()).toContain('a denied name is missing')
    expect(settingsProblems(net({ allowedDomains: ['169.254.169.254'] }), input).join()).toContain('not a host name')
    expect(settingsProblems(net({ allowedDomains: ['*'] }), input).join()).toContain('not a host name')
    expect(settingsProblems(net({ allowedDomains: ['trina.app'] }), input).join()).toContain('covers a denied host')
    expect(settingsProblems(net({ allowedDomains: ['*.trina.app'] }), input).join()).toContain('covers a denied host')
  })
  test('server paths outside the base folder are hidden too (a wrong base in the env fails closed)', () => {
    const sp = ['/srv/trina/data', '/srv/trina/secrets', BASE + '/data']
    const s = srtSettings({ ...input, serverPaths: sp })
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining(['/srv/trina/data', '/srv/trina/secrets']))
    expect(s.filesystem.denyRead).not.toContain(BASE + '/data') // inside the base: hidden already
    expect(settingsProblems(s, { ...input, serverPaths: sp })).toEqual([])
    expect(settingsProblems(srtSettings(input), { ...input, serverPaths: sp }).join()).toContain('a server path is not hidden: /srv/trina/data')
  })
  test('a team folder outside the base folder is hidden too', () => {
    const s = srtSettings({ ...input, teamRoot: '/srv/team' })
    expect(s.filesystem.denyRead).toContain('/srv/team')
    expect(settingsProblems(s, { ...input, teamRoot: '/srv/team' })).toEqual([])
  })
  test('the check refuses another person\'s folder, .system, a base folder path, a missing hide', () => {
    const s = srtSettings(input)
    const fsx = (f: Partial<typeof s.filesystem>) => ({ ...s, filesystem: { ...s.filesystem, ...f } })
    expect(settingsProblems(fsx({ allowWrite: [...s.filesystem.allowWrite, `${TEAM}/users/bob`] }), input).join()).toContain('may not write')
    expect(settingsProblems(fsx({ allowRead: [...s.filesystem.allowRead, `${TEAM}/users/bob/x`] }), input).join()).toContain('may not read')
    expect(settingsProblems(fsx({ allowRead: [...s.filesystem.allowRead, `${TEAM}/.system`] }), input).join()).toContain('may not read')
    expect(settingsProblems(fsx({ allowWrite: [`${BASE}/secrets`] }), input).join()).toContain('may not write')
    expect(settingsProblems(fsx({ allowRead: [`${BASE}/devenv/logs/bob`] }), input).join()).toContain('may not read')
    expect(settingsProblems(fsx({ allowWrite: ['/etc'] }), input).join()).toContain('may not write')
    expect(settingsProblems(fsx({ denyRead: ['/tmp'] }), input).join()).toContain('base folder is not hidden')
    expect(settingsProblems(fsx({ denyRead: s.filesystem.denyRead.filter((d) => d !== `${TEAM}/users`) }), input).join()).toContain('personal folders')
  })
  test('the programs a run executes are outside every base folder', () => {
    for (const p of Object.values(SRT_PATHS)) expect(p.startsWith('/var/lib/')).toBe(false)
    expect(SRT_PATHS.cli).toBe(`/opt/trina/srt/${SRT_VERSION}/cli.js`)
    expect(SRT_PATHS.cliFull).toBe(`/opt/trina/srt/${SRT_VERSION}/full.mjs`)
  })
  test('install-srt.sh puts full.mjs next to cli.js and checks it refuses addresses', () => {
    const sh = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/install-srt.sh'), 'utf8')
    expect(sh).toContain('put_changed "$T" 644 "$SRT_DIR/full.mjs"')
    expect(sh).toContain('"$SRT_DIR/full.mjs" --self-test')
    const w = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/srt-full.mjs'), 'utf8')
    // the callback allows only with strictAllowlist false, and never an address or a loopback name
    expect(w).toContain("config?.network?.strictAllowlist === false ? ask([...(config.network.deniedDomains ?? [])]) : undefined")
    expect(w).toContain('isIP(h)')
    // the local names it refuses are the ones a person cannot allow (shared LOCAL_SUFFIXES): the copies agree
    const copy = /export const LOCAL_SUFFIXES = (\[[^\]]*\])/.exec(w)?.[1]
    expect(copy && JSON.parse(copy.replace(/'/g, '"'))).toEqual([...LOCAL_SUFFIXES])
  })
  test('the environment: only the listed keys; HOME and the logs per person; the work folder only for a chat with no project', () => {
    const e = runEnv({ base: BASE, userId: 'alice', teamRoot: TEAM, work: null })
    expect(Object.keys(e).sort()).toEqual(['CI', 'CLAUDE_CODE_TMPDIR', 'HOME', 'LANG', 'NODE_USE_ENV_PROXY', 'PATH', 'PIP_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'SHELL', 'TERM', 'TMPDIR', 'TRINA_LOGS', 'TRINA_TEAM', 'npm_config_cache'])
    expect(e.HOME).toBe(personHome(BASE, 'alice'))
    expect(e.TMPDIR).toBe(`${BASE}/devenv/home/alice/tmp`)
    expect(e.CLAUDE_CODE_TMPDIR).toBe(`${BASE}/devenv/home/alice/tmp`)
    expect(e.TRINA_LOGS).toBe(personLogs(BASE, 'alice'))
    expect(e.TRINA_TEAM).toBe(TEAM)
    expect(runEnv({ base: BASE, userId: 'alice', teamRoot: TEAM, work: chatWork(BASE, 'c1') }).TRINA_WORK).toBe(`${BASE}/devenv/work/c1`)
    expect(() => personHome(BASE, '../bob')).toThrow()
  })
})

describe('the argv of a run', () => {
  test('systemd-run makes a scope that the polkit rule allows, with the limits; srt gets the command as one argument', () => {
    const runId = newRunId()
    expect(runId).toMatch(RUN_ID_RE)
    const a = scopeArgv({ runId, id: 'mycel', limits: { cpus: 1.5, memoryMiB: 1536, pids: 512, runtimeMaxSec: 150 }, exitFile: '/x.exit', settingsFile: '/s.json', command: 'npm test; rm -rf /' })
    expect(a.slice(0, 4)).toEqual(['/usr/bin/systemd-run', '--scope', '--quiet', '--no-ask-password'])
    expect(a).toContain(`--unit=${unitName(runId)}`)
    expect(unitName(runId)).toMatch(UNIT_RE)
    expect(a).toContain('--slice=mycel-devenv.slice')
    for (const p of ['MemoryMax=1536M', 'MemorySwapMax=0', 'CPUQuota=150%', 'TasksMax=512', 'OOMPolicy=kill', 'RuntimeMaxSec=150']) expect(a).toContain(p)
    expect(a.some((x) => x.startsWith('MemoryHigh'))).toBe(false)
    expect(a.slice(a.indexOf('--') + 1)).toEqual([SRT_PATHS.runWrap, '/x.exit', '--', SRT_PATHS.node, SRT_PATHS.cli, '--settings', '/s.json', '-c', 'npm test; rm -rf /'])
    const f = scopeArgv({ runId, id: 'mycel', limits: { cpus: 1, memoryMiB: 512, pids: 64, runtimeMaxSec: 60 }, exitFile: '/x.exit', settingsFile: '/s.json', command: 'true', full: true })
    expect(f).toContain(SRT_PATHS.cliFull)
    expect(f).not.toContain(SRT_PATHS.cli)
  })
  test('the polkit rule allows the same unit names as the runner, and no .service', () => {
    const rule = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/devenv.rules.in'), 'utf8')
    const re = /\/(\^trina-dev-\[a-z0-9\]\{16\}\\\.scope\$)\//.exec(rule)
    expect(re).not.toBeNull()
    expect(new RegExp(re![1]!).source).toBe(UNIT_RE.source)
    expect(rule.split('\n').filter((l) => !l.startsWith('//')).join('\n')).not.toContain('.service')
    expect(rule).toContain('manage-units')
  })
  test('the install pins the same srt version, and hides the same server files outside the base', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/package.json'), 'utf8'))
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe(SRT_VERSION)
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/package-lock.json'), 'utf8'))
    expect(lock.packages['node_modules/@anthropic-ai/sandbox-runtime'].version).toBe(SRT_VERSION)
    for (const [k, v] of Object.entries(lock.packages as Record<string, { integrity?: string }>)) if (k) expect(v.integrity).toMatch(/^sha512-/)
    const sh = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/install-srt.sh'), 'utf8')
    // the version comes from the one list of packages (tests/unit/system-packages.test.ts checks the rest)
    expect(JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/system/packages.json'), 'utf8')).artifacts.srt.version).toBe(SRT_VERSION)
    expect(sh).toContain('SRT_VERSION=$(pk_art srt any version)')
    const files = /SERVER_FILES_OUTSIDE_BASE="([^"]*)"/.exec(sh)![1]!.split(' ').map((f) => f.replace('$ID', 'mycel'))
    expect(files).toEqual(serverFilesOutsideBase('mycel'))
    expect(sh).toContain('ReadWritePaths=-$BASE/devenv')
    expect(sh).toContain('ExecStartPre=+/usr/bin/install -d -o $SRV_USER -g $SRV_USER -m 700 $BASE/devenv')
    expect(sh).toContain('MYCEL_DEV_ENV_RUNNER=srt')
  })
  test('the exit file: a number from 0 to 255, else none', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-'))
    for (const [t, want] of [['0\n', 0], ['137\n', 137], ['255', 255], ['', null], ['256', null], ['-1', null], ['abc', null], ['1 2', null]] as const) {
      fs.writeFileSync(path.join(d, 'e'), t)
      expect(readExit(path.join(d, 'e'))).toBe(want)
    }
    expect(readExit(path.join(d, 'none'))).toBeNull()
  })
})

describe('the plan file (the same rules as mycel-boxd)', () => {
  const ok = '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}'
  test('a good file; network empty means offline', () => {
    expect(parsePlan(ok)).toMatchObject({ plan: 'team', maxRunning: 1, memoryMiB: 2560, network: '' })
  })
  test('the cases that plan_test.go refuses', () => {
    for (const bad of [
      '{"format":2,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":0,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":8,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"network":"host"}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"gpu":1}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512}',
      'not json', '[]',
    ]) expect(() => parsePlan(bad)).toThrow()
  })
  test('a run gets the project\'s wish, cut to the plan; the plan\'s offline wins', () => {
    const plan = parsePlan('{"format":1,"plan":"starter","maxRunning":1,"cpus":1.5,"memoryMiB":1536,"pids":512,"diskGiB":4,"network":"open"}')
    expect(effectiveLimits({ ...DEV_ENV_DEFAULT_LIMITS, cpus: 4, memoryMiB: 8192, pids: 4096 }, 'open', plan)).toEqual({ cpus: 1.5, memoryMiB: 1536, pids: 512, network: 'open', maxRunning: 1 })
    expect(effectiveLimits(DEV_ENV_DEFAULT_LIMITS, 'open', { ...plan, network: '' }).network).toBe('offline')
    expect(effectiveLimits(DEV_ENV_DEFAULT_LIMITS, 'open', null)).toMatchObject({ cpus: 1, memoryMiB: 2560, network: 'open', maxRunning: 2 })
    expect(sliceValues(plan)).toEqual({ MemoryMax: '1536M', CPUQuota: '150%', TasksMax: 2048 })
  })
})

describe('srt\'s write denies in a shared cwd (placeholders.ts)', () => {
  test('the absent names exist while a run in the cwd lives; the empty ones go when the last run ends', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-ph-'))
    fs.writeFileSync(path.join(d, '.bashrc'), 'mine\n')
    fs.mkdirSync(path.join(d, '.vscode'))
    const a = holdPlaceholders(d)
    for (const f of SRT_DENY_FILES) expect(fs.existsSync(path.join(d, f))).toBe(true)
    for (const f of SRT_DENY_DIRS) expect(fs.statSync(path.join(d, f)).isDirectory()).toBe(true)
    const b = holdPlaceholders(d)
    a(); a()
    // run b still lives: srt in b keeps its denies only while the mount points stay
    expect(fs.existsSync(path.join(d, '.mcp.json'))).toBe(true)
    fs.writeFileSync(path.join(d, '.gitconfig'), 'a person wrote this\n')
    b()
    expect(fs.readdirSync(d).sort()).toEqual(['.bashrc', '.gitconfig', '.vscode'])
    expect(fs.readFileSync(path.join(d, '.bashrc'), 'utf8')).toBe('mine\n')
    expect(_held().size).toBe(0)
    fs.rmSync(d, { recursive: true, force: true })
  })
  test('never through a link: a .claude link to a server folder gets no folders made in it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-ph-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-ph-out-'))
    fs.symlinkSync(outside, path.join(d, '.claude'))
    const rel = holdPlaceholders(d)
    expect(fs.readdirSync(outside)).toEqual([])
    rel()
    expect(fs.lstatSync(path.join(d, '.claude')).isSymbolicLink()).toBe(true)
    fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('the host names of this server', () => {
  test('from the public origins and the relay, with no env setting; loopback is not a team host', () => {
    const config = { publicOrigins: ['https://Acme.trina.app', 'http://127.0.0.1:3000'], relay: { url: 'wss://relay.trina.app/connect', teamName: 'acme' } }
    expect(teamHosts({ config } as never, {})).toEqual(['acme.trina.app', 'relay.trina.app'])
    expect(teamHosts({ config: { publicOrigins: [], relay: { url: null, teamName: null } } } as never, { MYCEL_DEV_ENV_DENY_HOSTS: 'a.example, b.example' })).toEqual(['a.example', 'b.example'])
    expect(extraDomainProblem('*.trina.app', teamHosts({ config } as never, {}))).toContain('this Trina server')
  })
  test('the cgroup path follows systemd\'s slice nesting, also for an id with a dash', () => {
    expect(slicePath('mycel-devenv.slice')).toBe('mycel.slice/mycel-devenv.slice')
    expect(slicePath('trina-ax-devenv.slice')).toBe('trina.slice/trina-ax.slice/trina-ax-devenv.slice')
    expect(cgroupDir('mycel', 'abc')).toBe('/sys/fs/cgroup/mycel.slice/mycel-devenv.slice/trina-dev-abc.scope')
  })
})

describe('the team\'s extra domains', () => {
  test('host names with two labels, or *. and one', () => {
    for (const d of ['api.example.net', '*.example.net', 'cdn.jsdelivr.net']) expect(extraDomainProblem(d)).toBeNull()
  })
  test('refused: IP addresses, *, public suffixes, uppercase, one label, this server', () => {
    expect(extraDomainProblem('1.2.3.4')).toContain('IP')
    expect(extraDomainProblem('*')).not.toBeNull()
    expect(extraDomainProblem('*.com')).toContain('public suffix')
    expect(extraDomainProblem('*.co.kr')).toContain('public suffix')
    expect(extraDomainProblem('Example.com')).toContain('lowercase')
    expect(extraDomainProblem('localhost')).not.toBeNull()
    expect(extraDomainProblem('a.*.example.com')).not.toBeNull()
    expect(extraDomainProblem('trina.app', ['team1.trina.app'])).toContain('this Trina server')
    expect(extraDomainProblem('team1.trina.app', ['team1.trina.app'])).toContain('this Trina server')
  })
})

// ---------------- the runner against a fake system ----------------

interface FakeRun { spec: SpawnSpec; settings: Record<string, unknown>; settingsMode: number; state: 'active' | 'gone' | 'failed'; result: string; resolve: (v: { code: number | null; signal: string | null }) => void; oom: number }
const runs = new Map<string, FakeRun>()
const stops: string[] = []
let selfTestProblem = ''
let cpu = 0
/** commands: "echo X", "exit N", "write <rel> <text>", "sleep" (runs until stopped or ended), "oom" (the kernel kills it) */
const fake: SrtSystem = {
  spawn(spec) {
    const settings = JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8'))
    const settingsMode = fs.statSync(spec.settingsFile).mode & 0o777
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    const r: FakeRun = { spec, settings, settingsMode, state: 'active', result: '', resolve, oom: 0 }
    runs.set(spec.runId, r)
    const c = spec.command
    const end = (code: number) => { fs.writeFileSync(spec.exitFile, `${code}\n`); r.state = 'gone'; resolve({ code, signal: null }) }
    queueMicrotask(() => {
      if (c === 'sleep') return
      if (c === 'oom') { r.oom = 1; r.state = 'failed'; r.result = 'oom-kill'; resolve({ code: null, signal: 'SIGKILL' }); return }
      let m = /^echo (.*)$/.exec(c)
      if (m) { fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); return end(0) }
      m = /^exit (\d+)$/.exec(c)
      if (m) return end(Number(m[1]))
      if (c === 'blocked') { fs.appendFileSync(spec.stderrFile, 'curl: (56) CONNECT tunnel failed, response 403\n'); return end(56) }
      m = /^write (\S+) (.*)$/.exec(c)
      if (m) { fs.writeFileSync(path.join(spec.cwd, m[1]!), m[2]!); return end(0) }
      fs.appendFileSync(spec.stderrFile, `unknown: ${c}\n`); end(127)
    })
    return { pid: 999_999, exited }
  },
  async stop(runId) { stops.push(runId); const r = runs.get(runId); if (r && r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId): Promise<UnitInfo> { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: r.state, result: r.result, memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state !== 'gone').map(([id]) => unitName(id)) },
  async forget(runId) { const r = runs.get(runId); if (r) r.state = 'gone' },
  oomKills(runId) { return runs.get(runId)?.oom ?? null },
  cpuUsec() { return cpu },
  procs() { return [] },
  async selfTest() { return selfTestProblem },
}
/** the fake run of a job or dev server ends with this code (the exit file run-wrap writes) */
const finish = (runId: string, code: number, log = '') => {
  const r = runs.get(runId)!
  if (log) fs.appendFileSync(r.spec.stdoutFile, log)
  fs.writeFileSync(r.spec.exitFile, `${code}\n`); r.state = 'gone'; r.resolve({ code, signal: null })
}

let h: Harness
let devBase = ''
let falconId = '', chatFalcon = '', chatPlain = '', chatPlain2 = '', chatErin = '', chatBob = ''
const FALCON = 'projects/falcon'
const STARTER: DevEnvPlan = { format: 1, plan: 'starter', maxRunning: 1, cpus: 1.5, memoryMiB: 1536, pids: 512, diskGiB: 4, network: 'open' }
const publish: { user: string; frame: { type: string; data: { code?: string; message?: string; link?: string } } }[] = []

type ProjectArg = { id: string; folderPath: string; name: string } | null
const falcon = (): ProjectArg => ({ id: falconId, folderPath: FALCON, name: 'Falcon' })
const shell = (userId: string, project: ProjectArg, chatId: string, signal = new AbortController().signal) =>
  boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal, confirm: async () => null, redact: (s) => s.replaceAll('hunter2', '[hidden]') })
const alice = (o: { project?: ProjectArg; chat?: string } = {}) => shell('alice', o.project === undefined ? falcon() : o.project, o.chat ?? chatFalcon)
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_runs ORDER BY started_at, id').all() as Record<string, unknown>[]
const runIdOfRow = (r: Record<string, unknown>) => String(r.unit).slice('trina-dev-'.length, -'.scope'.length)
type Settings = { filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] }; network: { allowedDomains: string[] } }
const lastSettings = () => [...runs.values()].at(-1)!.settings as unknown as Settings
const turnOnTeam = (patch: Partial<ReturnType<typeof teamSetting>> = {}) =>
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }), ...patch })

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  process.env.MYCEL_DEV_ENV_RUNNER = 'srt'
  process.env.MYCEL_TEST_SECRET_FOR_SRT = 'CANARY-ENV'
  h = await startHarness({ name: 'dev-env-srt' })
  devBase = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-base-'))
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
  falconId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: FALCON, instructions: '' })).id
  chatFalcon = (await h.api('alice').call(API.createChat, { body: { projectId: falconId } })).id
  chatPlain = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatPlain2 = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatErin = (await h.api('erin').call(API.createChat, { body: {} })).id
  chatBob = (await h.api('bob').call(API.createChat, { body: { projectId: falconId } })).id
  turnOnTeam()
  const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = ((user: string, frame: never) => { publish.push({ user, frame }); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
})
afterAll(async () => {
  setSrtSystem(null)
  for (const k of ['MYCEL_DEV_ENV', 'MYCEL_DEV_ENV_RUNNER', 'MYCEL_TEST_SECRET_FOR_SRT']) delete process.env[k]
  await h.close()
  fs.rmSync(devBase, { recursive: true, force: true })
})
beforeEach(() => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); stops.length = 0; publish.length = 0; selfTestProblem = ''; cpu = 0
  _active().clear()
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
  for (const t of ['dev_env_runs', 'dev_env_notices']) h.ctx.db.query(`DELETE FROM ${t}`).run()
  h.ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'dev_env.%'").run()
  turnOnTeam()
})

describe('the team setting', () => {
  test('srt asks for its own warning; a consent to the box warning does not count; off for everyone when off', () => {
    expect(requiredWarningVersion()).toBe(DEV_ENV_SRT_WARNING_VERSION)
    expect(requiredWarningVersion({})).toBe(DEV_ENV_WARNING_VERSION)
    const s = teamSetting(h.ctx.db)
    expect(teamInForce(s)).toBe(true)
    expect(teamInForce({ ...s, consent: { ...s.consent!, warningVersion: DEV_ENV_WARNING_VERSION } })).toBe(false)
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'alice')).toBe(true)
    turnOnTeam({ enabled: false })
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'alice')).toBe(false)
    turnOnTeam({ scope: { mode: 'selected', groupIds: ['finance'], userIds: [] } })
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'alice')).toBe(false)
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'bob')).toBe(true)
  })
  test('admins turn it on with the warning; a project setting is refused on srt', async () => {
    turnOnTeam({ enabled: false, consent: null })
    await expect(h.api('carol').call(API.updateDevEnvTeam, { body: { enabled: true } })).rejects.toThrow()
    await expect(h.api('alice').call(API.updateDevEnvTeam, { body: { enabled: true, acceptWarning: 2 } })).rejects.toThrow()
    const r = await h.api('carol').call(API.updateDevEnvTeam, { body: { enabled: true, acceptWarning: DEV_ENV_SRT_WARNING_VERSION } })
    expect(r.setting).toMatchObject({ enabled: true, consent: { warningVersion: DEV_ENV_SRT_WARNING_VERSION } })
    expect(r.runner).toBe('srt')
    await expect(h.api('carol').call(API.updateDevEnv, { params: { id: falconId }, body: { enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] } } })).rejects.toThrow()
    const page = await h.api('alice').call(API.devEnv, { params: { id: falconId } })
    expect(page).toMatchObject({ runner: 'srt', mayUse: true, box: null, setting: { enabled: true } })
  })
  test('availability says why srt cannot run', async () => {
    selfTestProblem = 'cannot start a scope (polkit rule or slice missing)'
    setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
    const r = await h.api('alice').call(API.devEnv, { params: { id: falconId } })
    expect(r.availability).toMatchObject({ available: false, reason: 'platform' })
    expect(r.availability.detail).toContain('polkit')
  })
  test('off: the tool says so and runs nothing', async () => {
    turnOnTeam({ enabled: false })
    const r = await alice().call({ command: 'echo x' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('off for you')
    expect(runs.size).toBe(0)
  })
})

describe('a command follows the person, not the project', () => {
  test('a project chat: starts in the project folder, with all of the person\'s folders and none of the others', async () => {
    const r = await alice().call({ command: 'echo hello' })
    expect(r.isError).toBeUndefined()
    expect(out(r)).toContain('Exit code 0.')
    expect(out(r)).toContain('hello')
    const run = [...runs.values()][0]!
    expect(run.spec.cwd).toBe(fs.realpathSync(path.join(h.team, FALCON)))
    expect(run.spec.limits).toEqual({ cpus: 1, memoryMiB: 1536, pids: 512, runtimeMaxSec: 150 })
    expect(run.settingsMode).toBe(0o600)
    const s = lastSettings()
    const t = (r: string) => path.join(h.team, r)
    // Q0 (b): only the project folder and her own folder are writable; her other writable folders are read-only
    expect(s.filesystem.allowWrite).toEqual([t(FALCON), t('users/alice'), personHome(devBase, 'alice')])
    expect(s.filesystem.allowRead).toEqual(expect.arrayContaining([t('skills'), t('shared'), t('groups/marketing')]))
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining([devBase, h.team, t('users'), t('.system'), t('groups/marketing/salaries')]))
    expect(s.filesystem.denyWrite).toEqual([t('projects/falcon/public')])
    for (const p of [...s.filesystem.allowRead, ...s.filesystem.allowWrite]) for (const no of ['groups/finance', 'projects/atlas', 'users/bob']) expect(p.startsWith(t(no))).toBe(false)
    // the output goes to the person's logs, and the files are gone after the run
    expect(run.spec.stdoutFile.startsWith(personLogs(devBase, 'alice') + '/')).toBe(true)
    for (const f of [run.spec.settingsFile, run.spec.stdoutFile, run.spec.exitFile]) expect(fs.existsSync(f)).toBe(false)
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.command' AND target = ?").get(falconId) as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ runner: 'srt', folder: 'project', chatId: chatFalcon, result: { code: 0, signal: '' } })
  })
  test('a chat with no project: starts in the chat\'s work folder, which is writable; the person\'s folders are there too', async () => {
    const r = await alice({ project: null, chat: chatPlain }).call({ command: 'write out.txt done' })
    expect(out(r)).toContain('Exit code 0.')
    const run = [...runs.values()][0]!
    const work = chatWork(devBase, chatPlain)
    expect(run.spec.cwd).toBe(fs.realpathSync(work))
    expect(fs.readFileSync(path.join(work, 'out.txt'), 'utf8')).toBe('done')
    expect(run.spec.env.TRINA_WORK).toBe(work)
    expect(lastSettings().filesystem.allowWrite).toEqual([path.join(h.team, 'users/alice'), personHome(devBase, 'alice'), work])
    expect(lastSettings().filesystem.allowRead).toEqual(expect.arrayContaining([path.join(h.team, 'shared'), path.join(h.team, FALCON)]))
    // nothing is recorded as a team file change: the work folder is not a team folder
    expect(out(r)).not.toContain('Files changed')
    const audit = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'dev_env.command'").get() as { target: string | null; detail: string }
    expect(audit.target).toBeNull()
    expect(JSON.parse(audit.detail)).toMatchObject({ folder: 'work', chatId: chatPlain })
    // another chat has its own work folder
    await alice({ project: null, chat: chatPlain2 }).call({ command: 'echo x' })
    expect([...runs.values()].at(-1)!.spec.cwd).toBe(fs.realpathSync(chatWork(devBase, chatPlain2)))
  })
  test('read-only where the person reads only: bob in the falcon chat', async () => {
    await shell('bob', falcon(), chatBob).call({ command: 'echo x' })
    const s = lastSettings()
    expect([...runs.values()][0]!.spec.cwd).toBe(fs.realpathSync(path.join(h.team, FALCON)))
    expect(s.filesystem.allowRead).toContain(path.join(h.team, FALCON))
    expect(s.filesystem.allowWrite).not.toContain(path.join(h.team, FALCON))
    // groups/finance is writable for bob, but not his starting folder: read-only in this run
    expect(s.filesystem.allowWrite).not.toContain(path.join(h.team, 'groups/finance'))
    expect(s.filesystem.allowRead).toContain(path.join(h.team, 'groups/finance'))
    expect([...runs.values()][0]!.spec.env.HOME).toBe(personHome(devBase, 'bob'))
  })
  test('a project folder the person cannot open: the run starts in the chat\'s work folder and the folder stays hidden', async () => {
    await shell('erin', falcon(), chatErin).call({ command: 'echo x' })
    expect([...runs.values()][0]!.spec.cwd).toBe(fs.realpathSync(chatWork(devBase, chatErin)))
    const s = lastSettings()
    expect([...s.filesystem.allowRead, ...s.filesystem.allowWrite].some((p) => p.startsWith(path.join(h.team, FALCON) + '/') && !p.endsWith('/public'))).toBe(false)
    expect(s.filesystem.allowRead).toContain(path.join(h.team, 'projects/falcon/public'))
  })
  test('the rules are read again for every command', async () => {
    await alice().call({ command: 'echo 1' })
    expect(lastSettings().filesystem.allowRead).toContain(path.join(h.team, 'groups/marketing'))
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'alice'").run()
    try {
      await alice().call({ command: 'echo 2' })
      const s = lastSettings()
      expect([...s.filesystem.allowRead, ...s.filesystem.allowWrite]).not.toContain(path.join(h.team, 'groups/marketing'))
    } finally { h.ctx.db.query("INSERT INTO group_members VALUES ('marketing','alice')").run() }
  })
  test('the environment is the listed keys only: nothing from the server\'s environment', async () => {
    await alice().call({ command: 'echo x' })
    const env = [...runs.values()][0]!.spec.env
    expect(env).toEqual(runEnv({ base: devBase, userId: 'alice', teamRoot: h.team, work: null }))
    expect(JSON.stringify(env)).not.toContain('CANARY-ENV')
    expect(Object.keys(env).some((k) => k.startsWith('MYCEL'))).toBe(false)
  })
  test('a cwd in the project; changed files come back', async () => {
    fs.mkdirSync(path.join(h.team, FALCON, 'src'), { recursive: true })
    const r = await alice().call({ command: 'write a.txt hi', cwd: 'src' })
    expect(out(r)).toContain('created')
    expect(out(r)).toContain('src/a.txt')
  })
  test('a cwd through a link out of the folder is refused before the run (A10)', async () => {
    const link = path.join(h.team, FALCON, 'out')
    fs.rmSync(link, { force: true })
    fs.symlinkSync(devBase, link)
    try {
      const r = await alice().call({ command: 'echo x', cwd: 'out' })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('cwd must be a folder inside')
      expect(runs.size).toBe(0)
    } finally { fs.rmSync(link, { force: true }) }
  })
  test('a failing command; the time limit; out of memory; a stop of the turn', async () => {
    expect(out(await alice().call({ command: 'exit 3' }))).toContain('Exit code 3.')
    expect(out(await alice().call({ command: 'sleep', timeout_sec: 1 }))).toContain('Stopped: the time limit (1 s) was reached.')
    expect(out(await alice().call({ command: 'oom' }))).toContain('ran out of memory')
    const ac = new AbortController()
    const p = shell('alice', falcon(), chatFalcon, ac.signal).call({ command: 'sleep' })
    await Bun.sleep(50)
    ac.abort()
    expect(out(await p)).toContain('Stopped.')
  })
  test('one command at a time per folder; past maxRunning on the server a command waits in the queue (queue.ts)', async () => {
    const a = alice().call({ command: 'sleep', timeout_sec: 1 })
    const b = alice().call({ command: 'echo second', timeout_sec: 5 })
    await Bun.sleep(100)
    expect(runs.size).toBe(1) // b waits for a slot (Starter: maxRunning 1, for the whole team)
    const d = shell('bob', null, chatBob).call({ command: 'echo third' })
    await Bun.sleep(100)
    expect(runs.size).toBe(1)
    expect(out(await a)).toContain('Stopped: the time limit')
    // bob has had no slot yet: he goes before alice's second command (turn-taking with one slot)
    expect(out(await d)).toContain('third')
    expect(out(await b)).toContain('second')
    expect(runs.size).toBe(3)
  })
})

describe('jobs and the queue (per team)', () => {
  test('a job starts at once when a slot is free; the row is the person\'s and the chat\'s', async () => {
    const r = await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'render' })
    expect(out(r)).toContain('Started as job render (log: $TRINA_LOGS/render.log)')
    expect(rows()).toMatchObject([{ name: 'render', state: 'running', kind: 'job', ended_at: null, command: 'sleep', user_id: 'alice', chat_id: chatPlain, project_id: null, root: chatWork(devBase, chatPlain) }])
    expect(String(rows()[0]!.unit)).toMatch(UNIT_RE)
    expect(String(rows()[0]!.access)).toMatch(/^[0-9a-f]{32}$/)
    expect([...runs.values()][0]!.spec.limits.runtimeMaxSec).toBe(6 * 3600)
    expect([...runs.values()][0]!.spec.stdoutFile).toBe(path.join(personLogs(devBase, 'alice'), 'render.log'))
  })
  test('over maxRunning a job waits (FIFO, across people and chats) and starts when the slot is free', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'one' })
    const r2 = await shell('bob', falcon(), chatBob).call({ command: 'echo two', job: true, log_name: 'two' })
    expect(out(r2)).toContain('Queued as job two')
    expect(out(r2)).toContain('position 1')
    const r3 = await alice({ project: null, chat: chatPlain }).call({ command: 'echo three hunter2', job: true, log_name: 'three' })
    expect(out(r3)).toContain('position 2')
    expect(rows().map((r) => [r.name, r.state])).toEqual([['one', 'running'], ['two', 'waiting'], ['three', 'waiting']])
    // the row keeps the command with secrets hidden; the real one waits in a file the sandbox cannot read
    expect(rows()[2]!.command).toBe('echo three [hidden]')
    const page = await h.api('alice').call(API.devEnv, { params: { id: falconId } })
    expect(page.runs.running.map((x) => x.name)).toEqual(['one'])
    expect(page.runs.waiting).toMatchObject([{ name: 'two', position: 1, runAt: null }])
    const mine = await h.api('alice').call(API.myDevEnvRuns, {})
    expect(mine.waiting).toMatchObject([{ name: 'three', position: 2, chatId: chatPlain, projectId: null }])
    finish(runIdOfRow(rows()[0]!), 0, 'frame=100\ndone\n')
    await pollSrt(h.ctx)
    expect(rows().map((r) => [r.name, r.state, r.end_reason])).toEqual([['one', 'ended', 'exit'], ['two', 'running', ''], ['three', 'waiting', '']])
    expect(rows()[0]!.exit_code).toBe(0)
    expect(publish.filter((p) => p.frame.data.code === 'dev_env_job')).toMatchObject([{ user: 'alice', frame: { data: { link: `/c/${chatFalcon}` } } }])
    expect(runs.get(runIdOfRow(rows()[1]!))!.spec.command).toBe('echo two')
    expect(runs.get(runIdOfRow(rows()[1]!))!.spec.env.HOME).toBe(personHome(devBase, 'bob'))
    finish(runIdOfRow(rows()[1]!), 0)
    await pollSrt(h.ctx)
    expect(runs.get(runIdOfRow(rows()[2]!))!.spec.command).toBe('echo three hunter2')
    // the result goes to the AI of the chat that started the job, once, and to nobody else
    expect(runResultsForAI(h.ctx, 'bob', chatBob).join('\n')).not.toContain('Job one')
    expect(runResultsForAI(h.ctx, 'alice', chatPlain).join('\n')).not.toContain('Job one')
    const told = runResultsForAI(h.ctx, 'alice', chatFalcon).join('\n')
    expect(told).toContain('Job one ended with exit code 0.')
    expect(told).toContain('done')
    expect(runResultsForAI(h.ctx, 'alice', chatFalcon)).toEqual([])
  })
  test('srt\'s mount points stay while a job runs in the folder, and go when it ends (not left by a killed run)', async () => {
    setSrtSystem(fake, { base: devBase, id: 'mycel', plan: { ...STARTER, maxRunning: 2 } }) // a slot for the command too
    const dir = fs.realpathSync(path.join(h.team, FALCON))
    await alice().call({ command: 'sleep', job: true, log_name: 'ph' })
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true)
    expect(out(await alice().call({ command: 'echo during' }))).toContain('during')
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true)
    const r = runs.get(runIdOfRow(rows()[0]!))!
    r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' })
    await Bun.sleep(10)
    for (const f of ['.mcp.json', '.bashrc', '.vscode', '.claude']) expect(fs.existsSync(path.join(dir, f))).toBe(false)
  })
  test('at most 3 waiting jobs per person', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'run' })
    for (const n of ['w1', 'w2', 'w3']) expect(out(await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: n }))).toContain('Queued')
    const r = await alice().call({ command: 'sleep', job: true, log_name: 'w4' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('queue full')
    expect(out(await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'b1' }))).toContain('Queued')
  })
  test('a log name is per person', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'same' })
    expect(out(await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'same' }))).toContain('still runs for this person')
    expect(out(await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'same' }))).toContain('Queued')
  })
  test('a waiting job ends "expired" after 24 hours', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'run' })
    await alice().call({ command: 'sleep', job: true, log_name: 'late' })
    h.ctx.db.query("UPDATE dev_env_runs SET started_at = ? WHERE name = 'late'").run(new Date(Date.now() - WAIT_MAX_MS - 1000).toISOString())
    await pollSrt(h.ctx)
    expect(rows().find((r) => r.name === 'late')).toMatchObject({ state: 'ended', end_reason: 'expired' })
  })
  test('before a waiting job starts, the access is checked again', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'run' })
    await shell('bob', null, chatBob).call({ command: 'echo x', job: true, log_name: 'next' })
    turnOnTeam({ scope: { mode: 'selected', groupIds: ['marketing'], userIds: [] } })
    finish(runIdOfRow(rows()[0]!), 0)
    await pollSrt(h.ctx)
    expect(rows().find((r) => r.name === 'next')).toMatchObject({ state: 'ended', end_reason: 'setting' })
  })
  test('a running job stops when the person\'s folder access changes, or the person is out of scope', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'long' })
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'running' })
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'alice'").run()
    try {
      await pollSrt(h.ctx)
      expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'setting' })
      expect(stops).toHaveLength(1)
    } finally { h.ctx.db.query("INSERT INTO group_members VALUES ('marketing','alice')").run() }
    await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'b' })
    turnOnTeam({ scope: { mode: 'selected', groupIds: ['marketing'], userIds: [] } })
    await pollSrt(h.ctx)
    expect(rows().find((r) => r.name === 'b')).toMatchObject({ state: 'ended', end_reason: 'setting' })
  })
  test('a job killed for memory ends "oom" with a notice; a scope that is gone with no exit file ends "lost"', async () => {
    await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'big' })
    // the tracker builds the same access as the start (the work folder as the starting folder): it keeps running
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'running' })
    const r = runs.get(runIdOfRow(rows()[0]!))!
    r.state = 'failed'; r.result = 'oom-kill'; r.resolve({ code: null, signal: 'SIGKILL' })
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'oom', exit_code: null })
    expect(publish.find((p) => p.frame.data.code === 'dev_env_job')!.frame.data.message).toContain('ran out of memory')
    // the inbox has the job of a chat with no project, with a link to the chat
    const inbox = (await h.api('alice').call(API.listNotifications, { query: {} })).items.find((i) => i.devEnv?.job?.name === 'big')
    expect(inbox).toMatchObject({ link: 'chat', chatId: chatPlain, devEnv: { projectId: '', job: { exitCode: null, reason: 'oom' } } })
    await alice().call({ command: 'sleep', job: true, log_name: 'gone' })
    runs.get(runIdOfRow(rows()[1]!))!.state = 'gone'
    await pollSrt(h.ctx)
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'lost' })
  })
  test('a person stops their own run; others cannot, except on the project page with access, and admins', async () => {
    await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'run' })
    await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'wait' })
    const [run, wait] = rows()
    await expect(h.api('bob').call(API.stopMyDevEnvRun, { params: { runId: String(wait!.id) } })).rejects.toThrow()
    await h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: String(wait!.id) } })
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'stopped' })
    // a run of a chat with no project is not on any project page
    await expect(h.api('carol').call(API.devEnvRunStop, { params: { id: falconId, runId: String(run!.id) } })).rejects.toThrow()
    const mine = await h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: String(run!.id) } })
    expect(stops).toContain(runIdOfRow(run!))
    expect(mine).toEqual({ running: [], waiting: [] })
    await alice().call({ command: 'sleep', job: true, log_name: 'proj' })
    const page = await h.api('carol').call(API.devEnvRunStop, { params: { id: falconId, runId: String(rows()[2]!.id) } })
    expect(page.runs).toEqual({ running: [], waiting: [] })
  })
})

describe('dev servers', () => {
  test('one per chat, at most maxRunning on the server, no queue; no notice when it ends', async () => {
    const r = await alice().call({ command: 'sleep', background: true, log_name: 'web' })
    expect(out(r)).toContain('Started in the background')
    expect(rows()).toMatchObject([{ name: 'web', kind: 'server', state: 'running' }])
    expect([...runs.values()][0]!.spec.limits.runtimeMaxSec).toBe(8 * 3600)
    expect(out(await alice().call({ command: 'sleep', background: true, log_name: 'web2' }))).toContain('a dev server runs in this chat already (web)')
    expect(out(await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', background: true }))).toContain('the most it allows')
    finish(runIdOfRow(rows()[0]!), 1)
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'ended' })
    expect(publish.filter((p) => p.frame.data.code === 'dev_env_job')).toHaveLength(0)
    expect(runResultsForAI(h.ctx, 'alice', chatFalcon)).toEqual([])
  })
  test('a change of the team network stops every run; the next run gets the new network', async () => {
    await alice().call({ command: 'sleep', background: true, log_name: 'web' })
    await h.api('carol').call(API.updateDevEnvTeam, { body: { network: 'offline' } })
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'setting' })
    expect(stops).toHaveLength(1)
    await alice().call({ command: 'echo x' })
    expect(lastSettings().network.allowedDomains).toEqual([])
  })
  test('preview is not available on srt yet', async () => {
    await expect(h.api('alice').call(API.devEnvPreview, { params: { id: falconId }, body: { port: 3000 } })).rejects.toThrow()
  })
})

describe('the tracker', () => {
  test('after a restart a unit with no row is stopped', async () => {
    const { reconcile } = await import('../../server/src/devenv/srt/runner')
    await alice().call({ command: 'sleep', job: true, log_name: 'kept' })
    const orphan = newRunId()
    fake.spawn({ runId: orphan, id: 'mycel', cwd: '/', env: {}, limits: { cpus: 1, memoryMiB: 256, pids: 64, runtimeMaxSec: 10 }, exitFile: path.join(devBase, 'o.exit'), settingsFile: writeTmp('{}'), command: 'sleep', stdoutFile: path.join(devBase, 'o.out'), stderrFile: path.join(devBase, 'o.err') })
    await reconcile(h.ctx)
    expect(stops).toEqual([orphan])
  })
  test('under the disk floor every run stops with "disk" and its person hears why', async () => {
    await alice({ project: null, chat: chatPlain }).call({ command: 'sleep', job: true, log_name: 'big' })
    configureStorageGuard({ root: h.team, statfs: () => ({ bsize: 4096, blocks: 1_000_000, bfree: 10, bavail: 10 }), enforce: () => true })
    try { await pollSrt(h.ctx) } finally { configureStorageGuard(null) }
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'disk' })
    expect(publish.some((p) => p.user === 'alice' && p.frame.data.code === 'dev_env_box_stopped' && String(p.frame.data.message).includes('nearly full'))).toBe(true)
  })
  test('a purged chat\'s work folder goes', async () => {
    const { forgetChatWork } = await import('../../server/src/devenv/srt/runner')
    await alice({ project: null, chat: chatPlain2 }).call({ command: 'write x.txt y' })
    expect(fs.existsSync(chatWork(devBase, chatPlain2))).toBe(true)
    forgetChatWork(chatPlain2)
    expect(fs.existsSync(chatWork(devBase, chatPlain2))).toBe(false)
  })
})

describe('the team\'s sites (admins)', () => {
  test('read and change; bad domains refused; the next run gets them', async () => {
    const r = await h.api('carol').call(API.devEnvTeam, {})
    expect(r).toMatchObject({ runner: 'srt', setting: { extraDomains: [] }, plan: { plan: 'starter', maxRunning: 1 } })
    expect(r.defaultDomains).toContain('registry.npmjs.org')
    await expect(h.api('carol').call(API.updateDevEnvTeam, { body: { extraDomains: ['*.com'] } })).rejects.toThrow()
    await expect(h.api('alice').call(API.updateDevEnvTeam, { body: { extraDomains: ['api.example.net'] } })).rejects.toThrow()
    await h.api('carol').call(API.updateDevEnvTeam, { body: { extraDomains: ['api.example.net', 'API.example.net'] } })
    expect(teamSetting(h.ctx.db)).toMatchObject({ enabled: true, extraDomains: ['api.example.net'] })
    await alice().call({ command: 'echo x' })
    expect(lastSettings().network.allowedDomains).toContain('api.example.net')
  })
})

describe('sites a person allows (no admin step)', () => {
  type Answer = 'once' | 'always' | 'deny' | null
  /** box_shell with a site card that answers `answer` and records what it was asked */
  const asking = (userId: string, project: ProjectArg, chatId: string, answer: Answer) => {
    const asked: { host: string; command: string }[] = []
    const tool = boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal: new AbortController().signal, confirm: async () => null, redact: (x) => x,
      askSite: async (host, command) => { asked.push({ host, command }); return answer } })
    return { tool, asked }
  }
  type Net = { allowedDomains: string[]; deniedDomains: string[]; deniedResolvedAddresses: string[]; strictAllowlist: boolean }
  const net = () => (lastSettings() as unknown as { network: Net }).network
  const audits = (action: string) => (h.ctx.db.query('SELECT actor_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string; detail: string }[]).map((a) => ({ actor: a.actor_id, ...JSON.parse(a.detail) }))
  beforeAll(() => { process.env.MYCEL_DEV_ENV_DENY_HOSTS = 'team.trina.test' })
  afterAll(() => { delete process.env.MYCEL_DEV_ENV_DENY_HOSTS })
  beforeEach(() => { for (const t of ['dev_env_site_grants', 'dev_env_user_net']) h.ctx.db.query(`DELETE FROM ${t}`).run() })

  test('"Allow once": the command runs with the site, for this turn only; nothing is kept', async () => {
    const a = asking('alice', falcon(), chatFalcon, 'once')
    const r = await a.tool.call({ command: 'echo hi', request_sites: ['https://API.Example.com/v1?x=1'] })
    expect(out(r)).toContain('Exit code 0.')
    expect(out(r)).toContain('allowed api.example.com for this answer')
    expect(a.asked).toEqual([{ host: 'api.example.com', command: 'echo hi' }])
    expect(net().allowedDomains).toContain('api.example.com')
    // the same turn: no second card, still allowed
    await a.tool.call({ command: 'echo again', request_sites: ['api.example.com'] })
    expect(a.asked).toHaveLength(1)
    expect(net().allowedDomains).toContain('api.example.com')
    // a new turn (a new tool): not allowed any more, and nothing went on her list
    await alice().call({ command: 'echo x' })
    expect(net().allowedDomains).not.toContain('api.example.com')
    expect(userSites(h.ctx.db, 'alice')).toEqual([])
    expect(audits('dev_env.site_allowed')).toMatchObject([{ actor: 'alice', host: 'api.example.com', scope: 'once' }])
  })
  test('"Always allow": the site goes on HER list; her later runs get it, another person\'s runs do not', async () => {
    const a = asking('alice', null, chatPlain, 'always')
    expect(out(await a.tool.call({ command: 'echo hi', request_sites: ['api.example.com'] }))).toContain('Exit code 0.')
    expect(userSites(h.ctx.db, 'alice').map((x) => x.host)).toEqual(['api.example.com'])
    await alice({ project: null, chat: chatPlain }).call({ command: 'echo later' })
    expect(net().allowedDomains).toContain('api.example.com')
    // user B: the host is not open for her, and her card would be asked again
    await shell('bob', null, chatBob).call({ command: 'echo bob' })
    expect(net().allowedDomains).not.toContain('api.example.com')
    expect(net().strictAllowlist).toBe(true)
    const b = asking('bob', null, chatBob, 'deny')
    await b.tool.call({ command: 'echo bob', request_sites: ['api.example.com'] })
    expect(b.asked).toHaveLength(1)
    // a site that is allowed already (her list, the default list, the team list) needs no card
    const again = asking('alice', null, chatPlain, 'deny')
    expect(out(await again.tool.call({ command: 'echo x', request_sites: ['api.example.com', 'registry.npmjs.org'] }))).toContain('Exit code 0.')
    expect(again.asked).toEqual([])
  })
  test('"Don\'t allow", no answer, a scheduled run: the command does not run', async () => {
    for (const answer of ['deny', null] as Answer[]) {
      const a = asking('alice', falcon(), chatFalcon, answer)
      const r = await a.tool.call({ command: 'echo hi', request_sites: ['api.example.com'] })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('did not allow api.example.com, so the command did not run')
    }
    // no card at all (a host with no askSite, as a turn that cannot ask): the same
    expect(out(await alice().call({ command: 'echo hi', request_sites: ['api.example.com'] }))).toContain('did not allow')
    expect(runs.size).toBe(0)
    expect(userSites(h.ctx.db, 'alice')).toEqual([])
    expect(audits('dev_env.site_denied').map((x) => x.answer)).toEqual(['deny', 'none', 'none'])
  })
  test('addresses, local and metadata names and the team server are refused with no card', async () => {
    for (const bad of ['169.254.169.254', 'http://10.0.0.5:8080/', '127.0.0.1', '0x7f.1', '[::1]', 'localhost', 'x.localhost', 'metadata.google.internal', 'printer.local', 'team.trina.test', 'trina.test', '*.com', '*']) {
      const a = asking('alice', falcon(), chatFalcon, 'always')
      const r = await a.tool.call({ command: 'echo hi', request_sites: [bad] })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('cannot be allowed')
      expect(a.asked).toEqual([])
    }
    expect(runs.size).toBe(0)
    expect(userSites(h.ctx.db, 'alice')).toEqual([])
  })
  test('the AI asks for one exact host: a "*." pattern gets no card', async () => {
    for (const bad of ['*.example.com', '*.s3.amazonaws.com', 'https://*.example.com/']) {
      const a = asking('alice', falcon(), chatFalcon, 'always')
      const r = await a.tool.call({ command: 'echo hi', request_sites: [bad] })
      expect(out(r)).toContain('not a pattern')
      expect(a.asked).toEqual([])
    }
    expect(userSites(h.ctx.db, 'alice')).toEqual([])
  })
  test('a host the person did not allow in this turn gets no second card', async () => {
    const a = asking('alice', falcon(), chatFalcon, 'deny')
    expect(out(await a.tool.call({ command: 'echo hi', request_sites: ['api.example.com'] }))).toContain('did not allow')
    // a web page or a file tells the AI to try again: no card, the command does not run
    const r = await a.tool.call({ command: 'echo again', request_sites: ['API.example.com.'] })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('did not allow api.example.com in this answer')
    expect(a.asked).toHaveLength(1)
    expect(runs.size).toBe(0)
    // another host still gets its card
    await a.tool.call({ command: 'echo x', request_sites: ['other.example.com'] })
    expect(a.asked.map((x) => x.host)).toEqual(['api.example.com', 'other.example.com'])
  })
  test('nobody to ask (a scheduled run): no card, the AI is told why; her "always" sites still work', async () => {
    const asked: string[] = []
    const tool = boxShellTool({ ctx: h.ctx, project: falcon(), userId: 'alice', turnId: 'turn-s', chatId: chatFalcon, signal: new AbortController().signal, confirm: async () => null, redact: (x) => x,
      unattended: true, askSite: async (host) => { asked.push(host); return 'always' } })
    const r = await tool.call({ command: 'echo hi', request_sites: ['api.example.com'] })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('Nobody can answer a site card in this run')
    expect(asked).toEqual([])
    grantUserSite(h.ctx.db, 'alice', 'api.example.com')
    expect(out(await tool.call({ command: 'echo hi', request_sites: ['api.example.com'] }))).toContain('Exit code 0.')
    expect(asked).toEqual([])
  })
  test('the team\'s No network wins: no card, nothing allowed, and her sites and Full internet do not reach the run', async () => {
    grantUserSite(h.ctx.db, 'alice', 'api.example.com')
    setFullInternet(h.ctx.db, 'alice', true)
    turnOnTeam({ network: 'offline' })
    const a = asking('alice', falcon(), chatFalcon, 'always')
    const r = await a.tool.call({ command: 'echo hi', request_sites: ['other.example.com'] })
    expect(out(r)).toContain('No network')
    expect(a.asked).toEqual([])
    expect(runs.size).toBe(0)
    await alice().call({ command: 'echo x' })
    expect(net().allowedDomains).toEqual([])
    expect(net().strictAllowlist).toBe(true)
    expect([...runs.values()].at(-1)!.spec.full).toBeFalsy()
    // the plan's offline wins too
    turnOnTeam()
    setSrtSystem(fake, { base: devBase, id: 'mycel', plan: { ...STARTER, network: 'offline' } })
    await alice().call({ command: 'echo x' })
    expect(net().allowedDomains).toEqual([])
    expect(net().strictAllowlist).toBe(true)
    const s = await h.api('alice').call(API.myDevEnvSites, {})
    expect(s).toMatchObject({ state: 'no_network', sites: [], fullInternet: false })
  })
  test('Full internet: her runs only; the deny lists stay; a blocked connection says what is never allowed', async () => {
    setFullInternet(h.ctx.db, 'alice', true)
    await alice().call({ command: 'echo x' })
    expect(net().strictAllowlist).toBe(false)
    expect([...runs.values()].at(-1)!.spec.full).toBe(true)
    expect(net().deniedResolvedAddresses).toEqual(expect.arrayContaining(['169.254.0.0/16', '10.0.0.0/8', '127.0.0.0/8', 'fc00::/7']))
    expect(net().deniedDomains).toEqual(expect.arrayContaining(['team.trina.test', 'metadata.google.internal']))
    await shell('bob', null, chatBob).call({ command: 'echo bob' })
    expect(net().strictAllowlist).toBe(true)
    expect([...runs.values()].at(-1)!.spec.full).toBeFalsy()
    expect(out(await alice().call({ command: 'blocked' }))).toContain('With Full internet only the team server')
    setFullInternet(h.ctx.db, 'alice', false)
    expect(out(await alice().call({ command: 'blocked' }))).toContain('request_sites set to the host name')
  })
  test('a job keeps its once-allowed site when it waits; removing a site she allowed stops her job that started with it', async () => {
    grantUserSite(h.ctx.db, 'alice', 'kept.example.com')
    await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'first' })
    const a = asking('alice', null, chatPlain, 'once')
    expect(out(await a.tool.call({ command: 'sleep', job: true, log_name: 'later', request_sites: ['once.example.com'] }))).toContain('Queued as job later')
    expect(rows()[1]).toMatchObject({ name: 'later', state: 'waiting', once_domains: 'once.example.com' })
    finish(runIdOfRow(rows()[0]!), 0)
    await pollSrt(h.ctx)
    expect(rows()[1]).toMatchObject({ state: 'running' })
    expect(net().allowedDomains).toEqual(expect.arrayContaining(['once.example.com', 'kept.example.com']))
    // a new site does not stop it
    grantUserSite(h.ctx.db, 'alice', 'new.example.com')
    await pollSrt(h.ctx)
    expect(rows()[1]).toMatchObject({ state: 'running' })
    // removing one it started with does (her own route, at once)
    const s = await h.api('alice').call(API.removeMyDevEnvSite, { body: { host: 'kept.example.com' } })
    expect(s.sites.map((x) => x.host)).toEqual(['new.example.com'])
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'setting' })
    expect(audits('dev_env.site_removed')).toMatchObject([{ actor: 'alice', host: 'kept.example.com' }])
  })
  test('turning Full internet off stops her dev server that started with it; bob\'s run goes on', async () => {
    setFullInternet(h.ctx.db, 'alice', true)
    await alice().call({ command: 'sleep', background: true, log_name: 'web' })
    expect([...runs.values()].at(-1)!.spec.full).toBe(true)
    await h.api('alice').call(API.setMyDevEnvFullInternet, { body: { on: false } })
    expect(rows()[0]).toMatchObject({ name: 'web', state: 'ended', end_reason: 'setting' })
    expect(fullInternet(h.ctx.db, 'alice')).toBe(false)
  })
  test('her settings: list, remove, Full internet with the warning; nobody else sees or changes them', async () => {
    grantUserSite(h.ctx.db, 'alice', 'api.example.com')
    const mine = await h.api('alice').call(API.myDevEnvSites, {})
    expect(mine).toMatchObject({ state: 'on', fullInternet: false, fullAvailable: true, fullWarningVersion: 1, sites: [{ host: 'api.example.com' }] })
    expect(mine.teamSites).toContain('registry.npmjs.org')
    expect((await h.api('bob').call(API.myDevEnvSites, {})).sites).toEqual([])
    // bob cannot remove her site: he has none of that name
    await expect(h.api('bob').call(API.removeMyDevEnvSite, { body: { host: 'api.example.com' } })).rejects.toThrow()
    expect(userSites(h.ctx.db, 'alice')).toHaveLength(1)
    // on needs the warning; off does not
    await expect(h.api('alice').call(API.setMyDevEnvFullInternet, { body: { on: true } })).rejects.toThrow()
    expect((await h.api('alice').call(API.setMyDevEnvFullInternet, { body: { on: true, acceptWarning: 1 } })).fullInternet).toBe(true)
    expect(fullInternet(h.ctx.db, 'bob')).toBe(false)
    expect((await h.api('alice').call(API.setMyDevEnvFullInternet, { body: { on: false } })).fullInternet).toBe(false)
    expect(audits('dev_env.full_on').map((x) => x.actor)).toEqual(['alice'])
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dev_env.full_off'").get()).toEqual({ n: 1 })
    // off for this person: nothing to show
    turnOnTeam({ scope: { mode: 'selected', groupIds: ['finance'], userIds: [] } })
    expect((await h.api('alice').call(API.myDevEnvSites, {})).state).toBe('off')
  })
  test('the card in a real turn: only the person who owns the turn can answer it, and then the command runs', async () => {
    const fakeTool = (d: unknown) => '@fake ' + JSON.stringify(d)
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatPlain }, body: { content: fakeTool({ tool: 'box_shell', args: { command: 'echo reached', request_sites: ['api.example.com'] }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const until = async <T,>(f: () => Promise<T | null | undefined>, what: string): Promise<T> => {
      for (let i = 0; i < 400; i++) { const v = await f(); if (v) return v; await Bun.sleep(50) }
      throw new Error(`timed out waiting for ${what}`)
    }
    const card = await until(async () => (await h.api('alice').call(API.listTurnRequests, { params: { id: chatPlain } })).items.find((x) => x.turnId === r.turnId), 'the site card')
    expect(card.request).toMatchObject({ kind: 'dev_env_site', host: 'api.example.com', command: 'echo reached' })
    const body = JSON.stringify({ kind: 'dev_env_site', requestId: card.request.requestId, decision: 'always' })
    // another person: not found (the turn is not hers), and the card stays open; she does not see it in her chats
    const other = await h.req('bob', `/api/turns/${r.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(other.status).toBe(404)
    expect(userSites(h.ctx.db, 'bob')).toEqual([])
    await expect(h.api('bob').call(API.listTurnRequests, { params: { id: chatPlain } })).rejects.toThrow()
    // a decision that is not one of the card's: refused
    const bad = await h.req('alice', `/api/turns/${r.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dev_env_site', requestId: card.request.requestId, decision: 'yes' }) })
    expect(bad.status).toBe(400)
    expect((await h.api('alice').call(API.listTurnRequests, { params: { id: chatPlain } })).items).toHaveLength(1)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'dev_env_site', requestId: card.request.requestId, decision: 'always' } })
    const done = await until(async () => (await h.api('alice').call(API.listMessages, { params: { id: chatPlain }, query: {} })).items.find((m) => m.id === r.assistantMessage.id && m.status !== 'streaming'), 'the answer')
    expect(done.content).toContain('reached')
    expect(userSites(h.ctx.db, 'alice').map((x) => x.host)).toEqual(['api.example.com'])
    expect(net().allowedDomains).toContain('api.example.com')
  })
})

function writeTmp(t: string) { const f = path.join(devBase, `t-${newRunId()}.json`); fs.writeFileSync(f, t); return f }

describe('starts that meet (one start at a time)', () => {
  /** the fake's spawn waits for this gate: the start is slow, as with systemctl or the IMDS call */
  let open!: () => void
  const gated = () => {
    const gate = new Promise<void>((r) => { open = r })
    setSrtSystem({ ...fake, spawn: (spec: SpawnSpec) => gate.then(() => fake.spawn(spec)) } as unknown as SrtSystem, { base: devBase, id: 'mycel', plan: STARTER })
  }
  test('two polls at the same time start a waiting job once, and never end it "lost"', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'one' })
    await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'two' })
    finish(runIdOfRow(rows()[0]!), 0)
    gated()
    const p1 = pollSrt(h.ctx), p2 = pollSrt(h.ctx)
    await Bun.sleep(20)
    open()
    await Promise.all([p1, p2])
    expect(rows().map((r) => [r.name, r.state, r.end_reason])).toEqual([['one', 'ended', 'exit'], ['two', 'running', '']])
    expect([...runs.values()].filter((r) => r.state === 'active')).toHaveLength(1)
  })
  test('a waiting job stopped while it starts: its run is stopped too, no run lives with no open row', async () => {
    await alice().call({ command: 'sleep', job: true, log_name: 'one' })
    await shell('bob', null, chatBob).call({ command: 'sleep', job: true, log_name: 'two' })
    finish(runIdOfRow(rows()[0]!), 0)
    gated()
    const p = pollSrt(h.ctx)
    await Bun.sleep(20)
    await h.api('bob').call(API.stopMyDevEnvRun, { params: { runId: String(rows()[1]!.id) } })
    open()
    await p
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'stopped' })
    expect([...runs.values()].filter((r) => r.state === 'active')).toHaveLength(0)
  })
  test('a running command shows with its secrets hidden in the lists', async () => {
    gated()
    const p = alice().call({ command: 'echo hunter2' })
    await Bun.sleep(20)
    const page = await h.api('alice').call(API.devEnv, { params: { id: falconId } })
    expect(page.runs.running.map((x) => x.name)).toEqual(['echo [hidden]'])
    open()
    expect(out(await p)).toContain('Exit code 0.')
    // the run itself gets the real command
    expect([...runs.values()][0]!.spec.command).toBe('echo hunter2')
  })
  test('the server\'s data folder is hidden from a run even outside the base folder', async () => {
    await alice().call({ command: 'echo x' })
    expect(lastSettings().filesystem.denyRead).toContain(path.resolve(h.ctx.config.dataDir))
  })
})
