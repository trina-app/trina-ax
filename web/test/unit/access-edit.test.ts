// Admin › Folder permissions › the edit panel (stage 5): a folder's rules as the panel reads them and the rules it saves
// (web/src/lib/access-edit.ts). Reading and saving again changes nothing; old role rows are saved as "everyone" and that
// changes nobody's access, checked here against the server's own permission function (RuleSet) on random worlds.
import { describe, expect, test } from 'bun:test'
import { type Access, type Principal } from '../../../server/src/policy/access'
import { addNamed, basicChoices, draftKey, draftOf, limitedOf, outcomesOf, outcomeWords, removeNamed, rootNoneRow, rulesKey, rulesOf, sameRules, setNamed, type RuleLike } from '../../src/lib/access-edit'
import { translate } from '../../src/i18n'
import { ruleWorld } from '../../../tests/lib/rule-world'

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
  // since folder access adds up (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"): "only the people
  // named" is Limit access (limitedOf), never an "everyone: none" rule
  test('follow is no everyone rule and no limit; only the people named is the limit; read and write as said', () => {
    const named = [{ subjectType: 'user' as const, subjectId: 'bob', access: 'read' as Access }]
    expect(rulesOf({ basic: 'follow', named }, { root: false })).toEqual([user('bob', 'read')])
    expect(limitedOf({ basic: 'follow', named }, false)).toBe(false)
    expect(rulesOf({ basic: 'named', named: [] }, { root: false })).toEqual([])
    expect(limitedOf({ basic: 'named', named: [] }, false)).toBe(true)
    expect(rulesOf({ basic: 'read', named }, { root: false })).toEqual([user('bob', 'read'), every('read')])
    expect(limitedOf({ basic: 'read', named }, false)).toBeUndefined()
    expect(rulesOf({ basic: 'write', named: [] }, { root: false })).toEqual([every('write')])
    // a "no access" row on a limited folder is left out: the limit keeps them out already
    expect(rulesOf({ basic: 'named', named: [{ subjectType: 'user', subjectId: 'bob', access: 'none' }] }, { root: false })).toEqual([])
  })

  test('the root: "only the people named" is no rule and keeps the root as it is', () => {
    expect(rulesOf({ basic: 'named', named: [] }, { root: true })).toEqual([])
    expect(limitedOf({ basic: 'named', named: [] }, true)).toBeUndefined()
    expect(rootNoneRow([every('none')])).toBe(false)
  })

  test('reading and saving again gives the same rules and limit', () => {
    for (const [rules, root, limited] of [
      [[every('read'), group('g1', 'write')], false, false],
      [[], false, true],
      [[group('g1', 'write')], false, true],
      [[every('read')], false, true],
      [[], false, false],
      [[], true, false],
      [[user('bob', 'read')], true, false],
    ] as [RuleLike[], boolean, boolean][]) {
      const d = draftOf(rules, root, limited).draft
      expect(sameRules(rulesOf(d, { root }), rules), JSON.stringify(rules)).toBe(true)
      expect(limitedOf(d, root) ?? limited, JSON.stringify([rules, limited])).toBe(limited)
    }
    expect(rulesOf(draftOf([every('read'), admin('write')], false).draft, { root: false })).toEqual([every('read')])
    expect(rulesOf(draftOf([member('write')], false).draft, { root: false })).toEqual([every('write')])
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

  test('the Save button and the summary keep the outcomes apart: an edit that becomes view only is not losing access', () => {
    const c = (before: 'none' | 'read' | 'write', after: 'none' | 'read' | 'write', count: number) => ({ before, after, count })
    const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
    const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    // write → read only: "can no longer edit", never "loses access"
    const writeToRead = outcomesOf([c('write', 'read', 1)])
    expect(writeToRead).toEqual({ loseOpen: 0, loseEdit: 1, gainOpen: 0, gainEdit: 0 })
    expect(outcomeWords(en, writeToRead)).toEqual(['1 can no longer edit'])
    expect(en('accessEdit.saveParts', { parts: outcomeWords(en, writeToRead).join(' · ') })).toBe('Save (1 can no longer edit)')
    expect(ko('accessEdit.saveParts', { parts: outcomeWords(ko, writeToRead).join(' · ') })).toBe('저장 (1명 못 고치게 됨)')
    for (const l of ['en', 'ko', 'id', 'ja', 'es'] as const) expect(outcomeWords((k, p) => translate(l, k, p), writeToRead).join(' ')).not.toMatch(/lose|loses|kehilangan|pierde|잃|못 열/)
    // the four outcomes, losses first
    const all = outcomesOf([c('write', 'none', 2), c('read', 'none', 1), c('write', 'read', 1), c('none', 'read', 3), c('none', 'write', 1), c('read', 'write', 2)])
    expect(all).toEqual({ loseOpen: 3, loseEdit: 1, gainOpen: 4, gainEdit: 2 })
    expect(outcomeWords(en, all)).toEqual(['3 can no longer open it', '1 can no longer edit', '4 can now open it', '2 can now edit'])
    expect(outcomeWords(en, outcomesOf([]))).toEqual([])
    expect(ko('accessEdit.saveNone')).toBe('저장 (권한 변화 없음)')
  })
})

test('reading a folder and saving it again changes nobody\'s access (the server\'s RuleSet, random worlds)', () => {
  let seed = 7
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
  const GRANT: Access[] = ['read', 'write']
  for (let world = 0; world < 400; world++) {
    const people: Principal[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', groups: ['g0', 'g1'].filter(() => rand() < 0.5) }))
    const at = pick(['', 'a', 'a/b'])
    const here: RuleLike[] = []
    if (rand() < 0.6) here.push(every(pick(GRANT)))
    if (rand() < 0.5) here.push(group(pick(['g0', 'g1']), pick(GRANT)))
    if (rand() < 0.4) here.push(user(pick(people).id, pick(GRANT)))
    const limited = at !== '' && rand() < 0.5
    const above = ['', 'a', 'a/b'].filter((f) => f !== at && rand() < 0.5).flatMap((f) => [{ path: f, subject_type: 'everyone' as const, subject_id: null, access: pick(GRANT) }])
    const rows = (rules: RuleLike[]) => [...above, ...rules.map((r) => ({ path: at, subject_type: r.subjectType as 'everyone', subject_id: r.subjectId, access: r.access }))]
    const before = ruleWorld(rows(here), limited ? [at] : [])
    const root = at === ''
    const d = draftOf(here, root, limited).draft
    const after = ruleWorld(rows(rulesOf(d, { root })), (limitedOf(d, root) ?? limited) ? [at] : [])
    for (const p of people) for (const path of ['', 'a', 'a/b', 'a/b/c']) {
      const segs = path === '' ? [] : path.split('/')
      expect(after.access(p, segs), `${world} ${JSON.stringify(here)} ${p.id} ${path}`).toBe(before.access(p, segs))
    }
  }
})
