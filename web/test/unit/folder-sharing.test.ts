// The Files page's "Who can open it" panel for admins (docs/DECISIONS.md "Who can open it, like Drive's Share";
// web/src/lib/folder-sharing.ts): the rows the folders above give, the plain "what will happen" lines with names, and
// when Save asks before saving. The answers here come from the server's own preview (server/src/admin/access-edit.ts
// editPreview on a RuleSet), so the words are checked against what the permission function says.
import { describe, expect, test } from 'bun:test'
import type { Access, FolderEditChange, FolderEditPreview } from '@mycel/shared/api'
import { RuleSet, type Principal } from '../../../server/src/policy/access'
import { editPreview } from '../../../server/src/admin/access-edit'
import { draftOf, rulesOf, type Draft } from '../../src/lib/access-edit'
import { aboveRows, askTitle, generalLevel, hasPanel, inProjects, kindOf, namesText, outcomeLines, overridingGroup, overrideText, parentOf, raisesAccess, sameOutcome, saveAsk } from '../../src/lib/folder-sharing'
import { translate, type MessageKey, type Params } from '../../src/i18n'

const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
type Row = ConstructorParameters<typeof RuleSet>[0][number]
const row = (path: string, subject_type: Row['subject_type'], subject_id: string | null, access: Access): Row => ({ path, subject_type, subject_id, access })
const people: Principal[] = [
  { id: 'olga', name: 'Olga', role: 'owner', groups: [] },
  { id: 'dana', name: 'Dana', role: 'admin', groups: [] },
  { id: 'alice', name: 'Alice', role: 'member', groups: ['sales'] },
  { id: 'bob', name: 'Bob', role: 'member', groups: ['sales', 'leads'] },
  { id: 'carol', name: 'Carol', role: 'member', groups: ['leads'] },
  { id: 'erin', name: 'Erin', role: 'member', groups: [] },
  { id: 'frank', name: 'Frank', role: 'member', groups: [] },
]
/** the server's answer for `rules` as the rules of `at`, with the full shape the panel reads */
const answer = (rows: Row[], at: string, rules: { subjectType: string; subjectId: string | null; access: Access }[]): FolderEditPreview => ({
  path: at, exists: true, connected: false,
  ...editPreview({ rules: new RuleSet(rows), people, groupName: (id) => id[0]!.toUpperCase() + id.slice(1), personName: (id) => people.find((p) => p.id === id)?.name ?? id }, at, rules, { team: at === 'shared' ? 'shared' : null }),
})
// "Quotes" (shared/sales/quotes): Sales can edit here, Alice only views; on shared/sales Leads can view and nobody else
const WORLD = [
  row('shared', 'everyone', null, 'read'),
  row('shared/sales', 'group', 'leads', 'read'), row('shared/sales', 'everyone', null, 'none'),
  row('shared/sales/quotes', 'group', 'sales', 'write'), row('shared/sales/quotes', 'user', 'alice', 'read'),
]
const QUOTES = new RuleSet(WORLD).rulesAt('shared/sales/quotes')
const groups = new Map([['sales', { id: 'sales', name: 'Sales', description: null, memberIds: ['alice', 'bob'] }], ['leads', { id: 'leads', name: 'Leads', description: null, memberIds: ['bob', 'carol'] }]])
const users = new Map(people.map((p) => [p.id, { status: 'active' as const }]))

describe('which folders have a panel, and which ones it changes', () => {
  test('the top of the team folder and the containers have none; projects/ and anything inside it is a project\'s', () => {
    for (const p of ['', 'users', 'groups', 'projects', 'connected']) expect(hasPanel(p)).toBe(false)
    for (const p of ['shared', 'groups/sales', 'connected/nas']) expect(hasPanel(p)).toBe(true)
    expect(inProjects('projects/falcon')).toBe(true)
    expect(inProjects('projects/falcon/docs/x')).toBe(true)
    expect(inProjects('projects')).toBe(false)
    expect(inProjects('shared/projects/falcon')).toBe(false)
    expect(parentOf('shared/sales')).toBe('shared')
    expect(parentOf('shared')).toBe('')
    expect(parentOf('')).toBeNull()
  })
})

describe('rows from the folders above', () => {
  test('the people and groups a folder above lets in here, greyed, with that folder; not those set here', () => {
    const a = answer(WORLD, 'shared/sales/quotes', QUOTES)
    const rows = aboveRows(a.next, 'shared/sales/quotes')
    // Leads from shared/sales decides for Carol (Bob is decided here, by Sales)
    expect(rows).toEqual([{ type: 'group', id: 'leads', name: 'Leads', access: 'read', folder: 'shared/sales' }])
  })

  test('"Only people added here" shuts out what folders above give: no row from above is left', () => {
    const a = answer(WORLD, 'shared/sales/quotes', [...QUOTES, { subjectType: 'everyone', subjectId: null, access: 'none' }])
    expect(aboveRows(a.next, 'shared/sales/quotes')).toEqual([])
  })

  test('someone kept out by a folder above shows too, as no access, last', () => {
    const rows = [...WORLD, row('shared/sales', 'user', 'frank', 'none'), row('shared/sales', 'user', 'erin', 'write')]
    const a = answer(rows, 'shared/sales/quotes', QUOTES)
    expect(aboveRows(a.next, 'shared/sales/quotes').map((r) => `${r.name}:${r.access}`)).toEqual(['Leads:read', 'Erin:write', 'Frank:none'])
  })
})

describe('a person and their group set here', () => {
  test('the person\'s own setting wins here, and the row says so in plain words', () => {
    const d = draftOf(QUOTES, false).draft
    expect(overridingGroup(d, 'alice', groups)?.name).toBe('Sales')
    expect(overridingGroup(d, 'erin', groups)).toBeNull()
    expect(overrideText(en, 'Sales', 'read')).toBe('In Sales, but can only view here')
    expect(overrideText(en, 'Sales', 'none')).toBe("In Sales, but can't open it here")
    expect(overrideText(ko, '영업', 'write')).toBe('영업에 속하지만 여기선 고칠 수 있음')
  })
})

describe('what will happen, by name', () => {
  test('adding a group names who will be able to open it', () => {
    const next = [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' as Access }]
    const a = answer(WORLD, 'shared/sales/quotes', next)
    expect(outcomeLines(en, 'en', a, { skills: false }).map((l) => l.text)).toEqual(['Erin will be able to open it'])
  })

  test('a narrower setting here names who loses, before Save: adding a group can lower someone from above', () => {
    // Erin can edit here through her own setting on shared/sales; the group Leads set here to view decides for Carol and Bob,
    // and Erin set here to view lowers her
    const rows = [...WORLD, row('shared/sales', 'user', 'erin', 'write')]
    const a = answer(rows, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }])
    expect(outcomeLines(en, 'en', a, { skills: false }).map((l) => [l.kind, l.text])).toEqual([['viewOnly', 'Erin will only be able to view it']])
    // in skills/, losing edit means no longer changing the team's skills
    expect(outcomeLines(en, 'en', a, { skills: true })[0]!.text).toBe("Erin will no longer be able to change the team's skills")
  })

  test('at most three names, then "and N others"; nothing changes: said so', () => {
    expect(namesText(en, 'en', ['Ann', 'Ben'], 2)).toBe('Ann and Ben')
    expect(namesText(en, 'en', ['Ann', 'Ben', 'Cy', 'Di', 'Ed'], 9)).toBe('Ann, Ben, Cy and 6 others')
    expect(namesText(ko, 'ko', ['Ann', 'Ben', 'Cy', 'Di'], 4)).toBe('Ann, Ben, Cy 외 1명')
    expect(outcomeLines(en, 'en', { changes: [], below: [] }, { skills: false })).toEqual([{ kind: 'none', text: "No one's access changes." }])
    expect(outcomeLines(en, 'en', { changes: [], below: [{ path: 'a/b', less: 1, more: 0, people: [] }] }, { skills: false })[0]!.text).toBe('Access changes in 1 folder inside.')
  })

  test('the kinds: open, edit, lose, view only', () => {
    const c = (before: Access, after: Access) => ({ before, after }) as Pick<FolderEditChange, 'before' | 'after'>
    expect([kindOf(c('none', 'read')), kindOf(c('none', 'write')), kindOf(c('read', 'write')), kindOf(c('write', 'none')), kindOf(c('read', 'none')), kindOf(c('write', 'read'))]).toEqual(['open', 'open', 'edit', 'lose', 'lose', 'viewOnly'])
  })
})

describe('when Save asks first', () => {
  const stored = draftOf(QUOTES, false).draft
  const raised = (draft: Draft, o: { above?: Access; off?: string[] } = {}) =>
    raisesAccess({ stored, draft, above: o.above ?? 'none', users: new Map([...users].map(([id, u]) => [id, o.off?.includes(id) ? { status: 'disabled' as const } : u])), groups })
  const decide = (draft: Draft, o: { off?: string[] } = {}) => {
    const a = answer(WORLD, 'shared/sales/quotes', rulesOf(draft, { root: false }))
    return saveAsk(a, raised(draft, { above: a.everyoneAbove?.access, off: o.off }))
  }

  test('more access asks; the same, or only less, does not', () => {
    expect(decide({ ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'erin', access: 'read' }] })?.widen).toBe(true)
    expect(decide({ ...stored, basic: 'read' })?.widen).toBe(true)
    expect(decide(stored)).toBeNull()
    expect(decide({ ...stored, named: stored.named.filter((n) => n.subjectId !== 'alice') })?.widen).toBe(true) // Alice: view → edit through Sales
    expect(decide({ ...stored, named: stored.named.map((n) => (n.subjectId === 'sales' ? { ...n, access: 'read' as const } : n)) })).toBeNull()
  })

  test('raised settings count even when nobody is counted for them: a switched-off person, everyone, a "no access" row', () => {
    const off = { ...stored, named: [...stored.named, { subjectType: 'user' as const, subjectId: 'frank', access: 'write' as const }] }
    expect(raised(off, { off: ['frank'] })).toBe(true)
    expect(raised({ ...stored, basic: 'write' })).toBe(true)
    // "same as above" when above gives more than "only people added"
    const shut = { ...stored, basic: 'named' as const }
    expect(raisesAccess({ stored: shut, draft: { ...shut, basic: 'follow' }, above: 'read', users, groups })).toBe(true)
    expect(raisesAccess({ stored: shut, draft: { ...shut, basic: 'follow' }, above: 'none', users, groups })).toBe(false)
    // a "no access" row raised or removed
    const kept: Draft = { ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'frank', access: 'none' }] }
    expect(raisesAccess({ stored: kept, draft: { ...kept, named: kept.named.filter((n) => n.subjectId !== 'frank') }, above: 'none', users, groups })).toBe(true)
    expect(raisesAccess({ stored: kept, draft: { ...kept, named: kept.named.map((n) => (n.subjectId === 'frank' ? { ...n, access: 'read' as const } : n)) }, above: 'none', users, groups })).toBe(true)
    // a row removed for a group with someone switched off in it, while everyone gets more: asks; nobody off: the head count decides
    const viewers = { ...stored, basic: 'write' as const, named: [{ subjectType: 'group' as const, subjectId: 'leads', access: 'read' as const }] }
    const gone = { ...viewers, named: [] }
    expect(raisesAccess({ stored: viewers, draft: gone, above: 'none', users: new Map([...users, ['carol', { status: 'disabled' as const }]]), groups })).toBe(true)
    expect(raisesAccess({ stored: viewers, draft: gone, above: 'none', users, groups })).toBe(false)
  })

  test('the title says open, else edit, else more; narrowing the team\'s own files asks in its own words', () => {
    const a = answer(WORLD, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }, { subjectType: 'user', subjectId: 'frank', access: 'read' }])
    expect(askTitle(en, a, saveAsk(a, true)!)).toBe('Let 2 more people open it?')
    const edit = answer(WORLD, 'shared/sales/quotes', QUOTES.map((r) => (r.subjectId === 'alice' ? { ...r, access: 'write' as Access } : r)))
    expect(askTitle(en, edit, saveAsk(edit, true)!)).toBe('Let 1 person edit it?')
    expect(askTitle(en, { changes: [] }, { widen: true, narrow: [], skillsEveryone: false })).toBe('Give more access?')
    const shut = answer(WORLD, 'shared', [{ subjectType: 'everyone', subjectId: null, access: 'none' }])
    const ask = saveAsk(shut, false)!
    expect(ask.widen).toBe(false)
    expect(ask.narrow.map((w) => w.kind)).toEqual(['team-files'])
    expect(askTitle(en, shut, ask)).toBe('Take access away?')
  })
})

describe('the answer asked again at Save', () => {
  test('the same answer for the same rules; another one when someone above changed, or the folder\'s own rules', () => {
    const a = answer(WORLD, 'shared/sales/quotes', QUOTES)
    expect(sameOutcome(a, answer(WORLD, 'shared/sales/quotes', QUOTES))).toBe(true)
    // another admin opened shared/sales to everyone meanwhile: the folder above gives more now
    expect(sameOutcome(a, answer([...WORLD.filter((r) => !(r.path === 'shared/sales' && r.subject_type === 'everyone')), row('shared/sales', 'everyone', null, 'read')], 'shared/sales/quotes', QUOTES))).toBe(false)
    // and its own rules
    expect(sameOutcome(a, answer([...WORLD, row('shared/sales/quotes', 'user', 'erin', 'read')], 'shared/sales/quotes', QUOTES))).toBe(false)
  })
})

describe('general access', () => {
  test('what "everyone" gets for each choice', () => {
    expect(generalLevel('follow', 'read')).toBe('read')
    expect(generalLevel('named', 'write')).toBe('none')
    expect(generalLevel('read', 'none')).toBe('read')
    expect(generalLevel('write', 'none')).toBe('write')
  })
})
