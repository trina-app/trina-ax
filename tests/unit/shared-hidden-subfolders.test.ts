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
import { hideDeniedNames, lockedTops } from '../../server/src/devenv/srt/mounts'
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
    // its files, the dot folders and the skill folder are read-only; the link is not given
    expect(g.read.sort()).toEqual([`${F}/.git`, `${F}/notes.md`, `${F}/skills`])
    expect(g.denyRead).toEqual([])
    expect([...g.read, ...g.write, ...g.denyRead, ...g.denyWrite].some((p) => /hr-PAYROLL|secret-PLAN|link/.test(p))).toBe(false)
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
})
