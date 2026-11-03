// Admin › Folder permissions › By person: the words for the server's answer (web/src/lib/access-view.ts). The level and
// the reason of each row, the groups, the one-sentence summary, and that no step name of the permission function
// (user / group / role / everyone, owner-admin, no-rule …) reaches the screen in any language.
import { describe, expect, test } from 'bun:test'
import type { PersonFolderAccess } from '@mycel/shared/api'
import { DICTS, translate, type MessageKey, type Params } from '../../src/i18n'
import { cleanPrefix, countRows, groupRows, levelOf, reasonText, riskOf, sectionOf, shortPath, summaryLines } from '../../src/lib/access-view'
import { personViewLink } from '../../src/pages/admin/AccessResults'

const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const names = { group: (id: string) => ({ g1: 'Sales', g2: '재무팀' })[id], person: (id: string) => ({ bob: 'Bob' })[id] }

const row = (path: string, o: Partial<PersonFolderAccess> = {}): PersonFolderAccess => ({
  path, kinds: ['top'], exists: true, access: 'read', reason: { kind: 'no-rule' }, listable: true, via: [], viaMore: false, ...o,
})
const rule = (folder: string, tier: 'user' | 'group' | 'role' | 'everyone', rules: { subjectType: 'user' | 'group' | 'role' | 'everyone'; subjectId: string | null; access: 'none' | 'read' | 'write' }[]) =>
  ({ kind: 'rule' as const, folder, tier, rules })

describe('level', () => {
  test('write and read as they are; no access but shown on the way is "listed"; else none', () => {
    expect(levelOf(row('a', { access: 'write' }))).toBe('write')
    expect(levelOf(row('a', { access: 'read' }))).toBe('read')
    expect(levelOf(row('a', { access: 'none', listable: true }))).toBe('listed')
    expect(levelOf(row('a', { access: 'none', listable: false }))).toBe('none')
  })
})

describe('reasons, in words', () => {
  test('a rule on this folder names who it is for and what it gives', () => {
    const f = row('groups/Sales', { access: 'write', kinds: ['group', 'rules'], reason: rule('groups/Sales', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'write' }]) })
    expect(reasonText(ko, f, 'member', names)).toBe('이 폴더의 규칙 · Sales 그룹: 읽기·쓰기')
    expect(reasonText(en, f, 'member', names)).toBe('Rule on this folder · Group Sales: Read & write')
  })

  test('inherited: the folder it comes from, who and what', () => {
    const f = row('shared/notes', { access: 'write', reason: rule('shared', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'write' }]) })
    expect(reasonText(ko, f, 'member', names)).toBe('shared에서 물려받음 · 모두: 읽기·쓰기')
    // from the team root
    const r = row('docs', { reason: rule('', 'role', [{ subjectType: 'role', subjectId: 'member', access: 'read' }]) })
    expect(reasonText(ko, r, 'member', names)).toBe('팀 폴더 맨 위에서 물려받음 · 팀원 전체: 읽기')
  })

  test('a person rule names the person; the widest of several group rules (listed first) is the one named', () => {
    const p = row('finance', { access: 'read', reason: rule('finance', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'read' }]) })
    expect(reasonText(ko, p, 'member', names)).toBe('이 폴더의 규칙 · Bob 님: 읽기')
    const g = row('finance', { access: 'write', reason: rule('finance', 'group', [{ subjectType: 'group', subjectId: 'g2', access: 'write' }, { subjectType: 'group', subjectId: 'g1', access: 'read' }]) })
    expect(reasonText(ko, g, 'member', names)).toBe('이 폴더의 규칙 · 재무팀 그룹: 읽기·쓰기')
  })

  test('a rule that gives nothing says so', () => {
    const f = row('secret', { access: 'none', listable: false, reason: rule('secret', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'none' }]) })
    expect(reasonText(ko, f, 'member', names)).toBe('이 폴더의 규칙 · 모두: 권한 없음')
  })

  test('owner and admins: everything but other people\'s personal folders', () => {
    const f = row('docs', { access: 'write', reason: { kind: 'owner-admin' } })
    expect(reasonText(ko, f, 'admin', names)).toBe('관리자라서 다른 사람의 개인 폴더 말고는 모두 볼 수 있어요')
    expect(reasonText(ko, f, 'owner', names)).toBe('팀장이라서 다른 사람의 개인 폴더 말고는 모두 볼 수 있어요')
  })

  test('no rule: only the owner and admins', () => {
    expect(reasonText(ko, row('docs', { access: 'none', listable: false }), 'member', names)).toBe('규칙이 없어 팀장과 관리자만 봐요')
  })

  test('shown on the way: the folders below that make it so, two named and the rest counted', () => {
    const base = { access: 'none' as const, listable: true }
    expect(reasonText(ko, row('projects', { ...base, via: ['projects/apollo'] }), 'member', names)).toBe('아래 projects/apollo 때문에 폴더 이름만 보여요')
    expect(reasonText(ko, row('projects', { ...base, via: ['projects/a', 'projects/b', 'projects/c', 'projects/d'] }), 'member', names)).toBe('아래 projects/a, projects/b 외 2곳 때문에 폴더 이름만 보여요')
    expect(reasonText(ko, row('projects', { ...base, via: Array.from({ length: 20 }, (_, i) => `projects/p${i}`), viaMore: true }), 'member', names)).toBe('아래 projects/p0, projects/p1 외 여러 곳 때문에 폴더 이름만 보여요')
    // a readable folder below that may not be named (a forgotten rule row): still why it shows
    expect(reasonText(ko, row('x', { ...base, via: [] }), 'member', names)).toBe('아래에 볼 수 있는 폴더가 있어 폴더 이름만 보여요')
    expect(reasonText(en, row('projects', { ...base, via: ['projects/apollo'] }), 'member', names)).toBe('Only the name shows, on the way to projects/apollo below')
  })

  test('the person\'s own folder', () => {
    expect(reasonText(ko, row('users/bob', { kinds: ['personal'], exists: null, access: 'write', reason: { kind: 'own-personal' } }), 'member', names)).toBe('본인만 · 팀장과 관리자도 못 봐요')
  })

  test('no step name of the permission function in any language', () => {
    const rows: PersonFolderAccess[] = [
      row('a', { access: 'write', reason: rule('a', 'user', [{ subjectType: 'user', subjectId: 'bob', access: 'write' }]) }),
      row('a/b', { reason: rule('a', 'group', [{ subjectType: 'group', subjectId: 'g1', access: 'read' }]) }),
      row('c', { reason: rule('', 'role', [{ subjectType: 'role', subjectId: 'member', access: 'read' }]) }),
      row('d', { access: 'none', listable: false, reason: rule('d', 'everyone', [{ subjectType: 'everyone', subjectId: null, access: 'none' }]) }),
      row('e', { access: 'write', reason: { kind: 'owner-admin' } }),
      row('f', { access: 'none', listable: false, reason: { kind: 'no-rule' } }),
      row('users/bob', { kinds: ['personal'], access: 'write', reason: { kind: 'own-personal' } }),
    ]
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const t = (key: MessageKey, p?: Params) => translate(locale, key, p)
      for (const f of rows) {
        const text = reasonText(t, f, 'member', names)
        expect(text).not.toMatch(/\b(user|group|role|everyone|owner-admin|no-rule|tier|own-personal)\b/)
        expect(text).not.toMatch(/\{\w+\}/)
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

  test('a typed folder becomes the server\'s path; not a path: null', () => {
    expect(cleanPrefix(' /projects/apollo/ ')).toBe('projects/apollo')
    expect(cleanPrefix('projects//apollo')).toBe('projects/apollo')
    expect(cleanPrefix('  ')).toBe('')
    expect(cleanPrefix('../x')).toBeNull()
    expect(cleanPrefix('a\\b')).toBeNull()
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

  test('narrowed to one folder: said so', () => {
    expect(summaryLines(ko, { kind: 'new' }, rows.slice(3, 5), { total: 2, nextCursor: null }, 'projects').at(-1)).toBe('projects 아래만 셌어요.')
  })

  test('nothing seen; more pages to come', () => {
    const none = [row('secret', { access: 'none', listable: false })]
    expect(summaryLines(ko, { kind: 'person', name: 'Bob', off: false }, none, { total: 1, nextCursor: null })).toEqual(['Bob 님과 그 AI가 볼 수 있는 팀 폴더는 없어요.'])
    expect(summaryLines(en, { kind: 'new' }, rows, { total: 900, nextCursor: 'skills' }).at(-1)).toBe('Counted from the 7 of 900 folders loaded so far.')
    // sees some, writes none
    expect(summaryLines(en, { kind: 'person', name: 'Bob', off: false }, [row('docs', { access: 'read' })], { total: 1, nextCursor: null })[0]).toBe('Bob and their AI can see 1 team folder but cannot write to any.')
    expect(summaryLines(ko, { kind: 'new' }, [row('docs', { access: 'read' }), row('a', { access: 'read' })], { total: 2, nextCursor: null })[0]).toBe('새로 들어올 사람과 그 AI는 팀 폴더 2개를 볼 수 있고, 쓸 수 있는 곳은 없어요.')
  })
})
