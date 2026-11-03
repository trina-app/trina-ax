// Admin › Folder permissions › By person (read only): the words for one person's answer from the server
// (GET /api/admin/access/people/:id, POST /api/admin/access/new-person; server/src/admin/access-explain.ts). Nothing
// here decides access: every level and reason is the server's RuleSet.explain / listing, put into the admin's words.
// No step names of the permission function (user / group / role / everyone, owner-admin, no-rule) reach the screen.
import type { AccessTreeNode, AccessTreeWho, PersonAccessResponse, PersonFolderAccess, Role } from '@mycel/shared/api'
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
export const isPersonalPath = (p: string) => p === 'users' || p.startsWith('users/')

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

/** Names the reasons need: a group by id, a person by id (person rules name the person themselves), and the folders
 * that carry rules (Admin › Folder permissions' list; undefined while it is not known): "no rule for this person" is
 * told apart from "no rule at all" with it. */
export interface Names { group: (id: string) => string | undefined; person: (id: string) => string | undefined; ruleFolders?: ReadonlySet<string> }

/** The nearest folder at or above `path` that carries rules ('' = the team root), or null when none does. */
export function nearestRuleFolder(path: string, ruleFolders: ReadonlySet<string>): string | null {
  const segs = path === '' ? [] : path.split('/')
  for (let n = segs.length; n >= 0; n--) {
    const p = segs.slice(0, n).join('/')
    if (ruleFolders.has(p)) return p
  }
  return null
}

/** A folder in the words of this screen: the team root by its one name, a personal folder (the only one an answer
 * names is the person's own) as "their personal folder". */
export function folderName(t: T, p: string): string {
  if (p === '') return t('accessView.rootFolder')
  if (p === 'users' || p.startsWith('users/')) return t('accessView.ownFolderName')
  return p
}

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

/** A folder without access shown in the tree: on the way to which folders below. Only the person's own folder below
 * (the team root, always), or none that may be named, is said as the way to their personal folder; for someone new,
 * the one they will have once they join. */
function listedText(t: T, f: PersonFolderAccess, newPerson: boolean): string {
  const named = f.via.filter((v) => !isPersonalPath(v))
  if (!named.length) return t(f.via.length || f.path === '' ? (newPerson ? 'accessView.why.listedOwnNew' : 'accessView.why.listedOwn') : 'accessView.why.listedUnnamed')
  const all = f.via.map((v) => folderName(t, v))
  const paths = all.slice(0, VIA_NAMED).join(', ')
  if (f.viaMore) return t('accessView.why.listedMany', { paths })
  const rest = all.length - VIA_NAMED
  return rest > 0 ? t('accessView.why.listedMore', { paths, n: rest }) : t('accessView.why.listed', { paths })
}

/** The step of the permission function that decided, in words. */
function decidedText(t: T, f: PersonFolderAccess, role: Role, names: Names): string {
  const r = f.reason
  switch (r.kind) {
    case 'own-personal':
      return t(role === 'owner' ? 'accessView.why.ownPersonalOwner' : role === 'admin' ? 'accessView.why.ownPersonalAdmin' : 'accessView.why.ownPersonal')
    case 'other-personal':
      return t('accessView.why.otherPersonal')
    case 'users-root':
      return t('accessView.why.usersRoot')
    case 'system':
    case 'temp':
      return t('accessView.why.system')
    case 'owner-admin':
      return t(role === 'owner' ? 'accessView.why.owner' : 'accessView.why.admin')
    case 'no-rule': {
      // no folder on the way up has a rule FOR THIS PERSON; rules for others may be there
      if (!names.ruleFolders) return t('accessView.why.noRule')
      const near = nearestRuleFolder(f.path, names.ruleFolders)
      if (near === null) return t('accessView.why.noRuleAtAll')
      if (near === '') return t('accessView.why.noRuleRoot')
      return near === f.path ? t('accessView.why.noRuleHere') : t('accessView.why.noRuleFrom', { folder: near })
    }
    case 'rule': {
      // the widest of the step's rules decides (the server lists it first)
      const decider = r.rules[0]
      const who = decider ? whoOf(t, decider, names) : '?'
      const access = t(`access.${decider?.access ?? f.access}`)
      return r.folder === f.path ? t('accessView.why.ruleHere', { who, access }) : t('accessView.why.ruleFrom', { folder: folderName(t, r.folder), who, access })
    }
  }
}

/**
 * Why the person gets what they get at this folder: one line, or two for a folder shown only on the way to folders
 * below (first why its name shows, then the step that decided, so an explicit "no access" is not hidden by it).
 * `role`: the person's role (the answer's).
 */
export function reasonText(t: T, f: PersonFolderAccess, role: Role, names: Names, o: { newPerson?: boolean } = {}): string[] {
  if (f.access === 'none' && f.listable) return [listedText(t, f, !!o.newPerson), decidedText(t, f, role, names)]
  return [decidedText(t, f, role, names)]
}

/** Rules do not change what the owner and admins get (everything but other people's personal folders): their rows
 * offer no rule editor. */
export const rulesApply = (f: Pick<PersonFolderAccess, 'reason' | 'kinds'>) => f.reason.kind !== 'owner-admin' && !f.kinds.includes('personal')

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

/** The one sentence on top ("Bob 님과 그 AI는 팀 폴더 6개를 볼 수 있고, 그중 3개에 쓸 수 있어요."), which names its
 * part of the tree when narrowed to a folder ("projects 안에서는 …"); then what it leaves out: folders whose name only
 * shows and, when more pages follow, that it counted the rows loaded so far. */
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
  const sentence = t(key, p)
  // narrowed to users/: the only row is the person's own folder, which the counts leave out (it is no team folder)
  const ownOnly = who.kind === 'person' && isPersonalPath(prefix) && rows.some((f) => f.kinds.includes('personal'))
  const out = [ownOnly ? t('accessView.summaryInOwn', { path: prefix, name: p.name }) : prefix ? t('accessView.summaryIn', { path: prefix, sentence }) : sentence]
  if (c.listed) out.push(t('accessView.summaryListed', { n: c.listed }))
  if (page.nextCursor !== null) out.push(t('accessView.summaryPartial', { loaded: rows.length, total: page.total }))
  return out
}

// ---------------- the folder tree (Admin › Folder permissions › By folder) ----------------
// One row per folder, from GET /api/admin/access/tree: who sees it (every active person, grouped by the rule that
// decided for them), where that comes from, and the risks the server computed. Words only; nothing here decides.

/** At most this many groups of people are named on a row; the rest are counted. */
const WHO_NAMED = 3

/** Who a group of people is, in a row's words: "영업팀 3명", "모두", "그 밖의 9명", "Bob 님". `members`: the people rules
 * decide for (not the owner or admins). `short`: without the count, for the source line ("영업팀", "나머지"). */
function whoLabel(t: T, w: AccessTreeWho, members: number, short = false): string {
  const s = w.subject
  if (!s || s.type === 'everyone' || (s.type === 'role' && s.id === 'member')) {
    if (w.count >= members) return t(s?.type === 'role' ? 'accessTree.who.allMembers' : 'rules.everyone')
    return short ? t('accessTree.who.othersShort') : t('accessTree.who.others', { n: w.count })
  }
  if (s.type === 'group') return short ? (s.name ?? '?') : t('accessTree.who.group', { name: s.name ?? '?', n: w.count })
  if (s.type === 'user') return t('accessView.who.person', { name: s.name ?? '?' })
  return t('rules.roleOf', { role: t(s.id === 'admin' ? 'role.admin' : s.id === 'owner' ? 'role.owner' : 'role.member') })
}

/** The groups of people a rule lets open the folder (the owner and admins always can). */
const seers = (n: Pick<AccessTreeNode, 'who'>) => n.who.filter((w) => w.reason === 'rule' && w.access !== 'none')

/** "영업팀 3명 · 읽기·쓰기, 모두 · 읽기", or "팀장과 관리자만" when no rule lets a member in. */
export function whoSeesText(t: T, n: Pick<AccessTreeNode, 'who'>, members: number): string {
  const see = seers(n)
  if (!see.length) return t('accessTree.who.adminsOnly')
  const parts = see.slice(0, WHO_NAMED).map((w) => `${whoLabel(t, w, members)} · ${t(`access.${w.access}`)}`)
  // the rest counted in people
  const rest = see.slice(WHO_NAMED).reduce((n, w) => n + w.count, 0)
  return rest > 0 ? t('accessTree.who.more', { list: parts.join(', '), n: rest }) : parts.join(', ')
}

/** Whether the source line adds anything: not on a folder without rules of its own that no rule opens to any member
 * ("팀장과 관리자만" says it all there, and it would repeat on most rows). */
export const sourceSaysSomething = (n: Pick<AccessTreeNode, 'who' | 'rules'>) => n.rules > 0 || n.who.some((w) => w.reason === 'rule')

/** Where a decision comes from: this folder's rules, or "shared에서 물려받음" (the root by its name). */
const fromText = (t: T, folder: string, here: string) => (folder === here ? t('accessTree.source.here') : t('accessTree.source.from', { folder: folderName(t, folder) }))

/**
 * Where the access on a row comes from. One folder for everyone: "이 폴더의 규칙" or "shared에서 물려받음". Several
 * (it differs by person): by whom, "영업팀: 이 폴더의 규칙 · 나머지: shared에서 물려받음". The folders of the people who can
 * open it; when nobody can, of those shut out ("모두: 권한 없음" here). No rule for any member: said so.
 */
export function sourceText(t: T, n: Pick<AccessTreeNode, 'who' | 'path'>, members: number): string {
  const rules = n.who.filter((w) => w.reason === 'rule')
  const open = rules.filter((w) => w.access !== 'none')
  const use = open.length ? open : rules
  if (!use.length) return t(members ? 'accessTree.source.noRule' : 'accessTree.source.noMembers')
  const byFolder = new Map<string, AccessTreeWho[]>()
  for (const w of use) byFolder.set(w.folder ?? '', [...(byFolder.get(w.folder ?? '') ?? []), w])
  if (byFolder.size === 1) return fromText(t, [...byFolder.keys()][0]!, n.path)
  const parts = [...byFolder].slice(0, 2).map(([folder, ws]) => `${ws.slice(0, 2).map((w) => whoLabel(t, w, members, true)).join(', ')}${ws.length > 2 ? ' …' : ''}: ${fromText(t, folder, n.path)}`)
  return byFolder.size > 2 ? t('accessTree.source.more', { list: parts.join(' · '), n: byFolder.size - 2 }) : parts.join(' · ')
}

/** The risks the server computed, in words (the only warning colour on the tree); `long` for the folder's details. */
export function riskTexts(t: T, n: Pick<AccessTreeNode, 'risks'>, long = false): string[] {
  const key = (r: AccessTreeNode['risks'][number]): MessageKey =>
    r === 'everyone-writes' ? (long ? 'accessTree.risk.everyoneLong' : 'accessTree.risk.everyone') : r === 'skills-everyone-writes' ? (long ? 'accessTree.risk.skillsLong' : 'accessTree.risk.skills') : long ? 'accessTree.risk.rootLong' : 'accessTree.risk.root'
  return n.risks.map((r) => t(key(r)))
}

/** What a folder is, when it is more than a folder: a group's, a project's, connected, the team skills, users/. */
export function kindText(t: T, n: Pick<AccessTreeNode, 'kinds' | 'path' | 'projects'>): string | null {
  if (n.kinds.includes('personal')) return t('accessTree.kind.personal')
  if (n.kinds.includes('group')) return t('accessTree.kind.group')
  if (n.kinds.includes('project')) {
    const p = n.projects ?? []
    if (p.length === 1) return t('accessView.projectOf', { name: p[0]!.name })
    return p.length > 1 ? t('accessTree.kind.projects', { n: p.length }) : t('accessTree.kind.project')
  }
  if (n.kinds.includes('connected')) return t('accessTree.kind.connected')
  // skills/ as the server's skills check compares it: the first name without letter case or Unicode form
  const first = (n.path.split('/')[0] ?? '').normalize('NFC').toLowerCase()
  if (first === 'skills') return t(n.path.includes('/') ? 'accessTree.kind.skills' : 'accessTree.kind.skillsRoot')
  return null
}

/** Only part of the team can open it (the lock on a row). users/ is said in words instead. */
export const isRestricted = (n: Pick<AccessTreeNode, 'restricted' | 'kinds'>) => n.restricted && !n.kinds.includes('personal')

/** The row's name: the team root in words, else the folder's own name. */
export const nodeName = (t: T, n: Pick<AccessTreeNode, 'path' | 'name'>) => (n.path === '' ? t('accessView.rootFolder') : n.name)

/** The folder above a tree path ('' for a top folder; null for the root itself). */
export const parentOf = (p: string): string | null => (p === '' ? null : p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** Every folder above `p`, from the root down ('' first), not `p` itself. */
export function ancestorsOf(p: string): string[] {
  if (p === '') return []
  const segs = p.split('/')
  return segs.map((_, i) => segs.slice(0, i).join('/'))
}
