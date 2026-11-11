// "Who can see it" on the Files page (web/src/lib/folder-access.ts; docs/DECISIONS.md "Who can see a folder, in
// place"): where the chip shows, what it says, and that it waits for the answers it needs. What a member learns is the
// server's (a count only where they can write); these rules only decide where to ask and how to say it.
import { describe, expect, test } from 'bun:test'
import type { AccessTreeNode, Project } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { adminsOnly, chipLabel, chipOf, chipPlace, chipText, headlineText } from '../../src/lib/folder-access'
import { editableHere } from '../../src/components/FolderAccess'
import { byRoleLine } from '../../src/lib/whoByRole'

const ko = (key: MessageKey, p?: Params) => translate('ko', key, p)
const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const project = (o: Partial<Project> = {}): Project => ({
  id: '0190a8f2-0000-7000-8000-000000000001', name: 'Falcon', folderPath: 'projects/falcon', instructions: '', createdBy: null,
  createdAt: '2026-11-10T00:00:00.000Z', canEdit: true, audience: 7, ...o,
})
const who = (w: Partial<AccessTreeNode['who'][number]>[]): Pick<AccessTreeNode, 'who'> => ({
  who: w.map((x) => ({ reason: 'rule', folder: '', subject: null, access: 'read', count: 1, ...x }) as AccessTreeNode['who'][number]),
})

describe('where the chip shows', () => {
  const me = 'alice'
  test('nowhere at the root, the top containers or someone else\'s folder', () => {
    for (const p of ['', 'users', 'groups', 'projects', 'connected', 'users/bob', 'users/bob/x']) expect({ p, at: chipPlace(p, { me, access: 'write' }) }).toEqual({ p, at: null })
  })
  test('my own folder by its path, whatever the access says', () => {
    expect(chipPlace('users/alice', { me, access: 'write' })).toBe('own')
    expect(chipPlace('users/alice/drafts/x', { me, access: 'read' })).toBe('own')
  })
  test('a member only where they can write; never on a folder they only read or pass through', () => {
    expect(chipPlace('shared', { me, access: 'write' })).toBe('ask')
    expect(chipPlace('skills', { me, access: 'read' })).toBeNull()
    expect(chipPlace('groups/finance', { me, access: 'none' })).toBeNull()
    expect(chipPlace('shared/양식', { me, access: 'write' })).toBe('ask')
  })
  test('a team project\'s folder by its own count, even read only; not one in the trash or without a count', () => {
    expect(chipPlace('projects/falcon', { me, access: 'read', project: project() })).toBe('project')
    expect(chipPlace('shared/clients/acme', { me, access: 'read', project: project({ folderPath: 'shared/clients/acme' }) })).toBe('project')
    expect(chipPlace('projects/falcon', { me, access: 'read', project: project({ inTrash: true }) })).toBeNull()
    expect(chipPlace('projects/falcon', { me, access: 'write', project: project({ audience: undefined }) })).toBe('ask')
  })
})

describe('what it says', () => {
  test('nothing until the answer is here; never a number from a read-only answer', () => {
    expect(chipOf('ask', { audience: null })).toBeNull()
    expect(chipOf('ask', { audience: { path: 'skills', access: 'read' } })).toBeNull()
    expect(chipOf(null, { audience: { path: 'shared', access: 'write', people: 5, everyone: true } })).toBeNull()
  })
  test('only you, the whole team, owner and admins only, a count', () => {
    expect(chipOf('own', {})).toEqual({ kind: 'onlyYou' })
    expect(chipOf('ask', { audience: { path: 'shared', access: 'write', people: 5, everyone: true } })).toEqual({ kind: 'team' })
    expect(chipOf('ask', { audience: { path: 'groups/m', access: 'write', people: 4, everyone: false } })).toEqual({ kind: 'people', n: 4 })
    expect(chipOf('ask', { audience: { path: 'groups/m', access: 'write', people: 2, everyone: false }, adminsOnly: true })).toEqual({ kind: 'adminsOnly' })
    expect(chipOf('project', { project: project() })).toEqual({ kind: 'people', n: 7, members: true })
    // a project made before outside projects/: an ordinary folder's count
    expect(chipOf('project', { project: project({ folderPath: 'shared/clients/acme' }) })).toEqual({ kind: 'people', n: 7 })
  })
  test('owner and admins only: no rule lets a member in, and there are members', () => {
    expect(adminsOnly(who([{ reason: 'owner-admin', access: 'write', count: 2 }, { reason: 'no-rule', access: 'none', count: 3 }]), 3)).toBe(true)
    expect(adminsOnly(who([{ reason: 'owner-admin', access: 'write', count: 2 }, { reason: 'rule', subject: { type: 'group', id: 'g', name: 'Sales' }, access: 'read', count: 1 }]), 3)).toBe(false)
    expect(adminsOnly(who([{ reason: 'owner-admin', access: 'write', count: 2 }, { reason: 'rule', access: 'none', count: 3 }]), 3)).toBe(true)
    // a team of admins only: the whole team, not "owner and admins only"
    expect(adminsOnly(who([{ reason: 'owner-admin', access: 'write', count: 2 }]), 0)).toBe(false)
  })
  test('the words, and the headline says the owner and admins are in a count', () => {
    expect(chipText(ko, { kind: 'onlyYou' })).toBe('나만 봐요')
    expect(chipText(ko, { kind: 'team' })).toBe('팀 전체가 봐요')
    expect(chipText(ko, { kind: 'adminsOnly' })).toBe('팀장과 관리자만')
    expect(chipText(ko, { kind: 'people', n: 6 })).toBe('6명이 봐요')
    expect(headlineText(ko, { kind: 'people', n: 6 })).toBe('6명이 봐요 (팀장·관리자 포함)')
    expect(headlineText(ko, { kind: 'team' })).toBe('팀 전체가 봐요')
    expect(chipText(en, { kind: 'people', n: 1 })).toBe('1 person sees it')
    expect(chipText(en, { kind: 'people', n: 6 })).toBe('6 people see it')
    expect(headlineText(en, { kind: 'people', n: 6 })).toBe('6 people see it (owner and admins included)')
  })
})

describe('the owner and admins\' chip says the count apart (docs/DECISIONS.md "Who sees it: the project\'s own people first")', () => {
  const split = { path: 'groups/m', access: 'write' as const, people: 5, everyone: false, split: { direct: 3, byRole: 2 } }
  test('the chip: the folder\'s own rules first; its accessible name adds the owner and admins who see it only by role', () => {
    const c = chipOf('ask', { audience: split, apart: true })!
    expect(c).toEqual({ kind: 'people', n: 3, byRole: 2 })
    expect(chipText(ko, c)).toBe('3명')
    expect(chipLabel(ko, c)).toBe('3명이 봐요 · 팀장·관리자 2명도 볼 수 있어요')
    expect(chipText(en, c)).toBe('3 people')
    expect(chipLabel(en, c)).toBe('3 people see it · 2 more can see it as the owner and admins')
    expect(chipLabel(en, { kind: 'people', n: 3, byRole: 1 })).toBe('3 people see it · 1 more can see it as the owner or an admin')
  })
  test('the panel keeps its headline: the total, the owner and admins included (the panel is redesigned elsewhere)', () => {
    const c = chipOf('ask', { audience: split })!
    expect(c).toEqual({ kind: 'people', n: 5 })
    expect(headlineText(ko, c)).toBe('5명이 봐요 (팀장·관리자 포함)')
  })
  test('nobody by role: no role part; nobody by a rule: owner and admins only; everyone: the whole team', () => {
    const all = chipOf('ask', { audience: { ...split, people: 4, split: { direct: 4, byRole: 0 } }, apart: true })!
    expect(all).toEqual({ kind: 'people', n: 4, byRole: 0 })
    expect(chipLabel(ko, all)).toBe('4명이 봐요')
    expect(chipOf('ask', { audience: { ...split, people: 2, split: { direct: 0, byRole: 2 } }, apart: true })).toEqual({ kind: 'adminsOnly' })
    expect(chipOf('ask', { audience: { ...split, everyone: true, split: { direct: 5, byRole: 0 } }, apart: true })).toEqual({ kind: 'team' })
  })
  test('a team project\'s folder in projects/ (docs/DECISIONS.md "Project contents only for members"): its members, no role part, no "(팀장·관리자 포함)", never "팀장과 관리자만"', () => {
    const c = chipOf('project', { project: project({ audience: 3, audienceSplit: { direct: 3, byRole: 0 } }), apart: true })!
    expect(c).toEqual({ kind: 'people', n: 3, members: true })
    expect(chipText(ko, c)).toBe('3명이 봐요')
    expect(chipLabel(ko, c)).toBe('3명이 봐요')
    expect(headlineText(ko, c)).toBe('3명이 봐요')
    expect(headlineText(en, c)).toBe('3 people see it')
    // the panel's headline too (no split asked)
    expect(headlineText(ko, chipOf('project', { project: project({ audience: 3 }) })!)).toBe('3명이 봐요')
    // nobody by its rules: still a count of its members, never "owner and admins only"
    expect(chipOf('project', { project: project({ audience: 0, audienceSplit: { direct: 0, byRole: 0 } }), apart: true })).toEqual({ kind: 'people', n: 0, members: true })
    // a project made before outside projects/: an ordinary folder, its split as before
    const legacy = chipOf('project', { project: project({ folderPath: 'shared/clients/acme', audience: 5, audienceSplit: { direct: 3, byRole: 2 } }), apart: true })!
    expect(legacy).toEqual({ kind: 'people', n: 3, byRole: 2 })
    expect(chipLabel(ko, legacy)).toBe('3명이 봐요 · 팀장·관리자 2명도 볼 수 있어요')
  })
  test('the role line (ordinary folders only): a number, nothing at 0', () => {
    expect(byRoleLine(ko, 2)).toBe('팀장·관리자 2명도 볼 수 있어요')
    expect(byRoleLine(ko, 0)).toBeNull()
    expect(byRoleLine(ko, undefined)).toBeNull()
    // a folder's own words (es: la carpeta)
    const es = (key: MessageKey, p?: Params) => translate('es', key, p)
    expect(byRoleLine(es, 2)).toContain('verla')
  })
  test('a member (no split): the total, the owner and admins included, and no role part or number', () => {
    const c = chipOf('ask', { audience: { path: 'groups/m', access: 'write', people: 5, everyone: false }, apart: true })!
    expect(chipText(ko, c)).toBe('5명이 봐요')
    expect(chipLabel(ko, c)).toBe('5명이 봐요 (팀장·관리자 포함)')
  })
})

describe('where an admin changes who can open it in the panel', () => {
  test('a team folder and a legacy project\'s folder: yes; a team project\'s folder and anything inside it, one\'s own folder and the containers: no', () => {
    expect(editableHere('shared', 'ask')).toBe(true)
    expect(editableHere('shared/clients/acme', 'project')).toBe(true)
    // the owner chose members-only projects: the panel changes nothing in projects/ (their members do)
    expect(editableHere('projects/falcon/docs', 'ask')).toBe(false)
    // the server folds the letter case of projects/ (docs/DECISIONS.md "Project contents only for members")
    expect(editableHere('Projects/falcon/docs', 'ask')).toBe(false)
    expect(editableHere('projects/falcon', 'project')).toBe(false)
    // the project list did not load: still none on a folder of projects/ itself
    expect(editableHere('projects/falcon', 'ask')).toBe(false)
    expect(editableHere('users/olga', 'own')).toBe(false)
    expect(editableHere('', null)).toBe(false)
    expect(editableHere('groups', 'ask')).toBe(false)
  })
})
