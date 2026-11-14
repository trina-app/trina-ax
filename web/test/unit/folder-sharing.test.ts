// The Files page's "Who can open it" panel for admins (docs/DECISIONS.md "Who can open it, like Drive's Share";
// web/src/lib/folder-sharing.ts): the rows the folders above give, the plain "what will happen" lines with names, and
// when Save asks before saving. The answers here come from the server's own preview (server/src/admin/access-edit.ts
// editPreview on a RuleSet), so the words are checked against what the permission function says.
import { describe, expect, test } from 'bun:test'
import type { Access, FolderEditChange, FolderEditPreview, Group } from '@mycel/shared/api'
import { RuleSet, type Principal } from '../../../server/src/policy/access'
import { editPreview } from '../../../server/src/admin/access-edit'
import { draftOf, rulesOf, type Draft } from '../../src/lib/access-edit'
import { aboveRows, askTitle, audienceOf, generalLevel, generalLowerOf, hasPanel, lowerOf, pickBasic, inProjects, kindOf, latentLines, namesText, outcomeLines, overridingGroup, overrideText, parentOf, sameOutcome, saveAsk } from '../../src/lib/folder-sharing'
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
    expect(outcomeLines(en, 'en', a, { skills: false }).map((l) => [l.kind, l.text])).toEqual([['viewOnly', 'Erin will no longer be able to edit it']])
    // in skills/, losing edit means no longer changing the team's skills
    expect(outcomeLines(en, 'en', a, { skills: true })[0]!.text).toBe("Erin will no longer be able to change the team's skills")
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
    ...editPreview({ rules: new RuleSet(rows), people, uncounted: off, groupName: (id) => id, personName: (id) => id }, 'shared/sales/quotes', rulesOf(draft, { root: false }), { team: null }),
  }) as FolderEditPreview
  const decide = (draft: Draft, rows = WORLD) => saveAsk(answerFor(draft, rows))

  test('more access asks; the same, or only less, does not', () => {
    expect(decide({ ...stored, named: [...stored.named, { subjectType: 'user', subjectId: 'erin', access: 'read' }] })?.widen).toBe(true)
    expect(decide({ ...stored, basic: 'read' })?.widen).toBe(true)
    expect(decide(stored)).toBeNull()
    expect(decide({ ...stored, named: stored.named.filter((n) => n.subjectId !== 'alice') })?.widen).toBe(true) // Alice: view → edit through Sales
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
    const a = editPreview({ rules: new RuleSet(all), people, groupName: (id) => id, personName: (id) => id }, 'shared/x', [...new RuleSet(all).rulesAt('shared/x').filter((r) => r.subjectType !== 'everyone'), { subjectType: 'everyone', subjectId: null, access: 'write' }], { team: null })
    expect(a.more).toBe(0)
    expect(saveAsk(a)?.later).toBe(true)
  })

  test('the title says open, else edit, else more; narrowing the team\'s own files asks in its own words', () => {
    const a = answer(WORLD, 'shared/sales/quotes', [...QUOTES, { subjectType: 'user', subjectId: 'erin', access: 'read' }, { subjectType: 'user', subjectId: 'frank', access: 'read' }])
    expect(askTitle(en, a, saveAsk(a)!)).toBe('Let 2 more people open it?')
    const edit = answer(WORLD, 'shared/sales/quotes', QUOTES.map((r) => (r.subjectId === 'alice' ? { ...r, access: 'write' as Access } : r)))
    expect(askTitle(en, edit, saveAsk(edit)!)).toBe('Let 1 person edit it?')
    expect(askTitle(en, { changes: [] }, { widen: true, later: true, narrow: [], skillsEveryone: false })).toBe('Give more access?')
    const shut = answer(WORLD, 'shared', [{ subjectType: 'everyone', subjectId: null, access: 'none' }])
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
    editPreview({ rules: new RuleSet(rows), people, uncounted: [gina], groupName: (id) => id[0]!.toUpperCase() + id.slice(1), personName: (id) => id }, 'shared/x', next, { team: null }).latent
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
  test('what "everyone" gets for each choice', () => {
    expect(generalLevel('follow', 'read')).toBe('read')
    expect(generalLevel('named', 'write')).toBe('none')
    expect(generalLevel('read', 'none')).toBe('read')
    expect(generalLevel('write', 'none')).toBe('write')
  })
})

describe('General access as Drive shows it (P1): Restricted or the team with a role, no "Same as"', () => {
  test('the audience of a level', () => {
    expect(audienceOf('none')).toBe('restricted')
    expect(audienceOf('read')).toBe('team')
    expect(audienceOf('write')).toBe('team')
  })
  test('a pick: Restricted is always stored, a team role the folder already follows stays "no setting here", else stored', () => {
    // no setting here, the folder above gives the team Viewer: picking Viewer again stores nothing
    expect(pickBasic('read', { initial: 'follow', above: 'read', canFollow: true })).toBe('follow')
    expect(pickBasic('write', { initial: 'follow', above: 'read', canFollow: true })).toBe('write')
    // set here to Viewer like the folder above: picking Viewer back keeps the setting (nothing changes)
    expect(pickBasic('read', { initial: 'read', above: 'read', canFollow: true })).toBe('read')
    // set here to Editor, Viewer picked: stored here (back to the folder above is its own control, "Use the access of")
    expect(pickBasic('read', { initial: 'write', above: 'read', canFollow: true })).toBe('read')
    // shared/, skills/ and the team root keep a setting of their own
    expect(pickBasic('read', { initial: 'write', above: 'read', canFollow: false })).toBe('read')
  })
  test('review H1: Restricted under a Restricted folder above is stored (everyone: no access), cutting off who that folder lets in', () => {
    // the folder above is Restricted but lists Sales: following it lets Sales in; Restricted here must not
    expect(pickBasic('none', { initial: 'follow', above: 'none', canFollow: true })).toBe('named')
    expect(pickBasic('none', { initial: 'follow', above: 'read', canFollow: true })).toBe('named')
    expect(pickBasic('none', { initial: 'read', above: 'none', canFollow: false })).toBe('named')
    // and the permission function agrees: Sales (Alice) gets in by following, not with "everyone: none" here
    const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'group', 'sales', 'read')]
    const alice = people.find((p) => p.id === 'alice')!
    expect(new RuleSet(rows).access(alice, ['shared', 'Q', 'x.md'])).toBe('read')
    expect(new RuleSet([...rows, row('shared/Q', 'everyone', null, 'none')]).access(alice, ['shared', 'Q', 'x.md'])).toBe('none')
  })
  test('review H2: shared/ or skills/ with no team setting yet (it keeps rows of its own): a team pick is stored', () => {
    expect(pickBasic('read', { initial: 'follow', above: 'read', canFollow: false })).toBe('read')
    expect(pickBasic('write', { initial: 'follow', above: 'write', canFollow: false })).toBe('write')
    expect(pickBasic('none', { initial: 'follow', above: 'none', canFollow: false })).toBe('named')
  })
  test('General access lower than the folder above is said for as long as it is so', () => {
    expect(generalLowerOf('read', { access: 'write', folder: 'shared' })).toEqual({ kind: 'view', folder: 'shared' })
    expect(generalLowerOf('named', { access: 'read', folder: '' })).toEqual({ kind: 'closed', folder: '' })
    expect(generalLowerOf('follow', { access: 'write', folder: 'shared' })).toBeNull()
    expect(generalLowerOf('write', { access: 'write', folder: 'shared' })).toBeNull()
    expect(generalLowerOf('read', { access: 'read', folder: 'shared' })).toBeNull()
    expect(generalLowerOf('named', { access: 'none', folder: null })).toBeNull()
    expect(generalLowerOf('named', null)).toBeNull()
  })
  test('General access lower than a person or group above (not only the team): said with who', () => {
    const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'group', 'sales', 'write')]
    const data = answer(rows, 'shared/Q', [{ subjectType: 'everyone', subjectId: null, access: 'read' }])
    expect(generalLowerOf('read', data.everyoneAbove, { above: data.above })).toEqual({ kind: 'view', folder: 'shared', who: ['Sales'] })
    expect(generalLowerOf('named', data.everyoneAbove, { above: data.above })).toEqual({ kind: 'closed', folder: 'shared', who: ['Sales'] })
    // Sales listed here: its own row decides, nothing to say
    expect(generalLowerOf('read', data.everyoneAbove, { above: data.above, named: new Set(['group:sales']) })).toBeNull()
  })
  test('the line names everyone kept out, and "the folders above" when they come from several (review of #783)', () => {
    const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'user', 'erin', 'read'), row('shared/A', 'user', 'frank', 'read')]
    const one = answer([row('shared', 'everyone', null, 'none'), row('shared', 'user', 'erin', 'read'), row('shared', 'user', 'frank', 'read')], 'shared/Q', [{ subjectType: 'everyone', subjectId: null, access: 'none' }])
    expect(generalLowerOf('named', one.everyoneAbove, { above: one.above })).toEqual({ kind: 'closed', folder: 'shared', who: ['Erin', 'Frank'] })
    expect(en('folderAccess.generalLowerClosedWho', { who: namesText(en, 'en', ['Erin', 'Frank'], 2), folder: 'Company-wide' })).toBe('Erin and Frank can open "Company-wide", but not this folder.')
    const two = answer(rows, 'shared/A/Q', [{ subjectType: 'everyone', subjectId: null, access: 'none' }])
    const got = generalLowerOf('named', two.everyoneAbove, { above: two.above })
    expect(got?.folder).toBeNull()
    expect(got?.who?.sort()).toEqual(['Erin', 'Frank'])
  })
})

describe('a Viewer row lower than what they would get otherwise says so (review A1), and the permission function agrees', () => {
  const groupMap = new Map<string, Group>([
    ['sales', { id: 'sales', name: 'Sales', description: null, memberIds: ['alice', 'bob'] } as Group],
    ['leads', { id: 'leads', name: 'Leads', description: null, memberIds: ['bob', 'carol'] } as Group],
  ])
  type Rule = { subjectType: 'user' | 'group' | 'everyone'; subjectId: string | null; access: Access }
  /** the caption for `who` with these rules on `at`, and the access the permission function gives them with and
   * without that row */
  const check = (rows: Row[], at: string, rules: Rule[], who: { subjectType: 'user' | 'group'; subjectId: string }, person: string) => {
    const data = answer(rows, at, rules)
    const draft = draftOf(rules, false).draft
    const n = draft.named.find((x) => x.subjectType === who.subjectType && x.subjectId === who.subjectId)!
    const lower = lowerOf(draft, n, { groups: groupMap, above: data.above, everyoneAbove: data.everyoneAbove })
    const accessOf = (rs: Rule[]) => new RuleSet([...rows.filter((r) => r.path !== at), ...rs.map((r) => row(at, r.subjectType, r.subjectId, r.access))]).access(people.find((p) => p.id === person)!, `${at}/x.md`.split("/"))
    const without = rules.filter((r) => !(r.subjectType === who.subjectType && r.subjectId === who.subjectId))
    return { lower, with: accessOf(rules), without: accessOf(without) }
  }

  test('a person set to Viewer under a folder where the team can edit (screenshot 08 "Downgrade")', () => {
    const r = check([row('shared', 'everyone', null, 'write')], 'shared/Down', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }], { subjectType: 'user', subjectId: 'erin' }, 'erin')
    expect(r.lower).toEqual({ kind: 'team', folder: 'shared' })
    expect([r.with, r.without]).toEqual(['read', 'write'])
    expect(en('folderAccess.lowerTeamAbove', { team: 'Acme', folder: 'Company-wide' })).toBe('Can only view here, though anyone at Acme can edit "Company-wide"')
  })

  test('a group set to Viewer next to General access team Editor on the same folder', () => {
    const r = check([], 'shared', [{ subjectType: 'group', subjectId: 'sales', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'write' }], { subjectType: 'group', subjectId: 'sales' }, 'alice')
    expect(r.lower).toEqual({ kind: 'team', folder: null })
    expect([r.with, r.without]).toEqual(['read', 'write'])
  })

  test('a person set to Viewer below their group set to Editor on the same folder', () => {
    const r = check([], 'shared/Q', [{ subjectType: 'group', subjectId: 'sales', access: 'write' }, { subjectType: 'user', subjectId: 'alice', access: 'read' }], { subjectType: 'user', subjectId: 'alice' }, 'alice')
    expect(r.lower).toEqual({ kind: 'group', group: 'Sales' })
    expect([r.with, r.without]).toEqual(['read', 'write'])
  })

  test('a person or group set to Viewer where a group above can edit', () => {
    const rows = [row('shared', 'everyone', null, 'read'), row('shared/Sales', 'group', 'sales', 'write')]
    const p = check(rows, 'shared/Sales/Q', [{ subjectType: 'user', subjectId: 'alice', access: 'read' }], { subjectType: 'user', subjectId: 'alice' }, 'alice')
    expect(p.lower).toEqual({ kind: 'groupAbove', group: 'Sales', folder: 'shared/Sales' })
    expect([p.with, p.without]).toEqual(['read', 'write'])
    const g = check(rows, 'shared/Sales/Q', [{ subjectType: 'group', subjectId: 'sales', access: 'read' }], { subjectType: 'group', subjectId: 'sales' }, 'alice')
    expect(g.lower).toEqual({ kind: 'groupAbove', group: 'Sales', folder: 'shared/Sales' })
    expect([g.with, g.without]).toEqual(['read', 'write'])
  })

  test('a group set to Viewer whose member has their own Editor row above: that member is named', () => {
    const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'user', 'bob', 'write')]
    const data = answer(rows, 'shared/Q', [{ subjectType: 'group', subjectId: 'sales', access: 'read' }])
    const draft = draftOf([{ subjectType: 'group', subjectId: 'sales', access: 'read' }], false).draft
    expect(lowerOf(draft, draft.named[0]!, { groups: groupMap, above: data.above, everyoneAbove: data.everyoneAbove, names: (id) => people.find((p) => p.id === id)?.name })).toEqual({ kind: 'groupAbove', group: 'Bob', folder: 'shared' })
    const bob = people.find((p) => p.id === 'bob')!
    expect(new RuleSet([...rows, row('shared/Q', 'group', 'sales', 'read')]).access(bob, ['shared', 'Q', 'x.md'])).toBe('read')
    expect(new RuleSet(rows).access(bob, ['shared', 'Q', 'x.md'])).toBe('write')
  })

  test('the caption names the rule that decides: a deeper group with Viewer wins over a group above with Editor (no caption)', () => {
    // Bob: Leads can edit shared, Sales can only view shared/A (deeper): without his row here he views
    const rows = [row('shared', 'everyone', null, 'none'), row('shared', 'group', 'leads', 'write'), row('shared/A', 'group', 'sales', 'read')]
    const r = check(rows, 'shared/A/Q', [{ subjectType: 'user', subjectId: 'bob', access: 'read' }], { subjectType: 'user', subjectId: 'bob' }, 'bob')
    expect([r.with, r.without]).toEqual(['read', 'read'])
    expect(r.lower).toBeNull()
    // Carol (Leads only): Leads decides for her, Editor: said
    const c = check(rows, 'shared/A/Q', [{ subjectType: 'user', subjectId: 'carol', access: 'read' }], { subjectType: 'user', subjectId: 'carol' }, 'carol')
    expect([c.with, c.without]).toEqual(['read', 'write'])
    expect(c.lower).toEqual({ kind: 'groupAbove', group: 'Leads', folder: 'shared' })
  })

  test('a person set to Viewer where their own row above lets them edit', () => {
    const r = check([row('shared', 'user', 'erin', 'write')], 'shared/Q', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }], { subjectType: 'user', subjectId: 'erin' }, 'erin')
    expect(r.lower).toEqual({ kind: 'selfAbove', folder: 'shared' })
    expect([r.with, r.without]).toEqual(['read', 'write'])
  })

  test('no caption where the row lowers nobody: Viewer where they would view anyway, Editor, Restricted here', () => {
    expect(check([row('shared', 'everyone', null, 'read')], 'shared/Q', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }], { subjectType: 'user', subjectId: 'erin' }, 'erin').lower).toBeNull()
    expect(check([row('shared', 'everyone', null, 'write')], 'shared/Q', [{ subjectType: 'user', subjectId: 'erin', access: 'write' }], { subjectType: 'user', subjectId: 'erin' }, 'erin').lower).toBeNull()
    const closed = check([row('shared', 'everyone', null, 'write')], 'shared/Q', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], { subjectType: 'user', subjectId: 'erin' }, 'erin')
    expect(closed.lower).toBeNull()
    expect([closed.with, closed.without]).toEqual(['read', 'none'])
    // a person in a group set to Viewer here, General access Editor: the group decides first, so the person's Viewer
    // row lowers nothing
    expect(check([], 'shared', [{ subjectType: 'group', subjectId: 'sales', access: 'read' }, { subjectType: 'user', subjectId: 'alice', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'write' }], { subjectType: 'user', subjectId: 'alice' }, 'alice').lower).toBeNull()
  })
})
