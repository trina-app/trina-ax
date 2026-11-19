// A shared project chat's sub-folders that not everyone in it may open do not exist for the chat (QA TC-4945,
// docs/decisions/20261118-shared-hide-subfolder-names.md): pure parts. Which folders are hidden
// (srt/access.ts sharedHiddenFolders), the person's access while a call runs (policy/access.ts withHiddenFolders), a
// run's view (sharedFolderView: nothing below a hidden folder, a folder everyone may read inside it neither), and how
// a run's writable folder that holds one is given (srt/mounts.ts hideDeniedNames, lockedTops). Whole shared turns with
// the file tools: tests/unit/b-shared-hidden-subfolders.test.ts. Real srt runs: tests/linux/srt-attack.ts S16.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hiddenNow, withHiddenFolders, type Access, type Principal } from '../../server/src/policy/access'
import { sharedFolderView, sharedHiddenFolders, sharedPathAccess, viewAccess } from '../../server/src/devenv/srt/access'
import { entryGuard, entryPins, hideDeniedNames, lockedTops, lockFolders, makeGuardDir, placeFolders, writePins } from '../../server/src/devenv/srt/mounts'
import { authorize } from '../../server/src/policy/authorize'
import { Denied } from '../../server/src/policy/errors'
import { lockedTopsNote } from '../../server/src/devenv/tool'
import { ruleWorld } from '../lib/rule-world'

const who = (id: string, groups: string[] = []): Principal => ({ id, name: id, role: 'member', groups })
const rows = (xs: (string | null)[][]) => xs.map(([p, t, s, a]) => ({ path: p!, subject_type: t as never, subject_id: s ?? null, access: a as Access }))
const F = 'projects/falcon'
// falcon: alice writes, finance (bob) reads. hr-PAYROLL: alice alone; hr-PAYROLL/handbook: everyone in the project
// again; docs: a rule folder both read; secret-PLAN/inner: a rule folder inside a hidden one
const RULES = ruleWorld(rows([
  [F, 'user', 'alice', 'write'], [F, 'group', 'finance', 'read'],
  [`${F}/hr-PAYROLL`, 'user', 'alice', 'write'], [`${F}/hr-PAYROLL/handbook`, 'group', 'finance', 'read'], [`${F}/hr-PAYROLL/handbook`, 'user', 'alice', 'read'],
  [`${F}/docs`, 'group', 'finance', 'read'],
  [`${F}/secret-PLAN`, 'user', 'alice', 'write'], [`${F}/secret-PLAN/inner`, 'user', 'alice', 'write'],
]), [F, `${F}/hr-PAYROLL`, `${F}/hr-PAYROLL/handbook`, `${F}/secret-PLAN`])
const alice = who('alice'), bob = who('bob', ['finance'])

describe('which sub-folders are hidden', () => {
  test('the shallowest folder with its own rules that someone in the chat cannot read; not one everyone reads', () => {
    expect(sharedHiddenFolders(RULES, alice, [alice, bob], F).sort()).toEqual([`${F}/hr-PAYROLL`, `${F}/secret-PLAN`])
    // bob runs the turn: the same folders (he cannot read them himself)
    expect(sharedHiddenFolders(RULES, bob, [alice, bob], F).sort()).toEqual([`${F}/hr-PAYROLL`, `${F}/secret-PLAN`])
    // alice alone sees the chat: nothing hidden
    expect(sharedHiddenFolders(RULES, alice, [alice], F)).toEqual([])
  })
})

describe('the person\'s access while a call runs', () => {
  const scope = { userId: 'alice', folders: [`${F}/hr-PAYROLL`] }
  test('none at and below a hidden folder for that person only, any letter case; nothing outside the call', () => {
    expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL', 'pay.md'])).toBe('write')
    withHiddenFolders(scope, () => {
      expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL'])).toBe('none')
      expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL', 'pay.md'])).toBe('none')
      expect(RULES.access(alice, [...F.split('/'), 'HR-payroll', 'pay.md'])).toBe('none')
      // a folder everyone reads again inside it: hidden too (its path names the hidden one)
      expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL', 'handbook', 'a.md'])).toBe('none')
      expect(RULES.canList(alice, [...F.split('/'), 'hr-PAYROLL'])).toBe(false)
      // a look-alike prefix is not inside it; the project folder stays hers
      expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL2'])).toBe('write')
      expect(RULES.access(alice, F.split('/'))).toBe('write')
      // other people are judged by the rules alone
      expect(RULES.access(bob, [...F.split('/'), 'hr-PAYROLL', 'handbook', 'a.md'])).toBe('read')
      // an inner call without a scope (sharedHiddenScope works the set out there) sees the rules
      expect(withHiddenFolders(null, () => RULES.access(alice, [...F.split('/'), 'hr-PAYROLL']))).toBe('write')
    })
    expect(RULES.access(alice, [...F.split('/'), 'hr-PAYROLL'])).toBe('write')
    expect(hiddenNow(alice, [...F.split('/'), 'hr-PAYROLL'])).toBe(false)
  })
  test('it holds across awaits of the same call, and two calls at once keep their own', async () => {
    const seen = await Promise.all([
      withHiddenFolders(scope, async () => { await Bun.sleep(5); return RULES.access(alice, [...F.split('/'), 'hr-PAYROLL']) }),
      withHiddenFolders(null, async () => { await Bun.sleep(1); return RULES.access(alice, [...F.split('/'), 'hr-PAYROLL']) }),
    ])
    expect(seen).toEqual(['none', 'write'])
  })
})

describe('a run of a shared project chat', () => {
  test('nothing below a hidden folder, a folder everyone may read inside it neither (it named the hidden one)', () => {
    const v = sharedFolderView(RULES, bob, { start: F }, { audience: [alice, bob], within: F })
    expect(viewAccess(v, `${F}/hr-PAYROLL/handbook/a.md`)).toBe('none')
    expect(v.read.some((r) => r.includes('hr-PAYROLL'))).toBe(false)
    expect(viewAccess(v, `${F}/docs/a.md`)).toBe('read')
    // the tool's notes name no path there either
    expect(sharedPathAccess(RULES, bob, { start: F }, { audience: [alice, bob], within: F }, `${F}/hr-PAYROLL/handbook/a.md`)).toBe('none')
  })

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-subfolders-'))
  for (const d of [`${F}/hr-PAYROLL/handbook`, `${F}/docs`, `${F}/src/lib`, `${F}/.git`, `${F}/skills/a`, `${F}/secret-PLAN`]) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, F, 'notes.md'), 'n')
  fs.symlinkSync('/etc', path.join(root, F, 'link'))
  test('a writable folder that holds a hidden one: given entry by entry, its sub-folders still writable', () => {
    const v = sharedFolderView(RULES, alice, { start: F }, { audience: [alice, bob], within: F })
    // before: the project folder whole, the hidden folders as empty places in it (their names listed)
    expect(v.write).toEqual([F])
    expect(v.denyRead.sort()).toEqual([`${F}/hr-PAYROLL`, `${F}/secret-PLAN`])
    const g = hideDeniedNames(v, root)
    expect(g.write).not.toContain(F)
    expect(g.write.sort()).toEqual([`${F}/docs`, `${F}/src`])
    // its files and the skill folder are read-only; the link and .git (its history may hold the hidden folder) are not
    // given at all
    expect(g.read.sort()).toEqual([`${F}/notes.md`, `${F}/skills`])
    expect(g.denyRead).toEqual([])
    expect([...g.read, ...g.write, ...g.denyRead, ...g.denyWrite].some((p) => /hr-PAYROLL|secret-PLAN|link|\.git/.test(p))).toBe(false)
    expect(viewAccess(g, `${F}/src/lib/a.ts`)).toBe('write')
    expect(viewAccess(g, `${F}/hr-PAYROLL/x`)).toBe('none')
    expect(lockedTops(v, g)).toEqual([F])
    const note = lockedTopsNote(lockedTops(v, g))
    expect(note).toContain(`$TRINA_TEAM/${F}`)
    expect(note).not.toMatch(/hr-PAYROLL|secret-PLAN/)
  })
  test('nothing hidden inside: the view is given as it is', () => {
    const v = sharedFolderView(RULES, alice, { start: F }, { audience: [alice], within: F })
    expect(hideDeniedNames(v, root)).toEqual(v)
    expect(lockedTops(v, hideDeniedNames(v, root))).toEqual([])
  })

  test('a read-only folder that holds a writable one and a hidden one is opened too; the writable one stays given', () => {
    const v = { read: [F], write: [`${F}/src`], denyRead: [`${F}/hr-PAYROLL`], denyWrite: [] }
    const g = hideDeniedNames(v, root)
    expect(g.read).not.toContain(F)
    expect(g.write).toEqual([`${F}/src`])
    expect([...g.read, ...g.denyRead].some((p) => p.includes('hr-PAYROLL'))).toBe(false)
    expect(g.read).toContain(`${F}/docs`)
    expect(viewAccess(g, `${F}/src/lib/a.ts`)).toBe('write')
  })

  test('a writable folder the view gave already inside an opened one is pinned too; one outside stays unpinned', () => {
    const v = { read: [F], write: [`${F}/src`], denyRead: [`${F}/hr-PAYROLL`], denyWrite: [] }
    const g = hideDeniedNames(v, root)
    const pins = entryPins(v, g, root)
    expect(Object.keys(pins)).toContain(path.join(root, F, 'src'))
    expect(Object.keys(pins)).toContain(path.join(root, F, 'docs'))
    const plain = { read: [F], write: [`${F}/src`], denyRead: [], denyWrite: [] }
    expect(entryPins(plain, hideDeniedNames(plain, root), root)).toEqual({})
  })

  test('git repositories in an opened folder are not given: .git in any letter case, a bare one', () => {
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-git-'))
    for (const d of [`${F}/hr-PAYROLL`, `${F}/.GIT`, `${F}/web.git/objects`, `${F}/web.git/refs`, `${F}/docs`, `${F}/not-a-repo/objects`]) fs.mkdirSync(path.join(r2, d), { recursive: true })
    fs.writeFileSync(path.join(r2, F, 'web.git/HEAD'), 'ref: refs/heads/main\n')
    const v = { read: [], write: [F, `${F}/web.git`], denyRead: [`${F}/hr-PAYROLL`], denyWrite: [] }
    const g = hideDeniedNames(v, r2)
    const all = [...g.read, ...g.write]
    expect(all.some((p) => /\.git$|web\.git/i.test(p))).toBe(false)
    expect(all).toContain(`${F}/docs`)
    expect(all).toContain(`${F}/not-a-repo`)
  })

  test('the entries given one by one are pinned; a folder swapped for a link is refused before the run', () => {
    const v = sharedFolderView(RULES, alice, { start: F }, { audience: [alice, bob], within: F })
    const g = hideDeniedNames(v, root)
    const pins = entryPins(v, g, root)
    expect(Object.keys(pins).sort()).toEqual([...g.read, ...g.write].map((r) => path.join(root, r)).sort())
    const st = fs.statSync(path.join(root, F, 'src'), { bigint: true })
    expect(pins[path.join(root, F, 'src')]).toBe(`${st.dev}:${st.ino}`)
    // one stat for all of them, by its full path, from files in the run's TMPDIR (no long argument)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'))
    const files = writePins(tmp, pins)!
    expect(fs.readFileSync(files.paths!, 'utf8').split('\0').filter(Boolean).sort()).toEqual(Object.keys(pins).sort())
    expect(fs.readFileSync(files.ids!, 'utf8').trim().split('\n')).toEqual(Object.values(pins))
    const guard = entryGuard(files)
    expect(guard).toContain('/usr/bin/xargs -0 /usr/bin/stat -c %d:%i --')
    expect(guard).toContain('exit 97')
    expect(guard.length).toBeLessThan(1000)
    expect(guard).not.toMatch(/hr-PAYROLL|secret-PLAN/)
    expect(writePins(tmp, {})).toBeNull()
    expect(entryGuard(null)).toBe('')
    // swapped after the listing: a link where a folder was
    fs.renameSync(path.join(root, F, 'src'), path.join(root, F, 'src-was'))
    fs.symlinkSync(path.join(root, F, 'hr-PAYROLL'), path.join(root, F, 'src'))
    try { expect(() => entryPins(v, g, root)).toThrow('a folder changed') } finally {
      fs.rmSync(path.join(root, F, 'src')); fs.renameSync(path.join(root, F, 'src-was'), path.join(root, F, 'src'))
    }
    // a quote in a file name stays one argument
    expect(entryGuard({ paths: "/t/it's", ids: '/t/i' })).toContain(`'/t/it'\\''s'`)
  })
})

// attacks S12, RV1, RV1d, RV6 (tests/linux/srt-attack.ts): srt's places above what is given (the team root, groups/, a
// folder given entry by entry at any depth) are writable folders of the sandbox's tmpfs; the command's first line takes
// their write bits, so a file made there fails instead of seeming written
describe('srt\'s places above what is given', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-places-')))
  for (const d of ['shared/hr-limited', 'shared/repo', 'shared/deep/hr-deep', 'shared/deep/docs', `${F}/hr-PAYROLL`, `${F}/docs`]) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'shared/s.md'), 's'); fs.writeFileSync(path.join(root, 'shared/deep/ok.md'), 'ok')
  const abs = (...r: string[]) => r.map((x) => (x === '' ? root : path.join(root, x)))
  test('a read-only folder opened at any depth, and every folder above, up to the team root', () => {
    const v = { read: ['shared'], write: [], denyRead: ['shared/deep/hr-deep'], denyWrite: [] }
    const g = hideDeniedNames(v, root)
    expect(g.read.sort()).toEqual(['shared/deep/docs', 'shared/deep/ok.md', 'shared/hr-limited', 'shared/repo', 'shared/s.md'])
    expect(placeFolders(g, root)).toEqual(abs('', 'shared', 'shared/deep'))
    const both = { read: ['shared'], write: [], denyRead: ['shared/hr-limited', 'shared/deep/hr-deep'], denyWrite: [] }
    expect(placeFolders(hideDeniedNames(both, root), root)).toEqual(abs('', 'shared', 'shared/deep'))
  })
  test('a writable folder given entry by entry is a place too; a folder given whole and what is inside it never are', () => {
    const v = { read: ['shared'], write: [F], denyRead: [`${F}/hr-PAYROLL`], denyWrite: [] }
    const g = hideDeniedNames(v, root)
    // projects/falcon is opened (lockedTops); shared is given whole: neither shared nor anything in it is a place
    expect(placeFolders(g, root)).toEqual(abs('', 'projects', F))
    expect(placeFolders({ read: [''], write: [], denyRead: [], denyWrite: [] }, root)).toEqual([])
    // a read-only folder inside a writable one given whole: the writable one is the real folder, never locked
    expect(placeFolders({ read: [`${F}/docs/x`], write: [F], denyRead: [], denyWrite: [] }, root)).toEqual(abs('', 'projects'))
  })
  test('every run: the places and srt\'s masks over hidden folders in the team folder; never a given folder, a file or a path outside', () => {
    fs.mkdirSync(path.join(root, 'groups/marketing/skills'), { recursive: true }); fs.mkdirSync(path.join(root, 'users/alice'), { recursive: true })
    fs.writeFileSync(path.join(root, 'shared/secret.txt'), 'x')
    const given = { read: ['shared', 'groups/marketing'], write: [F, 'users/alice'], denyRead: [], denyWrite: [] }
    const deny = [path.join(root, 'users'), path.join(root, 'groups/marketing/skills'), path.join(root, F), path.join(root, 'shared/secret.txt'), '/var/lib/elsewhere', path.join(root, 'missing')]
    const got = lockFolders(given, deny, root)
    // a temp folder on a tmpfs: nothing is locked (inside the sandbox a mask could not be told from it)
    if (Number(fs.statfsSync(root).type) === 0x01021994) { expect(got).toEqual([]); return }
    expect(got).toContain(root)
    expect(got).toContain(path.join(root, 'users'))
    expect(got).toContain(path.join(root, 'groups/marketing/skills'))
    // the start folder bound back writable (srtSettings puts it in denyRead), a masked file, outside, not on disk: never
    for (const p of [path.join(root, F), path.join(root, 'shared/secret.txt'), '/var/lib/elsewhere', path.join(root, 'missing'), path.join(root, 'shared'), path.join(root, 'users/alice')]) expect(got).not.toContain(p)
  })
  test('the guard locks the places after the pin check; places alone, no pins', () => {
    const v = { read: ['shared'], write: [], denyRead: ['shared/deep/hr-deep'], denyWrite: [] }
    const g = hideDeniedNames(v, root)
    const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pins-places-'))
    const files = writePins(fresh(), entryPins(v, g, root), placeFolders(g, root))!
    expect(fs.readFileSync(files.places!, 'utf8')).toBe(abs('', 'shared', 'shared/deep').map((p) => p + '\0').join(''))
    const guard = entryGuard(files)
    expect(guard.indexOf('/bin/chmod a-w')).toBeGreaterThan(guard.indexOf('exit 97'))
    // the files stay in the run's read-only guard folder, which the server removes after the run
    expect(guard).not.toContain('/bin/rm')
    expect(guard).not.toContain('hr-deep')
    const only = writePins(fresh(), {}, abs(''))!
    expect(only.paths).toBeUndefined()
    expect(entryGuard(only)).not.toContain('exit 97')
    expect(entryGuard(only)).toContain('/bin/chmod a-w')
    expect(writePins(fresh(), {}, [])).toBeNull()
    expect(() => writePins(fresh(), {}, abs(''), '../x')).toThrow()
    // the lock touches only folders that are folders on a tmpfs inside the sandbox
    expect(entryGuard(only)).toContain('[ -d "$__lock_dir" ] && [ ! -L "$__lock_dir" ]')
    expect(entryGuard(only)).toContain('= tmpfs ]')
  })
  // review of PR #1372 (T1 RX1-RX4): a person's TMPDIR is in her HOME, which her runs write; a run there could leave a
  // link the server would follow. The files go into a guard folder of the run that the server makes new
  test('the guard folder is made new; a file is never written through a link left in its place', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'))
    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-target-'))
    const dir = path.join(base, 'guard', 'run0123456789abc')
    const drop = makeGuardDir(dir)
    expect(fs.lstatSync(dir).isDirectory()).toBe(true)
    expect(writePins(dir, {}, abs(''))!.places).toBe(path.join(dir, '.trina-places'))
    drop()
    expect(fs.existsSync(dir)).toBe(false)
    // a link where the folder of the run would be: refused, nothing written at the target
    fs.symlinkSync(hidden, dir)
    expect(() => makeGuardDir(dir)).toThrow()
    // and a link where a file of the run would be: wx does not follow it
    const d2 = path.join(base, 'guard', 'run0123456789abd')
    makeGuardDir(d2)
    fs.symlinkSync(path.join(hidden, 'planted'), path.join(d2, '.trina-places'))
    expect(() => writePins(d2, {}, abs(''))).toThrow()
    expect(fs.readdirSync(hidden)).toEqual([])
  })
})

describe('a write directly in a folder that holds a hidden one', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-writes-')))
  for (const d of [`${F}/hr-PAYROLL`, `${F}/docs`]) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, F, 'notes.md'), 'n')
  const fx = { root, caseInsensitive: false } as never
  const why = (p: string) => { try { authorize(fx, RULES, alice, p, 'write', { mustExist: false, createDirs: true }); return 'ok' } catch (e) { return e instanceof Denied ? e.message : String(e) } }
  test('one text for the hidden name, a path inside it and a free name; a sub-folder and an existing file work', () => {
    withHiddenFolders({ userId: 'alice', folders: [`${F}/hr-PAYROLL`] }, () => {
      const texts = [why(`${F}/hr-PAYROLL`), why(`${F}/hr-PAYROLL/x.md`), why(`${F}/HR-payroll/x.md`), why(`${F}/free-name.md`), why(`${F}/free/x.md`)]
      expect(new Set(texts).size).toBe(1)
      expect(texts[0]).toContain(`'${F}'`)
      expect(texts[0]).not.toContain('hr-PAYROLL')
      expect(why(`${F}/docs/new.md`)).toBe('ok')
      expect(why(`${F}/notes.md`)).toBe('ok')
    })
    // outside the call: as the rules say
    expect(why(`${F}/free-name.md`)).toBe('ok')
  })
})
