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
import { entryGuard, entryPins, hideDeniedNames, lockedTops } from '../../server/src/devenv/srt/mounts'
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

  test('the entries given one by one are pinned; a folder swapped for a link is refused before the run', () => {
    const v = sharedFolderView(RULES, alice, { start: F }, { audience: [alice, bob], within: F })
    const g = hideDeniedNames(v, root)
    const pins = entryPins(v, g, root)
    expect(Object.keys(pins).sort()).toEqual([...g.read, ...g.write].map((r) => path.join(root, r)).sort())
    const st = fs.statSync(path.join(root, F, 'src'), { bigint: true })
    expect(pins[path.join(root, F, 'src')]).toBe(`${st.dev}:${st.ino}`)
    const guard = entryGuard(pins)
    expect(guard).toContain(`stat -c %d:%i -- '${path.join(root, F, 'src')}'`)
    expect(guard).toContain('exit 97')
    expect(guard).not.toMatch(/hr-PAYROLL|secret-PLAN/)
    expect(entryGuard({})).toBe('')
    // swapped after the listing: a link where a folder was
    fs.renameSync(path.join(root, F, 'src'), path.join(root, F, 'src-was'))
    fs.symlinkSync(path.join(root, F, 'hr-PAYROLL'), path.join(root, F, 'src'))
    try { expect(() => entryPins(v, g, root)).toThrow('a folder changed') } finally {
      fs.rmSync(path.join(root, F, 'src')); fs.renameSync(path.join(root, F, 'src-was'), path.join(root, F, 'src'))
    }
    // a quote in a name stays one argument
    expect(entryGuard({ "/t/it's": '1:2' })).toContain(`'/t/it'\\''s'`)
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
