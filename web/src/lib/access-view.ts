// Admin › Folder permissions › By person (read only): the words for one person's answer from the server
// (GET /api/admin/access/people/:id, POST /api/admin/access/new-person; server/src/admin/access-explain.ts). Nothing
// here decides access: every level and reason is the server's RuleSet.explain / listing, put into the admin's words.
// No step names of the permission function (user / group / role / everyone, owner-admin, no-rule) reach the screen.
import type { PersonAccessResponse, PersonFolderAccess, Role } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

type T = (key: MessageKey, params?: Params) => string

/** What the person gets at a folder, as the screen says it: write, read, shown in the tree only on the way to a folder
 * below (`listable` without access), or not shown at all. */
export type Level = 'write' | 'read' | 'listed' | 'none'
export const levelOf = (f: Pick<PersonFolderAccess, 'access' | 'listable'>): Level => (f.access !== 'none' ? f.access : f.listable ? 'listed' : 'none')

/** The groups of rows on the screen, in this order. */
export const SECTIONS = ['team', 'group', 'project', 'connected', 'skills', 'personal'] as const
export type Section = (typeof SECTIONS)[number]
export const isSkillsPath = (p: string) => p === 'skills' || p.startsWith('skills/')

/** The row's group: the server's kinds first, then the top folder that holds such folders (groups/, projects/,
 * connected/ themselves), so a parent sits with its folders. skills/ is the team's AI instructions: its own group. */
export function sectionOf(f: Pick<PersonFolderAccess, 'path' | 'kinds'>): Section {
  if (f.kinds.includes('personal')) return 'personal'
  if (isSkillsPath(f.path)) return 'skills'
  const top = f.path.split('/')[0]
  if (f.kinds.includes('group') || top === 'groups') return 'group'
  if (f.kinds.includes('project') || top === 'projects') return 'project'
  if (f.kinds.includes('connected') || top === 'connected') return 'connected'
  return 'team'
}

/** A path for a narrow column: the first folder and the last two, `projects/…/acme/contracts`. The full path goes in
 * the title and to screen readers. The team root is named in words. */
export function shortPath(p: string, root: string): string {
  if (p === '') return root
  const s = p.split('/')
  return s.length > 3 ? `${s[0]}/…/${s.slice(-2).join('/')}` : p
}

/** Names the reasons need: a group by id, a person by id (person rules name the person themselves). */
export interface Names { group: (id: string) => string | undefined; person: (id: string) => string | undefined }

/** Who a rule is for, in the admin's words ("Sales 그룹", "팀원 전체", "모두", "Bob 님"). */
function whoOf(t: T, r: { subjectType: string; subjectId: string | null }, names: Names): string {
  switch (r.subjectType) {
    case 'everyone':
      return t('rules.everyone')
    case 'role':
      return t('rules.roleOf', { role: t(r.subjectId === 'admin' ? 'role.admin' : r.subjectId === 'owner' ? 'role.owner' : 'role.member') })
    case 'group':
      return t('rules.groupOf', { name: (r.subjectId && names.group(r.subjectId)) ?? '?' })
    default:
      return t('accessView.who.person', { name: (r.subjectId && names.person(r.subjectId)) ?? '?' })
  }
}

/** At most this many folders are named in "shown only because of …"; the rest are counted. */
const VIA_NAMED = 2

/**
 * Why the person gets what they get at this folder, in one line. `role`: the person's role (the answer's). The order
 * follows the screen, not the function: a folder shown only on the way to a folder below says that first (it is why the
 * name shows at all); then the step that decided.
 */
export function reasonText(t: T, f: PersonFolderAccess, role: Role, names: Names): string {
  const root = t('accessView.rootFolder')
  const show = (p: string) => (p === '' ? root : p)
  if (f.access === 'none' && f.listable) {
    if (!f.via.length) return t('accessView.why.listedUnnamed')
    const paths = f.via.slice(0, VIA_NAMED).map(show).join(', ')
    if (f.viaMore) return t('accessView.why.listedMany', { paths })
    const rest = f.via.length - VIA_NAMED
    return rest > 0 ? t('accessView.why.listedMore', { paths, n: rest }) : t('accessView.why.listed', { paths })
  }
  const r = f.reason
  switch (r.kind) {
    case 'own-personal':
      return t('accessView.why.ownPersonal')
    case 'other-personal':
      return t('accessView.why.otherPersonal')
    case 'users-root':
      return t('accessView.why.usersRoot')
    case 'system':
    case 'temp':
      return t('accessView.why.system')
    case 'owner-admin':
      return t(role === 'owner' ? 'accessView.why.owner' : 'accessView.why.admin')
    case 'no-rule':
      return t('accessView.why.noRule')
    case 'rule': {
      // the widest of the step's rules decides (the server lists it first)
      const decider = r.rules[0]
      const who = decider ? whoOf(t, decider, names) : '?'
      const access = t(`access.${decider?.access ?? f.access}`)
      return r.folder === f.path ? t('accessView.why.ruleHere', { who, access }) : t('accessView.why.ruleFrom', { folder: show(r.folder), who, access })
    }
  }
}

/**
 * A risk the screen computes and marks (the only warning colour on it): a member who can write in skills/ changes the
 * instructions every AI of the team follows (a team skill manager). The owner and admins always can; that is expected.
 */
export function riskOf(f: Pick<PersonFolderAccess, 'path' | 'access' | 'kinds'>, role: Role): 'skills' | null {
  return role === 'member' && f.access === 'write' && !f.kinds.includes('personal') && isSkillsPath(f.path) ? 'skills' : null
}

/** Counts over the team folders of the rows loaded so far (the person's own folder is not a team folder). */
export function countRows(rows: readonly PersonFolderAccess[]) {
  let see = 0
  let write = 0
  let listed = 0
  let hidden = 0
  for (const f of rows) {
    const l = levelOf(f)
    if (l === 'none') hidden++
    if (f.kinds.includes('personal')) continue
    if (l === 'write') write++
    if (l === 'write' || l === 'read') see++
    if (l === 'listed') listed++
  }
  return { see, write, listed, hidden }
}

/** The answer's rows by group (SECTIONS order), each by path as the server sent them; empty groups left out. */
export function groupRows<R extends Pick<PersonFolderAccess, 'path' | 'kinds'>>(rows: readonly R[]): { section: Section; rows: R[] }[] {
  const by = new Map<Section, R[]>()
  for (const f of rows) {
    const s = sectionOf(f)
    by.set(s, [...(by.get(s) ?? []), f])
  }
  return SECTIONS.filter((s) => by.has(s)).map((s) => ({ section: s, rows: by.get(s)! }))
}

/** A folder typed to narrow the list ("projects/", " /projects/apollo "): the path the server takes (RelPath: no
 * leading or trailing "/", no empty, "." or ".." part, no "\"), '' for every folder, or null when it is not a path. */
export function cleanPrefix(typed: string): string | null {
  const s = typed.trim().replace(/^\/+|\/+$/g, '')
  if (s === '') return ''
  const parts = s.split(/\/+/)
  if (s.includes('\\') || s.includes('\0') || parts.some((x) => x === '.' || x === '..') || s.length > 1024) return null
  return parts.join('/')
}

/** Who the answer is about: a member (switched off or not) or someone about to be invited. */
export type Who = { kind: 'person'; name: string; off: boolean } | { kind: 'new' }

/** The one sentence on top ("Bob 님과 그 AI는 팀 폴더 6개를 볼 수 있고, 그중 3개에 쓸 수 있어요."), then what it
 * leaves out: folders whose name only shows, that it counted one folder's part of the tree (`prefix`), and, when more
 * pages follow, that it counted the rows loaded so far. */
export function summaryLines(t: T, who: Who, rows: readonly PersonFolderAccess[], page: Pick<PersonAccessResponse, 'total' | 'nextCursor'>, prefix = ''): string[] {
  const c = countRows(rows)
  const p = { n: c.see, w: c.write, name: who.kind === 'person' ? who.name : '' }
  // sees none / sees some and writes none / sees and writes
  const forms: Record<'new' | 'off' | 'on', [MessageKey, MessageKey, MessageKey]> = {
    new: ['accessView.summaryNewNone', 'accessView.summaryNewReadOnly', 'accessView.summaryNew'],
    off: ['accessView.summaryOffNone', 'accessView.summaryOffReadOnly', 'accessView.summaryOff'],
    on: ['accessView.summaryNone', 'accessView.summaryReadOnly', 'accessView.summary'],
  }
  const key = forms[who.kind === 'new' ? 'new' : who.off ? 'off' : 'on'][c.see === 0 ? 0 : c.write === 0 ? 1 : 2]
  const out = [t(key, p)]
  if (c.listed) out.push(t('accessView.summaryListed', { n: c.listed }))
  if (prefix) out.push(t('accessView.summaryPrefix', { path: prefix }))
  if (page.nextCursor !== null) out.push(t('accessView.summaryPartial', { loaded: rows.length, total: page.total }))
  return out
}
