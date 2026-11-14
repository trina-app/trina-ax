// The Files page's "Who can open it" panel for admins (docs/DECISIONS.md "Who can open it, like Drive's Share";
// web/src/lib/folder-sharing.ts): the rows the folders above give, the plain "what will happen" lines with names, and
// when Save asks before saving. The answers here come from the server's own preview (server/src/admin/access-edit.ts
// editPreview on a RuleSet), so the words are checked against what the permission function says.
import { describe, expect, test } from 'bun:test'
import type { Access, FolderEditChange, FolderEditPreview } from '@mycel/shared/api'
import { type Principal } from '../../../server/src/policy/access'
import { editPreview } from '../../../server/src/admin/access-edit'
import { draftOf, rulesOf, type Draft } from '../../src/lib/access-edit'
import { aboveRows, askTitle, audienceOf, generalLevel, hasPanel, inheritedOf, pickBasic, pickable, inProjects, kindOf, latentLines, namesText, outcomeLines, parentOf, removedPeople, sameOutcome, saveAsk } from '../../src/lib/folder-sharing'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { ruleWorld, type RuleRow } from '../../../tests/lib/rule-world'

const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
type Row = RuleRow
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
const answer = (rows: Row[], at: string, rules: { subjectType: string; subjectId: string | null; access: Access }[], limited?: boolean): FolderEditPreview => ({
  path: at, exists: true, connected: false,
  ...editPreview({ rules: ruleWorld(rows), people, groupName: (id) => id[0]!.toUpperCase() + id.slice(1), personName: (id) => people.find((p) => p.id === id)?.name ?? id }, at, rules, { team: at === 'shared' ? 'shared' : null, limited }),
})
// "Quotes" (shared/sales/quotes): Sales can edit here, Alice only views; on shared/sales Leads can view and nobody else
const WORLD = [
  row('shared', 'everyone', null, 'read'),
  row('shared/sales', 'group', 'leads', 'read'), row('shared/sales', 'everyone', null, 'none'),
  row('shared/sales/quotes', 'group', 'sales', 'write'), row('shared/sales/quotes', 'user', 'alice', 'read'),
]
const QUOTES = ruleWorld(WORLD).rulesAt('shared/sales/quotes')

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
    // (Limit access since folder access adds up: docs/DECISIONS.md "Folder access adds up like Google Drive (P2)")
    const a = answer(WORLD, 'shared/sales/quotes', QUOTES, true)
    expect(aboveRows(a.next, 'shared/sales/quotes')).toEqual([])
  })

  test('a person a folder above lets in shows too (nobody is kept out by a folder above any more: access adds up)', () => {
    const rows = [...WORLD, row('shared/sales', 'user', 'erin', 'write')]
    const a = answer(rows, 'shared/sales/quotes', QUOTES)
    expect(aboveRows(a.next, 'shared/sales/quotes').map((r) => `${r.name}:${r.access}`)).toEqual(['Leads:read', 'Erin:write'])
  })
})

describe('a person and their group set here', () => {
  test('since P2 the wider of the two decides (access adds up): no "In Sales, but can only view here" line any more', () => {
    const alice = people.find((p) => p.id === 'alice')!
    expect(ruleWorld(WORLD).access(alice, ['shared', 'sales', 'quotes', 'x.md'])).toBe('write')
  })
})

describe('what will happen, by name', () => {
  test('adding a group names who will be able to open it', () => {
    const next = [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' as Access }]
    const a = answer(WORLD, 'shared/sales/quotes', next)
    expect(outcomeLines(en, 'en', a, { skills: false }).map((l) => l.text)).toEqual(['Erin will be able to open it'])
  })

  test('a lower setting here than a folder above gives changes nothing (access adds up); limiting it names who loses', () => {
    const rows = [...WORLD, row('shared/sales', 'user', 'erin', 'write')]
    const a = answer(rows, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }])
    expect(outcomeLines(en, 'en', a, { skills: false }).map((l) => [l.kind, l.text])).toEqual([['none', "No one's access changes."]])
    const lim = answer(rows, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }], true)
    expect(outcomeLines(en, 'en', lim, { skills: false }).map((l) => [l.kind, l.text])).toContainEqual(['viewOnly', 'Erin will no longer be able to edit it'])
    // in skills/, losing edit means no longer changing the team's skills
    expect(outcomeLines(en, 'en', lim, { skills: true }).map((l) => l.text)).toContain("Erin will no longer be able to change the team's skills")
  })

  test('at most three names, then "and N others"; nothing changes: said so', () => {
    expect(namesText(en, 'en', ['Ann', 'Ben'], 2)).toBe('Ann and Ben')
    expect(namesText(en, 'en', ['Ann', 'Ben', 'Cy', 'Di', 'Ed'], 9)).toBe('Ann, Ben, Cy and 6 others')
    expect(namesText(ko, 'ko', ['Ann', 'Ben', 'Cy', 'Di'], 4)).toBe('Ann, Ben, Cy 외 1명')
    expect(namesText(ko, 'ko', ['Ann', 'Ben', 'Cy'], 3)).toBe('Ann, Ben, Cy')
    expect(outcomeLines(en, 'en', { changes: [], below: [] }, { skills: false })).toEqual([{ kind: 'none', text: "No one's access changes." }])
    expect(outcomeLines(en, 'en', { changes: [], below: [{ path: 'a/b', less: 1, more: 0, people: [] }] }, { skills: false })[0]!.text).toBe('Access changes in 1 folder inside.')
  })

  test('the kinds: open, edit, lose, view only', () => {
    const c = (before: Access, after: Access) => ({ before, after }) as Pick<FolderEditChange, 'before' | 'after'>
    expect([kindOf(c('none', 'read')), kindOf(c('none', 'write')), kindOf(c('read', 'write')), kindOf(c('write', 'none')), kindOf(c('read', 'none')), kindOf(c('write', 'read'))]).toEqual(['open', 'open', 'edit', 'lose', 'lose', 'viewOnly'])
  })
})

describe('when Save asks first (from the server\'s answer only)', () => {
  const stored = draftOf(QUOTES, false).draft
  const off: Principal[] = [{ id: 'gina', name: 'Gina', role: 'member', groups: [] }]
  /** the server's answer for the draft, with Gina switched off (not counted) */
  const answerFor = (draft: Draft, rows = WORLD) => ({
    path: 'shared/sales/quotes', exists: true, connected: false,
    ...editPreview({ rules: ruleWorld(rows), people, uncounted: off, groupName: (id) => id, personName: (id) => id }, 'shared/sales/quotes', rulesOf(draft, { root: false }), { team: null }),
  }) as FolderEditPreview
  const decide = (draft: Draft, rows = WORLD) => saveAsk(answerFor(draft, rows))

  test('more access asks; the same, or only less, does not', () => {
    expect(decide({ ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'erin', access: 'read' }] })?.widen).toBe(true)
    expect(decide({ ...stored, basic: 'read' })?.widen).toBe(true)
    expect(decide(stored)).toBeNull()
    // Alice edits through Sales already (access adds up): taking her own row out changes nothing
    expect(decide({ ...stored, named: stored.named.filter((n) => n.subjectId !== 'alice') })).toBeNull()
    expect(decide({ ...stored, named: stored.named.map((n) => (n.subjectId === 'sales' ? { ...n, access: 'read' as const } : n)) })).toBeNull()
  })

  test('adding someone as "can view" who could already edit through a folder above: less, so no confirm', () => {
    const rows = [...WORLD, row('shared/sales', 'user', 'erin', 'write')]
    const ask = decide({ ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'erin', access: 'read' }] }, rows)
    expect(ask).toBeNull()
  })

  test('more access nobody is counted for asks too, said as such: someone switched off, an empty group, everyone', () => {
    const gina = decide({ ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'gina', access: 'read' }] })
    expect(gina).toEqual({ widen: true, later: true, narrow: [], skillsEveryone: false })
    expect(decide({ ...stored, named: [...stored.named, { subjectType: 'group', subjectId: 'nobody-yet', access: 'write' }] })?.later).toBe(true)
    // everyone may edit while every member today already can: only those who join later gain
    const all = [row('shared/x', 'group', 'sales', 'write'), row('shared/x', 'group', 'leads', 'write'), row('shared/x', 'user', 'erin', 'write'), row('shared/x', 'user', 'frank', 'write'), row('shared/x', 'everyone', null, 'none')]
    const a = editPreview({ rules: ruleWorld(all), people, groupName: (id) => id, personName: (id) => id }, 'shared/x', [...ruleWorld(all).rulesAt('shared/x').filter((r) => r.subjectType !== 'everyone'), { subjectType: 'everyone', subjectId: null, access: 'write' }], { team: null })
    expect(a.more).toBe(0)
    expect(saveAsk(a)?.later).toBe(true)
  })

  test('the title says open, else edit, else more; narrowing the team\'s own files asks in its own words', () => {
    const a = answer(WORLD, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }, { subjectType: 'user', subjectId: 'frank', access: 'read' }])
    expect(askTitle(en, a, saveAsk(a)!)).toBe('Let 2 more people open it?')
    const edit = answer(WORLD, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'carol', access: 'write' as Access }])
    expect(askTitle(en, edit, saveAsk(edit)!)).toBe('Let 1 person edit it?')
    expect(askTitle(en, { changes: [] }, { widen: true, later: true, narrow: [], skillsEveryone: false })).toBe('Give more access?')
    const shut = answer(WORLD, 'shared', [], true)
    const ask = saveAsk(shut)!
    expect(ask.widen).toBe(false)
    expect(ask.narrow.map((w) => w.kind)).toEqual(['team-files'])
    expect(askTitle(en, shut, ask)).toBe('Take access away?')
  })
})

describe('who gains later, in the confirm (QA TC-232)', () => {
  const gina: Principal = { id: 'gina', name: 'Gina', role: 'member', groups: [] }
  const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'user', 'gina', 'none')]
  const latentOf = (next: { subjectType: string; subjectId: string | null; access: Access }[]) =>
    editPreview({ rules: ruleWorld(rows), people, uncounted: [gina], groupName: (id) => id[0]!.toUpperCase() + id.slice(1), personName: (id) => id }, 'shared/x', next, { team: null }).latent
  test('a change that only lets them view says "open", never "open or edit"', () => {
    const lines = latentLines(en, 'en', latentOf([{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'group', subjectId: 'design', access: 'read' }]), 'Acme')
    expect(lines).toEqual([
      'Gina (switched off) will be able to open it when switched back on.',
      'People added to Design later will be able to open it.',
      'People who join Acme later will be able to open it.',
    ])
  })
  test('a change that lets them edit says "open or edit"; an answer that does not say (an older server) too', () => {
    const edit = latentOf([{ subjectType: 'group', subjectId: 'design', access: 'write' }])
    expect(latentLines(en, 'en', edit, 'Acme')).toEqual(['People added to Design later will be able to open or edit it.'])
    const view = latentOf([{ subjectType: 'group', subjectId: 'design', access: 'read' }])
    expect(latentLines(en, 'en', view, 'Acme')).toEqual(['People added to Design later will be able to open it.'])
    // an older server: no `edit` at all, and no group's own
    const { edit: _, ...older } = view!
    expect(latentLines(en, 'en', { ...older, groups: older.groups.map(({ id, name }) => ({ id, name })) }, 'Acme')).toEqual(['People added to Design later will be able to open or edit it.'])
    expect(latentLines(en, 'en', null, 'Acme')).toEqual([])
  })
  test('one group gets edit, another only view: each said as it is (QA TC-284)', () => {
    const both = latentOf([{ subjectType: 'group', subjectId: 'design', access: 'write' }, { subjectType: 'group', subjectId: 'ops', access: 'read' }])
    expect(latentLines(en, 'en', both, 'Acme')).toEqual([
      'People added to Design later will be able to open or edit it.',
      'People added to Ops later will be able to open it.',
    ])
    // an older server's answer without a group's own edit: one line, "open or edit", as before
    expect(latentLines(en, 'en', { ...both!, groups: both!.groups.map(({ id, name }) => ({ id, name })) }, 'Acme')).toEqual(['People added to Design and Ops later will be able to open or edit it.'])
  })
  test('Korean: no particle that depends on the name (no "이(가)", "은(는)", "(으)로" or "을(를)" after a name)', () => {
    const lines = [
      ...latentLines(ko, 'ko', latentOf([{ subjectType: 'everyone', subjectId: null, access: 'write' }]), 'Acme'),
      ...latentLines(ko, 'ko', latentOf([{ subjectType: 'everyone', subjectId: null, access: 'read' }]), 'Acme'),
      ...(['willOpen', 'willEdit', 'willLose', 'willViewOnly', 'willLoseSkills'] as const).map((k) => ko(`folderAccess.${k}`, { names: 'Dan' })),
      ko('folderAccess.levelOf', { name: 'Dan' }), ko('folderAccess.backTo', { folder: 'Sales' }), ko('folderAccess.warnTeamFiles', { folder: 'Sales' }),
    ]
    expect(lines.length).toBeGreaterThan(8)
    for (const l of lines) expect([l, /이\(가\)|은\(는\)|\(으\)로|을\(를\)|\(이\)|\(가\)/.test(l)]).toEqual([l, false])
    expect(ko('folderAccess.willOpen', { names: 'Dan' })).toBe('열 수 있게 되는 사람: Dan')
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
  test('what the team gets for each choice: its own setting, plus the folders above unless the folder is limited', () => {
    expect(generalLevel('follow', false, 'read')).toBe('read')
    expect(generalLevel('named', false, 'write')).toBe('write')
    expect(generalLevel('named', true, 'write')).toBe('none')
    expect(generalLevel('read', false, 'none')).toBe('read')
    expect(generalLevel('read', false, 'write')).toBe('write')
    expect(generalLevel('read', true, 'write')).toBe('read')
    expect(generalLevel('write', false, 'none')).toBe('write')
  })
})

describe('General access as Drive shows it (P2): Restricted or the team with a role; lower than above needs Limit access', () => {
  test('the audience of a level', () => {
    expect(audienceOf('none')).toBe('restricted')
    expect(audienceOf('read')).toBe('team')
    expect(audienceOf('write')).toBe('team')
  })
  test('a pick: back to what the folder had keeps it; equal to what comes from above stores nothing; Restricted stores no team setting', () => {
    expect(pickBasic('read', { initial: 'follow', limited: false, above: 'read' })).toBe('follow')
    expect(pickBasic('write', { initial: 'follow', limited: false, above: 'read' })).toBe('write')
    expect(pickBasic('read', { initial: 'read', limited: false, above: 'read' })).toBe('read')
    expect(pickBasic('read', { initial: 'write', limited: true, above: 'write' })).toBe('read')
    expect(pickBasic('none', { initial: 'read', limited: false, above: 'none' })).toBe('follow')
    expect(pickBasic('none', { initial: 'read', limited: true, above: 'read' })).toBe('named')
    expect(pickBasic('none', { initial: 'named', limited: true, above: 'read' })).toBe('named')
  })
  test('what can be picked: nothing lower than above on a folder that is not limited; anything once limited', () => {
    expect(pickable('read', { limited: false, above: 'write' })).toBe(false)
    expect(pickable('none', { limited: false, above: 'read' })).toBe(false)
    expect(pickable('write', { limited: false, above: 'read' })).toBe(true)
    expect(pickable('read', { limited: false, above: 'read' })).toBe(true)
    expect(pickable('none', { limited: true, above: 'write' })).toBe(true)
  })
  test('the permission function agrees: Restricted on a folder that is not limited keeps out nobody the folder above lets in', () => {
    const rows = [row('shared', 'everyone', null, 'read')]
    const erin = people.find((p) => p.id === 'erin')!
    expect(ruleWorld([...rows, row('shared/Q', 'user', 'frank', 'read')]).access(erin, ['shared', 'Q', 'x.md'])).toBe('read')
  })
})

describe('a person or group row and what it gets from the folders above (P2: "Editor from …")', () => {
  test('the widest rule above that applies, with its folder; a role below it cannot be picked', () => {
    const rows = [row('shared', 'everyone', null, 'read'), row('shared/Sales', 'group', 'sales', 'write')]
    const data = answer(rows, 'shared/Sales/Q', [{ subjectType: 'user', subjectId: 'alice', access: 'read' }])
    // Alice is in Sales, but a person counts only their own rules and the team's (re-review of #787): Viewer from shared
    expect(inheritedOf(data.above, { subjectType: 'user', subjectId: 'alice' })).toEqual({ access: 'read', folder: 'shared' })
    expect(inheritedOf(data.above, { subjectType: 'group', subjectId: 'sales' })).toEqual({ access: 'write', folder: 'shared/Sales' })
    expect(inheritedOf(data.above, { subjectType: 'user', subjectId: 'erin' })).toEqual({ access: 'read', folder: 'shared' })
    expect(inheritedOf(data.above, { subjectType: 'group', subjectId: 'leads' })).toEqual({ access: 'read', folder: 'shared' })
    expect(en('folderAccess.fromAbove', { role: en('access.write'), folder: 'Sales' })).toContain('Sales')
  })
  test('nothing from above: null', () => {
    const data = answer([row('shared', 'everyone', null, 'none')], 'shared/Q', [])
    expect(inheritedOf(data.above, { subjectType: 'user', subjectId: 'erin' })).toBeNull()
    expect(inheritedOf(null, { subjectType: 'user', subjectId: 'erin' })).toBeNull()
  })
  test('and the permission function: a Viewer row under an Editor folder lowers nobody (access adds up)', () => {
    const rows = [row('shared', 'everyone', null, 'write')]
    const erin = people.find((p) => p.id === 'erin')!
    expect(ruleWorld([...rows, row('shared/Down', 'user', 'erin', 'read')]).access(erin, ['shared', 'Down', 'x.md'])).toBe('write')
  })
})

describe('Access removed on a limited folder (Drive)', () => {
  test('people who open the folder above but are stopped by this limit, by name; not those cut higher up or named here', () => {
    const here = [
      { user: { id: 'erin', name: 'Erin' }, access: 'none' as Access, reason: { kind: 'no-rule', cutAt: 'shared/Q' } },
      { user: { id: 'bob', name: 'Bob' }, access: 'none' as Access, reason: { kind: 'no-rule', cutAt: 'shared/Q' } },
      { user: { id: 'frank', name: 'Frank' }, access: 'none' as Access, reason: { kind: 'no-rule', cutAt: 'shared' } },
      { user: { id: 'alice', name: 'Alice' }, access: 'read' as Access, reason: { kind: 'rule' } },
      { user: { id: 'carol', name: 'Carol' }, access: 'none' as Access, reason: { kind: 'no-rule', cutAt: 'shared/Q' } },
    ]
    const above = [{ user: { id: 'erin' }, access: 'read' as Access }, { user: { id: 'bob' }, access: 'write' as Access }, { user: { id: 'frank' }, access: 'read' as Access }, { user: { id: 'alice' }, access: 'read' as Access }, { user: { id: 'carol' }, access: 'none' as Access }]
    expect(removedPeople(here, above, 'shared/Q')).toEqual([{ id: 'bob', name: 'Bob' }, { id: 'erin', name: 'Erin' }])
  })
})
