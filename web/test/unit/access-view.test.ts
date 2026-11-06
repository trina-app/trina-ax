// Admin › Folder permissions › By person: the words for the server's answer (web/src/lib/access-view.ts). The level and
// the reason of each row, the groups, the one-sentence summary, and that no step name of the permission function
// (user / group / role / everyone, owner-admin, no-rule …) reaches the screen in any language.
import { describe, expect, test } from 'bun:test'
import type { AccessTreeNode, PersonFolderAccess } from '@mycel/shared/api'
import { DICTS, translate, type MessageKey, type Params } from '../../src/i18n'
import { ancestorsOf, cleanPrefix, isSkillsPath, countRows, folderName, groupRows, isRestricted, kindText, levelOf, nearestRuleFolder, nodeName, parentOf, reasonText, riskOf, riskTexts, rulesApply, sectionOf, shortPath, skillEditorsText, skillManagersOf, skillsLockedText, sourceSaysSomething, sourceText, summaryLines, whoSeesText, type Names } from '../../src/lib/access-view'
import { skillsVia } from '../../src/pages/admin/SkillManagers'
import { personViewLink } from '../../src/pages/admin/AccessResults'

const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const names: Names = { group: (id) => ({ g1: 'Sales', g2: '재무팀' } as Record<string, string>)[id], person: (id) => ({ bob: 'Bob' } as Record<string, string>)[id] }
/** the folders with rules on the team (Admin › Folder permissions' list) */
const known = (...paths: string[]): Names => ({ ...names, ruleFolders: new Set(paths) })

const row = (path: string, o: Partial<PersonFolderAccess> = {}): PersonFolderAccess => ({
  path, kinds: ['top'], exists: true, access: 'read', reason: { kind: 'no-rule' }, listable: true, via: [], viaMore: false, ...o,
})
const rule = (folder: string, tier: 'user' | 'group' | 'role' | 'everyone', rules: { subjectType: 'user' | 'group' | 'role' | 'everyone'; subjectId: string | null; access: 'none' | 'read' | 'write' }[]) =>
  ({ kind: 'rule' as const, folder, tier, rules })
/** the reason lines of a row, as one string */
const why = (t: typeof ko, f: PersonFolderAccess, role: 'owner' | 'admin' | 'member' = 'member', n: Names = names) => reasonText(t, f, role, n).join(' | ')

describe('level', () => {
  test('write and read as they are; no access but shown on the way is "listed"; else none', () => {
    expect(levelOf(row('a', { access: 'write' }))).toBe('write')
    expect(levelOf(row('a', { access: 'read' }))).toBe('read')
    expect(levelOf(row('a', { access: 'none', listable: true }))).toBe('listed')
    expect(levelOf(row('a', { access: 'none', listable: false }))).toBe('none')
    expect(ko('accessView.level.listed')).toBe('이름만 보임')
  })
})

describe('reasons, in words', () => {
  test('a rule on this folder names who it is for and what it gives', () => {
    const f = row('groups/Sales', { access: 'write', kinds: ['group', 'rules'], reason: rule('groups/Sales', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'write' }]) })
    expect(why(ko, f)).toBe('이 폴더의 규칙 · Sales 그룹: 읽기·쓰기')
    expect(why(en, f)).toBe('Rule on this folder · Group Sales: Read & write')
  })

  test('inherited: the folder it comes from, who and what; the root by its one name', () => {
    const f = row('shared/notes', { access: 'write', reason: rule('shared', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'write' }]) })
    expect(why(ko, f)).toBe('shared에서 물려받음 · 모두: 읽기·쓰기')
    const r = row('docs', { reason: rule('', 'role', [{ subjectType: 'role', subjectId: 'member', access: 'read' }]) })
    expect(why(ko, r)).toBe('팀 폴더 맨 위에서 물려받음 · 팀원 전체: 읽기')
    expect(folderName(ko, '')).toBe(ko('accessView.rootFolder'))
  })

  test('a person rule names the person; the widest of several group rules (listed first) is the one named', () => {
    const p = row('finance', { access: 'read', reason: rule('finance', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'read' }]) })
    expect(why(ko, p)).toBe('이 폴더의 규칙 · Bob 님: 읽기')
    const g = row('finance', { access: 'write', reason: rule('finance', 'group', [{ subjectType: 'group', subjectId: 'g2', access: 'write' }, { subjectType: 'group', subjectId: 'g1', access: 'read' }]) })
    expect(why(ko, g)).toBe('이 폴더의 규칙 · 재무팀 그룹: 읽기·쓰기')
  })

  test('a rule that gives nothing says so', () => {
    const f = row('secret', { access: 'none', listable: false, reason: rule('secret', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'none' }]) })
    expect(why(ko, f)).toBe('이 폴더의 규칙 · 모두: 권한 없음')
  })

  test('owner and admins: everything but other people\'s personal folders; rules are not offered there', () => {
    const f = row('docs', { access: 'write', reason: { kind: 'owner-admin' } })
    expect(why(ko, f, 'admin')).toBe('관리자라서 다른 사람의 개인 폴더 말고는 모두 볼 수 있어요')
    expect(why(ko, f, 'owner')).toBe('팀장이라서 다른 사람의 개인 폴더 말고는 모두 볼 수 있어요')
    expect(rulesApply(f)).toBe(false)
    expect(rulesApply(row('docs', { reason: rule('docs', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'read' }]) }))).toBe(true)
    expect(rulesApply(row('users/bob', { kinds: ['personal'], reason: { kind: 'own-personal' } }))).toBe(false)
  })

  test('no rule for this person is not "no rule": a rule for others on the folder or above is told apart', () => {
    const none = { access: 'none' as const, listable: false }
    // finance carries "재무팀: read"; Bob is not in it
    expect(why(ko, row('finance', none), 'member', known('finance'))).toBe('이 폴더부터 위쪽 규칙은 이 사람에게 해당하지 않아요')
    expect(why(ko, row('finance/2026', none), 'member', known('finance'))).toBe('finance부터 위쪽 규칙은 이 사람에게 해당하지 않아요')
    expect(why(ko, row('docs', none), 'member', known('', 'finance'))).toBe('팀 폴더 맨 위의 규칙은 이 사람에게 해당하지 않아요')
    // no folder on the way up carries any rule: only the owner and admins
    expect(why(ko, row('docs', none), 'member', known('finance'))).toBe('규칙이 없어 팀장과 관리자만 열 수 있어요')
    // the folder list is not known (yet): only what is sure
    expect(why(ko, row('docs', none))).toBe('이 사람에게 해당하는 규칙이 없어요')
    expect(nearestRuleFolder('a/b/c', new Set(['a', '']))).toBe('a')
    expect(nearestRuleFolder('a/b', new Set())).toBeNull()
  })

  test('shown on the way: the folders below that make it so, two named and the rest counted, then what decided', () => {
    const base = { access: 'none' as const, listable: true }
    expect(reasonText(ko, row('projects', { ...base, via: ['projects/apollo'] }), 'member', known())).toEqual(['아래 projects/apollo 때문에 폴더 이름만 보여요', '규칙이 없어 팀장과 관리자만 열 수 있어요'])
    expect(reasonText(ko, row('projects', { ...base, via: ['projects/a', 'projects/b', 'projects/c', 'projects/d'] }), 'member', names)[0]).toBe('아래 projects/a, projects/b 외 2곳 때문에 폴더 이름만 보여요')
    expect(reasonText(ko, row('projects', { ...base, via: Array.from({ length: 20 }, (_, i) => `projects/p${i}`), viaMore: true }), 'member', names)[0]).toBe('아래 projects/p0, projects/p1 외 여러 곳 때문에 폴더 이름만 보여요')
    // an explicit "no access" stays in sight under the way
    const denied = row('projects', { ...base, via: ['projects/apollo'], reason: rule('projects', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'none' }]) })
    expect(reasonText(ko, denied, 'member', names)).toEqual(['아래 projects/apollo 때문에 폴더 이름만 보여요', '이 폴더의 규칙 · 모두: 권한 없음'])
    // a readable folder below that may not be named (a forgotten rule row): still why it shows
    expect(reasonText(ko, row('x', { ...base, via: [] }), 'member', names)[0]).toBe('아래에 볼 수 있는 폴더가 있어 폴더 이름만 보여요')
    expect(reasonText(en, row('projects', { ...base, via: ['projects/apollo'] }), 'member', names)[0]).toBe('Only the name shows, on the way to projects/apollo below')
  })

  test('the own folder in the way is named in words, never as users/<id>; the root of someone new is on the way to theirs', () => {
    const base = { access: 'none' as const, listable: true }
    expect(reasonText(ko, row('', { ...base, kinds: ['rules'], via: ['users/bob'] }), 'member', names)[0]).toBe('본인 개인 폴더로 가는 길이라 폴더 이름만 보여요')
    expect(reasonText(ko, row('', { ...base, kinds: ['rules'], via: ['shared', 'users/bob'] }), 'member', names)[0]).toBe('아래 shared, 본인 개인 폴더 때문에 폴더 이름만 보여요')
    // someone new: the server names no own folder (there is none yet), the root still shows the way to it
    expect(reasonText(ko, row('', { ...base, kinds: ['rules'], via: [] }), 'member', names)[0]).toBe('본인 개인 폴더로 가는 길이라 폴더 이름만 보여요')
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const t = (key: MessageKey, p?: Params) => translate(locale, key, p)
      expect(reasonText(t, row('', { ...base, via: ['marketing', 'users/bob'] }), 'member', names).join(' ')).not.toContain('users/')
    }
  })

  test('the own folder, said for the role: the owner and admins are not "the owner and admins" of their own folder', () => {
    const own = row('users/olga', { kinds: ['personal'], exists: null, access: 'write', reason: { kind: 'own-personal' } })
    expect(why(ko, own, 'member')).toBe('본인만 · 팀장과 관리자도 못 봐요')
    expect(why(ko, own, 'owner')).toBe('본인만 · 관리자도 못 봐요')
    expect(why(ko, own, 'admin')).toBe('본인만 · 팀장과 다른 관리자도 못 봐요')
  })

  test('no step name of the permission function in any language', () => {
    const rows: PersonFolderAccess[] = [
      row('a', { access: 'write', reason: rule('a', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'write' }]) }),
      row('a/b', { reason: rule('a', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'read' }]) }),
      row('c', { reason: rule('', 'role', [{ subjectType: 'role', subjectId: 'member', access: 'read' }]) }),
      row('d', { access: 'none', listable: false, reason: rule('d', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'none' }]) }),
      row('e', { access: 'write', reason: { kind: 'owner-admin' } }),
      row('f', { access: 'none', listable: false, reason: { kind: 'no-rule' } }),
      row('g', { access: 'none', listable: true, via: ['g/h'], reason: { kind: 'no-rule' } }),
      row('users/bob', { kinds: ['personal'], access: 'write', reason: { kind: 'own-personal' } }),
    ]
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const t = (key: MessageKey, p?: Params) => translate(locale, key, p)
      for (const n of [names, known('f', 'g'), known('')]) {
        for (const f of rows) {
          for (const role of ['owner', 'admin', 'member'] as const) {
            const text = reasonText(t, f, role, n).join(' ')
            expect(text).not.toMatch(/\b(user|group|role|everyone|owner-admin|no-rule|tier|own-personal)\b/)
            expect(text).not.toMatch(/\{\w+\}/)
          }
        }
      }
    }
  })
})

describe('groups and paths', () => {
  test('kinds first, then the folder that holds such folders; skills apart; the own folder last', () => {
    expect(sectionOf(row('shared'))).toBe('team')
    expect(sectionOf(row('', { kinds: ['rules'] }))).toBe('team')
    expect(sectionOf(row('groups'))).toBe('group')
    expect(sectionOf(row('groups/Sales', { kinds: ['group', 'rules'] }))).toBe('group')
    expect(sectionOf(row('work/apollo', { kinds: ['project'] }))).toBe('project')
    expect(sectionOf(row('projects'))).toBe('project')
    expect(sectionOf(row('connected/nas', { kinds: ['connected'] }))).toBe('connected')
    expect(sectionOf(row('skills/finance', { kinds: ['rules'] }))).toBe('skills')
    expect(sectionOf(row('users/bob', { kinds: ['personal'] }))).toBe('personal')
    expect(groupRows([row('users/bob', { kinds: ['personal'] }), row('skills'), row('docs'), row('groups/A', { kinds: ['group'] })]).map((g) => g.section)).toEqual(['team', 'group', 'skills', 'personal'])
  })

  test('long paths keep the first folder and the last two; the root is named', () => {
    expect(shortPath('projects/2026/clients/acme/contracts', 'ROOT')).toBe('projects/…/acme/contracts')
    expect(shortPath('a/b/c', 'ROOT')).toBe('a/b/c')
    expect(shortPath('', 'ROOT')).toBe('ROOT')
  })

  test('a member who can write in skills/ is marked; owner and admins and read are not', () => {
    expect(riskOf(row('skills', { access: 'write' }), 'member')).toBe('skills')
    expect(riskOf(row('skills/finance', { access: 'write' }), 'member')).toBe('skills')
    expect(riskOf(row('skills', { access: 'read' }), 'member')).toBeNull()
    expect(riskOf(row('skills', { access: 'write' }), 'admin')).toBeNull()
    expect(riskOf(row('skillset', { access: 'write' }), 'member')).toBeNull()
  })

  test('a typed folder (or one in the address) becomes the server\'s path; not a path: null', () => {
    expect(cleanPrefix(' /projects/apollo/ ')).toBe('projects/apollo')
    expect(cleanPrefix('projects//apollo')).toBe('projects/apollo')
    expect(cleanPrefix('  ')).toBe('')
    expect(cleanPrefix('../x')).toBeNull()
    expect(cleanPrefix('a\\b')).toBeNull()
    expect(cleanPrefix('a'.repeat(1025))).toBeNull()
  })

  test('the address keeps the choice', () => {
    expect(personViewLink({ person: 'bob' })).toBe('/admin/folders?view=people&person=bob')
    expect(personViewLink({ newPerson: { role: 'admin', groupIds: ['g1', 'g2'] } })).toBe('/admin/folders?view=people&new=1&role=admin&groups=g1%2Cg2')
    expect(personViewLink({ newPerson: { role: 'member', groupIds: [] }, prefix: 'projects' })).toBe('/admin/folders?view=people&new=1&prefix=projects')
  })
})

describe('summary', () => {
  const rows = [
    row('docs', { access: 'write' }),
    row('shared', { access: 'read' }),
    row('skills', { access: 'read' }),
    row('projects', { access: 'none', listable: true, via: ['projects/apollo'] }),
    row('projects/apollo', { access: 'write', kinds: ['project'] }),
    row('secret', { access: 'none', listable: false }),
    row('users/bob', { kinds: ['personal'], access: 'write', reason: { kind: 'own-personal' } }),
  ]
  test('team folders seen and written (the own folder is not one), names only, hidden', () => {
    expect(countRows(rows)).toEqual({ see: 4, write: 2, listed: 1, hidden: 1 })
  })

  test('one sentence, then what it leaves out', () => {
    const page = { total: rows.length, nextCursor: null }
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: false }, rows, page)).toEqual([
      'Bob 님과 그 AI는 팀 폴더 4개를 볼 수 있고, 그중 2개에 쓸 수 있어요.',
      '폴더 이름만 보이는 곳이 1개 더 있어요.',
    ])
    expect(summaryLines(en, { kind: 'person', name: 'Bob', off: false }, rows, page)[0]).toBe('Bob and their AI can see 4 team folders and write to 2 of them.')
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: true }, rows, page)[0]).toBe('다시 활성화하면 Bob 님과 그 AI는 팀 폴더 4개를 볼 수 있고, 그중 2개에 쓸 수 있어요.')
    expect(summaryLines(ko, { kind: 'new' }, rows, page)[0]).toBe('새로 들어올 사람과 그 AI는 팀 폴더 4개를 볼 수 있고, 그중 2개에 쓸 수 있어요.')
  })

  test('narrowed to one folder: the sentence says where', () => {
    expect(summaryLines(ko, { kind: 'new' }, rows.slice(3, 5), { total: 2, nextCursor: null }, 'projects')[0]).toBe('projects 안에서는 새로 들어올 사람과 그 AI는 팀 폴더 1개를 볼 수 있고, 그중 1개에 쓸 수 있어요.')
    expect(summaryLines(en, { kind: 'person', name: 'Bob', off: false }, rows.slice(3, 5), { total: 2, nextCursor: null }, 'projects')[0]).toBe('Within projects: Bob and their AI can see 1 team folder and write to 1 of them.')
  })

  test('nothing seen; more pages to come; sees some and writes none', () => {
    const none = [row('secret', { access: 'none', listable: false })]
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: false }, none, { total: 1, nextCursor: null })).toEqual(['Bob 님과 그 AI가 볼 수 있는 팀 폴더는 없어요.'])
    expect(summaryLines(en, { kind: 'new' }, rows, { total: 900, nextCursor: 'skills' }).at(-1)).toBe('Counted from the 7 of 900 folders loaded so far.')
    expect(summaryLines(en, { kind: 'person', name: 'Bob', off: false }, [row('docs', { access: 'read' })], { total: 1, nextCursor: null })[0]).toBe('Bob and their AI can see 1 team folder but cannot write to any.')
    expect(summaryLines(ko, { kind: 'new' }, [row('docs', { access: 'read' }), row('a', { access: 'read' })], { total: 2, nextCursor: null })[0]).toBe('새로 들어올 사람과 그 AI는 팀 폴더 2개를 볼 수 있고, 쓸 수 있는 곳은 없어요.')
  })
})

describe('stage 3 review: someone new, and users/ narrowed to', () => {
  test('the root of someone new is the way to the personal folder they will have once they join', () => {
    const root = row('', { kinds: ['rules'], access: 'none', listable: true, via: [], reason: { kind: 'no-rule' } })
    expect(reasonText(ko, root, 'member', names, { newPerson: true })[0]).toBe('들어오면 생길 개인 폴더로 가는 길이라 폴더 이름만 보여요')
    expect(reasonText(en, root, 'member', names, { newPerson: true })[0]).toBe('Only the name shows, on the way to the personal folder they will have once they join')
    // a member's own folder below the root is said as theirs
    expect(reasonText(ko, { ...root, via: ['users/bob'] }, 'member', names)[0]).toBe('본인 개인 폴더로 가는 길이라 폴더 이름만 보여요')
  })

  test('narrowed to users/: the sentence names the own folder (the counts leave it out)', () => {
    const own = [row('users/bob', { kinds: ['personal'], access: 'write', reason: { kind: 'own-personal' } })]
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: false }, own, { total: 1, nextCursor: null }, 'users')[0]).toBe('users 안에는 Bob 님의 개인 폴더만 있어요. 본인과 그 AI만 볼 수 있어요.')
    expect(summaryLines(en, { kind: 'person', name: 'Bob', off: false }, own, { total: 1, nextCursor: null }, 'users/bob')[0]).toBe("Within users/bob there is only Bob's personal folder. Only they and their AI can see it.")
    // elsewhere as before
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: false }, own, { total: 1, nextCursor: null })[0]).toBe('Bob 님과 그 AI가 볼 수 있는 팀 폴더는 없어요.')
  })
})

describe('the folder tree (by folder)', () => {
  type Who = AccessTreeNode['who'][number]
  const w = (o: Partial<Who> & Pick<Who, 'access' | 'count'>): Who => ({ reason: 'rule', folder: '', subject: null, ...o })
  const staff = w({ reason: 'owner-admin', folder: null, access: 'write', count: 2 })
  const node = (path: string, who: Who[], o: Partial<AccessTreeNode> = {}): AccessTreeNode => ({ name: path.split('/').pop() ?? '', path, kinds: [], rules: 0, folders: false, marked: 0, who: [staff, ...who], risks: [], restricted: false, ...o })
  const sales = { type: 'group' as const, id: 'g1', name: '영업팀' }
  const all = { type: 'everyone' as const, id: null, name: null }

  test('who sees it: by group with how many, everyone, the rest, a person; only the owner and admins', () => {
    const n = node('groups/영업팀', [w({ folder: 'groups/영업팀', subject: sales, access: 'write', count: 3 }), w({ folder: 'shared', subject: all, access: 'read', count: 9 })])
    expect(whoSeesText(ko, n, 12)).toBe('영업팀 3명 · 읽기·쓰기, 그 밖의 9명 · 읽기')
    expect(whoSeesText(en, n, 12)).toBe('영업팀: 3 people · Read & write, 9 others · Read')
    expect(whoSeesText(ko, node('shared', [w({ folder: 'shared', subject: all, access: 'write', count: 12 })]), 12)).toBe('모두 · 읽기·쓰기')
    expect(whoSeesText(ko, node('docs', [w({ reason: 'no-rule', folder: null, access: 'none', count: 12 })]), 12)).toBe('팀장과 관리자만')
    expect(whoSeesText(ko, node('secret', [w({ folder: 'secret', subject: all, access: 'none', count: 12 })]), 12)).toBe('팀장과 관리자만')
    expect(whoSeesText(ko, node('a', [w({ folder: 'a', subject: { type: 'user', id: 'bob', name: 'Bob' }, access: 'write', count: 1 })]), 12)).toBe('Bob 님 · 읽기·쓰기')
    expect(whoSeesText(ko, node('a', [w({ folder: '', subject: { type: 'role', id: 'member', name: null }, access: 'read', count: 12 })]), 12)).toBe('팀원 전체 · 읽기')
    // more than three groups: the rest counted
    const many = node('a', ['g1', 'g2', 'g3', 'g4', 'g5'].map((g, i) => w({ folder: 'a', subject: { type: 'group', id: g, name: `G${i}` }, access: 'read', count: 1 })))
    expect(whoSeesText(ko, many, 12)).toBe('G0 1명 · 읽기, G1 1명 · 읽기, G2 1명 · 읽기 외 2명')
    expect(whoSeesText(en, many, 12)).toBe('G0: 1 person · Read, G1: 1 person · Read, G2: 1 person · Read and 2 others')
  })

  test('where it comes from: this folder, a folder above (the root by name), by whom when it differs, no rule', () => {
    expect(sourceText(ko, node('a', [w({ folder: 'a', subject: sales, access: 'read', count: 3 })]), 12)).toBe('이 폴더의 규칙')
    expect(sourceText(ko, node('shared/x', [w({ folder: 'shared', subject: all, access: 'write', count: 12 })]), 12)).toBe('shared에서 물려받음')
    expect(sourceText(ko, node('docs', [w({ folder: '', subject: all, access: 'read', count: 12 })]), 12)).toBe('팀 폴더 맨 위에서 물려받음')
    const mixed = node('groups/영업팀', [w({ folder: 'groups/영업팀', subject: sales, access: 'write', count: 3 }), w({ folder: 'shared', subject: all, access: 'read', count: 9 })])
    expect(sourceText(ko, mixed, 12)).toBe('영업팀: 이 폴더의 규칙 · 나머지: shared에서 물려받음')
    // nobody gets in: the folder whose rule shuts them out
    expect(sourceText(ko, node('secret', [w({ folder: 'secret', subject: all, access: 'none', count: 12 })]), 12)).toBe('이 폴더의 규칙')
    expect(sourceText(ko, node('docs', [w({ reason: 'no-rule', folder: null, access: 'none', count: 12 })]), 12)).toBe('팀원에게 맞는 규칙 없음')
    expect(sourceText(en, node('docs', []), 0)).toBe('No members for rules to apply to yet')
  })

  test('the source line only where it says something: not on a rule-less folder no rule opens to anyone', () => {
    expect(sourceSaysSomething(node('docs', [w({ reason: 'no-rule', folder: null, access: 'none', count: 12 })]))).toBe(false)
    expect(sourceSaysSomething(node('', [w({ reason: 'no-rule', folder: null, access: 'none', count: 12 })]))).toBe(false)
    // inherited from a folder above, or shut by a rule above: it says where
    expect(sourceSaysSomething(node('shared/x', [w({ folder: 'shared', subject: all, access: 'write', count: 12 })]))).toBe(true)
    expect(sourceSaysSomething(node('secret/x', [w({ folder: 'secret', subject: all, access: 'none', count: 12 })]))).toBe(true)
    // a folder with rules of its own always says it
    expect(sourceSaysSomething(node('a', [w({ reason: 'no-rule', folder: null, access: 'none', count: 12 })], { rules: 1 }))).toBe(true)
  })

  test('risks, kinds and the lock, in words', () => {
    expect(riskTexts(ko, { risks: ['everyone-writes'] })).toEqual(['팀 전체가 고칠 수 있어요'])
    expect(riskTexts(ko, { risks: ['skills-everyone-writes'] })).toEqual(['모든 사람의 AI가 따르는 지침을 팀 전체가 고칠 수 있어요'])
    expect(riskTexts(ko, { risks: ['root-everyone'] }, true)[0]).toContain('그룹·프로젝트 폴더')
    expect(kindText(ko, node('groups/a', [], { kinds: ['rules', 'group'] }))).toBe('그룹 폴더')
    expect(kindText(ko, node('projects/apollo', [], { kinds: ['project'], projects: [{ id: 'p', name: 'Apollo' }] }))).toBe('프로젝트 Apollo')
    expect(kindText(ko, node('projects/x', [], { kinds: ['project'], projects: [{ id: 'p', name: 'A' }, { id: 'q', name: 'B' }] }))).toBe('프로젝트 2개')
    expect(kindText(ko, node('connected/nas', [], { kinds: ['connected'] }))).toBe('연결 폴더')
    expect(kindText(ko, node('skills', []))).toBe('팀 스킬과 팀 규칙')
    expect(kindText(ko, node('skills/x', []))).toBe('팀 스킬')
    // the server's skills check: any case or Unicode form of the first name
    expect(kindText(ko, node('Skills/x', []))).toBe('팀 스킬')
    expect(isSkillsPath('Skills/x')).toBe(true)
    expect(isSkillsPath('SKILLS')).toBe(true)
    expect(isSkillsPath('skills2/x')).toBe(false)
    expect(isSkillsPath('x/skills')).toBe(false)
    expect(riskOf({ path: 'Skills/x', access: 'write', kinds: ['rules'] }, 'member')).toBe('skills')
    expect(kindText(ko, node('docs', []))).toBeNull()
    expect(isRestricted(node('a', [], { restricted: true }))).toBe(true)
    expect(isRestricted(node('users', [], { restricted: true, kinds: ['personal'] }))).toBe(false)
    expect(nodeName(ko, node('', []))).toBe('팀 폴더 맨 위')
    expect(parentOf('')).toBeNull()
    expect(parentOf('a')).toBe('')
    expect(parentOf('a/b/c')).toBe('a/b')
    expect(ancestorsOf('a/b/c')).toEqual(['', 'a', 'a/b'])
    expect(ancestorsOf('')).toEqual([])
  })

  test('no step name and no placeholder in any language', () => {
    const nodes = [
      node('a', [w({ folder: 'a', subject: sales, access: 'write', count: 3 }), w({ folder: '', subject: all, access: 'read', count: 2 }), w({ folder: 'b', subject: { type: 'user', id: 'bob', name: 'Bob' }, access: 'read', count: 1 })], { risks: ['everyone-writes', 'skills-everyone-writes', 'root-everyone'] }),
      node('docs', [w({ reason: 'no-rule', folder: null, access: 'none', count: 5 })]),
    ]
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const t = (key: MessageKey, p?: Params) => translate(locale, key, p)
      for (const n of nodes) {
        // the risk sentences may say "everyone" or "group" in plain English; the rows' own words never name a step
        const row = [whoSeesText(t, n, 6), sourceText(t, n, 6), kindText(t, n) ?? ''].join(' ')
        expect(row).not.toMatch(/\b(user|group|role|everyone|owner-admin|no-rule|tier)\b/)
        expect([row, ...riskTexts(t, n), ...riskTexts(t, n, true)].join(' ')).not.toMatch(/\{\w+\}/)
      }
    }
  })
})

describe('stage 6–7: who can edit team skills, in words', () => {
  type Who = AccessTreeNode['who'][number]
  const w = (o: Partial<Who> & Pick<Who, 'access' | 'count'>): Who => ({ reason: 'rule', folder: 'skills', subject: null, ...o })
  const staff = w({ reason: 'owner-admin', folder: null, access: 'write', count: 2 })
  const sales = { type: 'group' as const, id: 'g1', name: '영업팀' }
  const bob = { type: 'user' as const, id: 'bob', name: 'Bob' }
  const all = { type: 'everyone' as const, id: null, name: null }
  const top = [staff, w({ subject: sales, access: 'write', count: 3 }), w({ subject: bob, access: 'write', count: 1 }), w({ subject: all, access: 'read', count: 8 })]

  test('the people with write, merged by the rule that names them; only the owner and admins when nobody else', () => {
    expect(skillEditorsText(ko, top, 12)).toBe('고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, Bob 님')
    expect(skillEditorsText(en, top, 12)).toBe('Who can edit: the owner and admins, 영업팀: 3 people, Bob')
    // a group deciding at two folders is one entry
    expect(skillEditorsText(ko, [staff, w({ subject: sales, access: 'write', count: 2 }), w({ folder: 'skills/재무', subject: sales, access: 'write', count: 1 })], 12)).toBe('고칠 수 있는 사람: 팀장·관리자, 영업팀 3명')
    expect(skillEditorsText(ko, [staff, w({ subject: all, access: 'write', count: 12 })], 12)).toBe('고칠 수 있는 사람: 팀장·관리자, 모두')
    expect(skillEditorsText(ko, [staff, w({ subject: all, access: 'read', count: 12 })], 12)).toBe(ko('skillMgr.editorsAdmins'))
  })

  test('a folder inside skills/ that shuts some of skills/\' managers out: who, person by person; nothing when none', () => {
    type At = Parameters<typeof skillManagersOf>[0] extends Iterable<infer P> ? P : never
    const at = (id: string, access: 'none' | 'read' | 'write', reason: At['reason']): At => ({ user: { id, name: id[0]!.toUpperCase() + id.slice(1) }, access, reason })
    const salesWrite = rule('skills', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'write' }])
    // skills/: 영업팀 (Bob, Carol) writes, everyone else reads; the owner and admins are no managers by a rule
    const topPeople = [at('bob', 'write', salesWrite), at('carol', 'write', salesWrite), at('dan', 'read', rule('skills', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'read' }])), at('olga', 'write', { kind: 'owner-admin' })]
    const managers = skillManagersOf(topPeople)
    expect(managers.map((m) => m.id)).toEqual(['bob', 'carol'])
    // skills/x: "everyone: read, Bob: write". Carol is shut out, Bob is not (the per-rule count said all of 영업팀)
    const x = new Map<string, 'none' | 'read' | 'write'>([['bob', 'write'], ['carol', 'read'], ['dan', 'read'], ['olga', 'write']])
    expect(skillsLockedText(ko, managers, (id) => x.get(id))).toBe('skills에서는 고칠 수 있지만 여기서는 못 고치는 사람: Carol 님')
    expect(skillsLockedText(en, managers, (id) => x.get(id))).toBe('Can edit in skills but not here: Carol')
    // inherited as it is, or not known for someone: nothing claimed
    expect(skillsLockedText(ko, managers, () => 'write')).toBeNull()
    expect(skillsLockedText(ko, managers, () => undefined)).toBeNull()
    // many: three named, the rest counted
    const many = ['ann', 'ben', 'cid', 'dee', 'eve'].map((id) => ({ id, name: id }))
    expect(skillsLockedText(ko, many, () => 'none')).toBe('skills에서는 고칠 수 있지만 여기서는 못 고치는 사람: ann 님, ben 님, cid 님 외 2명')
  })

  test('Members: on through a rule that is not the person\'s own, and why', () => {
    const p = (access: 'none' | 'read' | 'write', reason: PersonFolderAccess['reason']) => ({ user: { id: 'bob', name: 'Bob' }, role: 'member' as const, access, reason, listable: true, via: [], viaMore: false })
    const gname = (id: string) => ({ g1: '영업팀' } as Record<string, string>)[id]
    expect(skillsVia(p('write', rule('skills', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'write' }])), gname)).toEqual({ kind: 'everyone' })
    expect(skillsVia(p('write', rule('skills', 'role', [{ subjectType: 'role', subjectId: 'member', access: 'write' }])), gname)).toEqual({ kind: 'everyone' })
    expect(skillsVia(p('write', rule('skills', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'write' }, { subjectType: 'group', subjectId: 'g2', access: 'read' }])), gname)).toEqual({ kind: 'group', names: ['영업팀'] })
    expect(skillsVia(p('write', rule('', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'write' }])), gname)).toEqual({ kind: 'root' })
    // their own rule on skills/ (the switch shows it), no write, or no answer: nothing to add
    expect(skillsVia(p('write', rule('skills', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'write' }])), gname)).toBeNull()
    expect(skillsVia(p('read', rule('skills', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'read' }])), gname)).toBeNull()
    expect(skillsVia(undefined, gname)).toBeNull()
  })
})
