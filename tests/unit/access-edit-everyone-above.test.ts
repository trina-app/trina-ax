// The Files page's "Who can open it" panel (docs/DECISIONS.md "Who can open it, like Drive's Share"): its General
// access choice "Same as the {folder} folder" says what the folder above gives everyone. The edit preview answers it in
// one field, `everyoneAbove` (server/src/admin/access-edit.ts): what a member that no person or group rule names would
// get at the folder with no rules of its own, and the folder whose rule decides it. Checked here against the
// permission function itself (RuleSet.access / explain) on random worlds, and on the cases the plan names.
import { describe, expect, test } from 'bun:test'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { editPreview, withRules } from '../../server/src/admin/access-edit'

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const NOBODY: Principal = { id: 'someone-new', name: 'New', role: 'member', groups: [] }
type Row = ConstructorParameters<typeof RuleSet>[0][number]
const row = (path: string, subject_type: Row['subject_type'], subject_id: string | null, access: Access): Row => ({ path, subject_type, subject_id, access })
const people: Principal[] = [
  { id: 'olga', name: 'Olga', role: 'owner', groups: [] },
  { id: 'dana', name: 'Dana', role: 'admin', groups: [] },
  { id: 'bob', name: 'Bob', role: 'member', groups: ['sales'] },
  { id: 'eve', name: 'Eve', role: 'member', groups: ['sales', 'leads'] },
]
const preview = (rows: Row[], at: string, next: Parameters<typeof editPreview>[2] = []) =>
  editPreview({ rules: new RuleSet(rows), people, groupName: (id) => id, personName: (id) => id }, at, next, { team: null })

describe('everyoneAbove: what the folder above gives everyone', () => {
  test('null at the team root (nothing is above it)', () => {
    expect(preview([], '').everyoneAbove).toBeNull()
  })

  test('nothing above lets everyone in: none, from no folder', () => {
    expect(preview([], 'shared/sales').everyoneAbove).toEqual({ access: 'none', folder: null })
  })

  test('the nearest everyone rule above, and the folder it is on', () => {
    const rows = [row('shared', 'everyone', null, 'read'), row('shared/sales', 'group', 'sales', 'write')]
    expect(preview(rows, 'shared/sales/quotes').everyoneAbove).toEqual({ access: 'read', folder: 'shared' })
    expect(preview([...rows, row('shared/sales', 'everyone', null, 'none')], 'shared/sales/quotes').everyoneAbove).toEqual({ access: 'none', folder: 'shared/sales' })
    expect(preview([row('', 'everyone', null, 'write')], 'docs').everyoneAbove).toEqual({ access: 'write', folder: '' })
  })

  test('the folder\'s own rules do not count (it is "if this folder had none"), the draft neither', () => {
    const rows = [row('shared', 'everyone', null, 'read'), row('shared/sales', 'everyone', null, 'none')]
    expect(preview(rows, 'shared/sales').everyoneAbove).toEqual({ access: 'read', folder: 'shared' })
    expect(preview(rows, 'shared/sales', [{ subjectType: 'everyone', subjectId: null, access: 'write' }]).everyoneAbove).toEqual({ access: 'read', folder: 'shared' })
  })

  test('an old member role row above counts as everyone\'s; an admin role row does not', () => {
    expect(preview([row('shared', 'role', 'member', 'write')], 'shared/x').everyoneAbove).toEqual({ access: 'write', folder: 'shared' })
    expect(preview([row('shared', 'role', 'admin', 'write')], 'shared/x').everyoneAbove).toEqual({ access: 'none', folder: null })
  })

  test('still said when every member today is named by a group rule above (the grouped `above` would show nobody)', () => {
    const rows = [row('shared', 'everyone', null, 'read'), row('shared', 'group', 'sales', 'write')]
    const out = preview(rows, 'shared/x')
    // every member is in sales: the grouped answer has no everyone row at all
    expect(out.above!.some((w) => w.subject?.type === 'everyone')).toBe(false)
    expect(out.everyoneAbove).toEqual({ access: 'read', folder: 'shared' })
  })

  test('on random worlds: the permission function for a member nobody names, with the folder\'s own rules taken out', () => {
    let seed = 41
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
    const folders = ['', 'a', 'a/b', 'a/b/c', 'a/e', 'g', 'g/h']
    for (let world = 0; world < 300; world++) {
      const rows: Row[] = []
      for (const f of folders) {
        if (rand() < 0.5) continue
        const kinds = new Set<string>()
        for (let k = 0; k < 3; k++) {
          const t = pick(['everyone', 'role', 'group', 'user'] as const)
          const id = t === 'everyone' ? null : t === 'role' ? pick(['member', 'admin']) : t === 'group' ? pick(['sales', 'leads']) : pick(['bob', 'eve'])
          if (kinds.has(`${t}:${id}`)) continue
          kinds.add(`${t}:${id}`)
          rows.push(row(f, t, id, pick(['none', 'read', 'write'] as const)))
        }
      }
      const at = pick(['a', 'a/b', 'a/b/c', 'a/b/c/new', 'a/e', 'g/h', 'g'])
      const out = preview(rows, at)
      const without = withRules(new RuleSet(rows), at, [])
      const e = without.explain(NOBODY, segsOf(at))
      expect({ world, at, got: out.everyoneAbove }).toEqual({ world, at, got: { access: without.access(NOBODY, segsOf(at)), folder: e.reason.kind === 'rule' ? e.reason.folder : null } })
    }
  })
})
