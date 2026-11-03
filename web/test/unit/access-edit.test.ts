// Admin › Folder permissions › the edit panel (stage 5): a folder's rules as the panel reads them and the rules it saves
// (web/src/lib/access-edit.ts). Reading and saving again changes nothing; old role rows are saved as "everyone" and that
// changes nobody's access, checked here against the server's own permission function (RuleSet) on random worlds.
import { describe, expect, test } from 'bun:test'
import { RuleSet, type Access, type Principal } from '../../../server/src/policy/access'
import { addNamed, basicChoices, draftKey, draftOf, removeNamed, rootNoneRow, rulesKey, rulesOf, sameRules, saveImpact, setNamed, type RuleLike } from '../../src/lib/access-edit'
import { translate } from '../../src/i18n'

const every = (access: Access) => ({ subjectType: 'everyone' as const, subjectId: null, access })
const member = (access: Access) => ({ subjectType: 'role' as const, subjectId: 'member' as const, access })
const admin = (access: Access) => ({ subjectType: 'role' as const, subjectId: 'admin' as const, access })
const user = (id: string, access: Access) => ({ subjectType: 'user' as const, subjectId: id, access })
const group = (id: string, access: Access) => ({ subjectType: 'group' as const, subjectId: id, access })

describe('reading a folder\'s rules', () => {
  test('the basic access: the member row first, else the everyone row, else follow (the root: only the people named)', () => {
    expect(draftOf([], false).draft).toEqual({ basic: 'follow', named: [] })
    expect(draftOf([], true).draft).toEqual({ basic: 'named', named: [] })
    expect(draftOf([every('none')], false).draft.basic).toBe('named')
    expect(draftOf([every('read')], false).draft.basic).toBe('read')
    expect(draftOf([every('write')], false).draft.basic).toBe('write')
    // a member row decides for members before an everyone row does
    expect(draftOf([every('none'), member('read')], false).draft.basic).toBe('read')
    expect(draftOf([member('write')], false).draft.basic).toBe('write')
    // an admin row has no effect
    expect(draftOf([admin('write')], false).draft.basic).toBe('follow')
  })

  test('people and groups as they are, "no access" included; what will be saved another way is said', () => {
    const d = draftOf([user('bob', 'none'), group('g1', 'write'), every('read'), admin('write')], false)
    expect(d.draft.named).toEqual([{ subjectType: 'user', subjectId: 'bob', access: 'none' }, { subjectType: 'group', subjectId: 'g1', access: 'write' }])
    expect(d.converted).toEqual({ member: false, admin: true })
    expect(draftOf([member('read'), every('none')], false).converted).toEqual({ member: true, admin: false })
    expect(draftOf([every('read')], false).converted).toEqual({ member: false, admin: false })
  })
})

describe('the rules a draft saves', () => {
  test('follow is no everyone rule; only the people named is everyone: none; read and write as said', () => {
    const named = [{ subjectType: 'user' as const, subjectId: 'bob', access: 'none' as Access }]
    expect(rulesOf({ basic: 'follow', named }, { root: false })).toEqual([user('bob', 'none')])
    expect(rulesOf({ basic: 'follow', named: [] }, { root: false })).toEqual([])
    expect(rulesOf({ basic: 'named', named: [] }, { root: false })).toEqual([every('none')])
    expect(rulesOf({ basic: 'read', named }, { root: false })).toEqual([user('bob', 'none'), every('read')])
    expect(rulesOf({ basic: 'write', named: [] }, { root: false })).toEqual([every('write')])
  })

  test('the root: "only the people named" keeps the form it had (no rule, or everyone: none)', () => {
    expect(rulesOf({ basic: 'named', named: [] }, { root: true })).toEqual([])
    expect(rulesOf({ basic: 'named', named: [] }, { root: true, rootNoneRow: rootNoneRow([every('none')]) })).toEqual([every('none')])
    expect(rootNoneRow([])).toBe(false)
    expect(rootNoneRow([every('read')])).toBe(false)
    expect(rootNoneRow([member('none'), every('read')])).toBe(true)
  })

  test('reading and saving again gives the same rules when nothing was old; role rows go', () => {
    for (const [rules, root] of [
      [[every('read'), user('bob', 'none'), group('g1', 'write')], false],
      [[every('none')], false],
      [[group('g1', 'write')], false],
      [[], false],
      [[], true],
      [[every('none'), user('bob', 'read')], true],
    ] as [RuleLike[], boolean][]) {
      const saved = rulesOf(draftOf(rules, root).draft, { root, rootNoneRow: root && rootNoneRow(rules) })
      expect(sameRules(saved, rules), JSON.stringify(rules)).toBe(true)
    }
    expect(rulesOf(draftOf([every('read'), admin('write')], false).draft, { root: false })).toEqual([every('read')])
    expect(rulesOf(draftOf([member('write'), every('none')], false).draft, { root: false })).toEqual([every('write')])
  })

  test('the same rules in another order are the same; the key of a set of rules follows its order', () => {
    expect(sameRules([every('read'), user('bob', 'none')], [user('bob', 'none'), every('read')])).toBe(true)
    expect(sameRules([every('read')], [every('write')])).toBe(false)
    expect(sameRules([every('read')], [every('read'), user('bob', 'none')])).toBe(false)
    expect(rulesKey([every('read')])).not.toBe(rulesKey([every('write')]))
  })
})

describe('changing a draft', () => {
  test('add (read, once), set, remove; the draft key follows', () => {
    let d = draftOf([every('read')], false).draft
    const k0 = draftKey(d)
    d = addNamed(d, { subjectType: 'user', subjectId: 'bob' })
    expect(d.named).toEqual([{ subjectType: 'user', subjectId: 'bob', access: 'read' }])
    expect(addNamed(d, { subjectType: 'user', subjectId: 'bob' })).toBe(d)
    d = setNamed(d, 0, 'none')
    expect(d.named[0]!.access).toBe('none')
    expect(draftKey(d)).not.toBe(k0)
    expect(draftKey(removeNamed(d, 0))).toBe(k0)
  })

  test('the choices: no follow at the root, no "everyone writes" in a connected folder unless it is so now', () => {
    expect(basicChoices({ root: false, connected: false, current: 'follow' })).toEqual(['follow', 'named', 'read', 'write'])
    expect(basicChoices({ root: true, connected: false, current: 'named' })).toEqual(['named', 'read', 'write'])
    expect(basicChoices({ root: false, connected: true, current: 'read' })).toEqual(['follow', 'named', 'read'])
    expect(basicChoices({ root: false, connected: true, current: 'write' })).toEqual(['follow', 'named', 'read', 'write'])
  })

  test('the Save button says the impact in words', () => {
    const say = (less: number, more: number) => {
      const i = saveImpact({ less, more })
      return i.kind === 'none' ? translate('ko', 'accessEdit.saveNone') : i.kind === 'less' ? translate('ko', 'accessEdit.saveLess', { n: i.n }) : i.kind === 'more' ? translate('ko', 'accessEdit.saveMore', { n: i.n }) : translate('ko', 'accessEdit.saveBoth', { less: i.less, more: i.more })
    }
    expect(say(0, 0)).toBe('저장 (권한 변화 없음)')
    expect(say(2, 0)).toBe('저장 (2명 권한 줄어듦)')
    expect(say(0, 1)).toBe('저장 (1명 권한 늘어남)')
    expect(say(2, 3)).toBe('저장 (2명 줄어듦 · 3명 늘어남)')
    expect(translate('en', 'accessEdit.saveLess', { n: 1 })).toBe('Save (1 person loses access)')
    expect(translate('en', 'accessEdit.saveLess', { n: 2 })).toBe('Save (2 people lose access)')
  })
})

test('reading old role rows and saving them changes nobody\'s access (the server\'s RuleSet, random worlds)', () => {
  let seed = 7
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
  const ACCESS: Access[] = ['none', 'read', 'write']
  for (let world = 0; world < 400; world++) {
    const people: Principal[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', groups: ['g0', 'g1'].filter(() => rand() < 0.5) }))
    const at = pick(['', 'a', 'a/b'])
    const here: RuleLike[] = []
    if (rand() < 0.6) here.push(member(pick(ACCESS)))
    if (rand() < 0.6) here.push(admin(pick(ACCESS)))
    if (rand() < 0.6) here.push(every(pick(ACCESS)))
    if (rand() < 0.5) here.push(group(pick(['g0', 'g1']), pick(ACCESS)))
    if (rand() < 0.4) here.push(user(pick(people).id, pick(ACCESS)))
    const above = ['', 'a', 'a/b'].filter((f) => f !== at && rand() < 0.5).flatMap((f) => [{ path: f, subject_type: 'everyone' as const, subject_id: null, access: pick(ACCESS) }])
    const rows = (rules: RuleLike[]) => [...above, ...rules.map((r) => ({ path: at, subject_type: r.subjectType as 'everyone', subject_id: r.subjectId, access: r.access }))]
    const before = new RuleSet(rows(here))
    const root = at === ''
    const after = new RuleSet(rows(rulesOf(draftOf(here, root).draft, { root, rootNoneRow: root && rootNoneRow(here) })))
    for (const p of people) for (const path of ['', 'a', 'a/b', 'a/b/c']) {
      const segs = path === '' ? [] : path.split('/')
      expect(after.access(p, segs), `${world} ${JSON.stringify(here)} ${p.id} ${path}`).toBe(before.access(p, segs))
    }
  }
})
