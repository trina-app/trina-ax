// The words for who can open a folder, as the server grouped them (web/src/lib/access-view.ts): who can change the
// team's skills, and the address of what a person can open. Admin › Folder permissions' tree and By person words are gone
// with those screens (docs/DECISIONS.md "드라이브처럼 공유 P1.5").
import { describe, expect, test } from 'bun:test'
import type { AccessTreeNode } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { folderName, isSkillsPath, skillEditorsElsewhere, skillEditorsText, skillFoldersWithEditors } from '../../src/lib/access-view'
import { personViewLink } from '../../src/pages/admin/FolderLists'

const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
const en = (key: MessageKey, p?: Params) => translate('en', key, p)

describe('names and addresses', () => {
  test('the root and personal folders in words; skills/ in any letter case; a person\'s address', () => {
    expect(folderName(en, 'shared/x')).toBe('shared/x')
    expect(folderName(en, 'users/bob')).toBe(en('accessView.ownFolderName'))
    expect(isSkillsPath('Skills/a')).toBe(true)
    expect(isSkillsPath('shared/skills')).toBe(false)
    expect(personViewLink({ person: 'bob' })).toBe('/admin/folders?view=people&person=bob')
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
    // folders inside skills/ with editors of their own (the Team skills page): counted last, and never "only the owner
    // and admins"; not known (the rules did not load): the owner and admins named without "only"
    expect(skillEditorsText(ko, [staff], 12, 1)).toBe('고칠 수 있는 사람: 팀장·관리자, 폴더별로 맡긴 곳 1개')
    expect(skillEditorsText(ko, top, 12, 2)).toBe('고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, Bob 님, 폴더별로 맡긴 곳 2개')
    expect(skillEditorsText(en, [staff], 12, 1)).toBe('Who can edit: the owner and admins, 1 folder has write rules of its own')
    expect(skillEditorsText(en, [staff], 12, 2)).toBe('Who can edit: the owner and admins, 2 folders have write rules of their own')
    expect(skillEditorsText(ko, [staff], 12, 0)).toBe(ko('skillMgr.editorsAdmins'))
    expect(skillEditorsText(ko, [staff], 12, null)).toBe('고칠 수 있는 사람: 팀장·관리자')
    expect(skillEditorsText(en, [staff], 12, null)).toBe('Who can edit: the owner and admins')
    expect(skillEditorsText(ko, top, 12, null)).toBe('고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, Bob 님')
    // groups and people first, everyone after them ("그 밖의 2명" is the rest)
    expect(skillEditorsText(ko, [staff, w({ subject: all, access: 'write', count: 2 }), w({ subject: sales, access: 'write', count: 3 })], 12)).toBe('고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, 그 밖의 2명')
  })

  test('the folders inside skills/ with editors of their own: any write rule but the admins\' one, folders the tree shows', () => {
    type Row = Parameters<typeof skillFoldersWithEditors>[0][number]
    const rule = (subjectType: string, subjectId: string | null, access: 'read' | 'write' | 'none') => ({ id: 'r', folderId: 'f', subjectType, subjectId, access, updatedBy: null, updatedAt: '2026-11-07T00:00:00Z' }) as Row['rules'][number]
    const row = (path: string, rules: Row['rules'], o: Partial<Row> = {}): Row => ({ path, exists: true, hidden: false, rules, ...o })
    expect(skillFoldersWithEditors([
      row('skills', [rule('everyone', null, 'write')]), // skills/ itself: the line names those
      row('skills/재무', [rule('everyone', null, 'write')]), // everyone
      row('skills/영업', [rule('everyone', null, 'read'), rule('group', 'g1', 'write')]), // a group
      row('skills/법무', [rule('user', 'bob', 'write')]), // a person
      row('skills/옛날', [rule('role', 'member', 'write')]), // the old members row
      row('skills/관리', [rule('role', 'admin', 'write')]), // admins: changes nobody
      row('skills/읽기', [rule('everyone', null, 'read')]), // read only
      row('skills/없음', [rule('user', 'bob', 'write')], { exists: false }), // not on disk
      row('shared/x', [rule('everyone', null, 'write')]), // not skills/
      row('Skills/대소문자', [rule('user', 'bob', 'write')]), // the server serves Skills/ as skills/
    ])).toBe(5)
    expect(skillFoldersWithEditors([])).toBe(0)
    // counted from the rule rows, not decided by tier as the server does: "everyone: write" with "members: none" on one
    // folder gives no member write there, yet it counts as a folder with write rules of its own (it can overcount in such
    // rare shapes, never undercount; the words say "rules", not "editors")
    expect(skillFoldersWithEditors([row('skills/거부', [rule('everyone', null, 'write'), rule('role', 'member', 'none')])])).toBe(1)
  })

  test('the dialog: editors through a rule that is not a person\'s or group\'s own on skills/ (everyone, the team root)', () => {
    const root = (o: Partial<Who> & Pick<Who, 'access' | 'count'>) => w({ folder: '', ...o })
    // own rules on skills/ (the dialog lists and removes them) and read: nothing else to say
    expect(skillEditorsElsewhere(ko, top, 12)).toEqual([])
    // everyone writes in skills/, the old "members" row, a person's rule on the whole team folder
    expect(skillEditorsElsewhere(ko, [staff, w({ subject: all, access: 'write', count: 12 })], 12)).toEqual(['모두'])
    expect(skillEditorsElsewhere(ko, [staff, w({ subject: { type: 'role', id: 'member', name: null }, access: 'write', count: 12 })], 12)).toEqual(['팀원 전체'])
    expect(skillEditorsElsewhere(ko, [staff, w({ subject: sales, access: 'write', count: 3 }), root({ subject: bob, access: 'write', count: 1 })], 12)).toEqual(['Bob 님'])
    expect(skillEditorsElsewhere(en, [staff, root({ subject: all, access: 'write', count: 9 })], 12)).toEqual(['9 others'])
    // a name with its own honorific keeps one
    expect(skillEditorsElsewhere(ko, [root({ subject: { type: 'user', id: 'k', name: '김대표님' }, access: 'write', count: 1 })], 12)).toEqual(['김대표님'])
  })
})

