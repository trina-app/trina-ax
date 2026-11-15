// The words for who can open a folder, as the server grouped them (AccessTreeWho; server/src/admin/access-tree.ts): the
// team skills page's "who can change the team's skills" and folder names. Nothing here decides access. Admin › Folder
// permissions' tree and By person, which used most of this file, were replaced by two lists in P1.5 (docs/DECISIONS.md
// "드라이브처럼 공유 P1.5"; pages/admin/FolderLists.tsx).
import type { AccessTreeWho, Folder } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

type T = (key: MessageKey, params?: Params) => string

/** skills/ and below, as the server's skills check compares it (server/src/skills/guard.ts inSkills): the first name
 * without letter case or Unicode form, so a team folder that serves `Skills/` is the team's AI instructions too */
export const isSkillsPath = (p: string) => (p.split('/')[0] ?? '').normalize('NFC').toLowerCase() === 'skills'
export const isPersonalPath = (p: string) => p === 'users' || p.startsWith('users/')

/** A folder in the words of this screen: the team root by its one name, a personal folder (the only one an answer
 * names is the person's own) as "their personal folder". */
export function folderName(t: T, p: string): string {
  if (p === '') return t('accessView.rootFolder')
  if (p === 'users' || p.startsWith('users/')) return t('accessView.ownFolderName')
  return p
}

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

const subjectKey = (w: AccessTreeWho) => (w.subject ? `${w.subject.type}:${w.subject.id ?? ''}` : '')

/** The people a rule lets write, merged by whom the rule names (a group deciding at two folders is one entry). Groups
 * and people first, then everyone ("그 밖의 2명" reads as the rest only after the names). */
function writers(who: readonly AccessTreeWho[]): AccessTreeWho[] {
  const by = new Map<string, AccessTreeWho>()
  for (const w of who) {
    if (w.reason !== 'rule' || w.access !== 'write') continue
    const k = subjectKey(w)
    const had = by.get(k)
    by.set(k, had ? { ...had, count: had.count + w.count } : w)
  }
  const named = (w: AccessTreeWho) => w.subject?.type === 'group' || w.subject?.type === 'user'
  return [...by.values()].sort((x, y) => Number(named(y)) - Number(named(x)))
}

/** skills/ and its folders: "고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, Bob 님", from the folder's people as the server
 * grouped them (the owner and admins always can; write there is "팀 스킬 관리"). The Team skills page's line and
 * Admin › Folder permissions say the same. `byFolder` (the Team skills page): how many folders inside skills/ have
 * editors of their own, counted at the end ("폴더별로 맡긴 곳 2개"); then it is never "only the owner and admins", nor
 * when it is not known (null): the owner and admins are named without "only". */
export function skillEditorsText(t: T, who: readonly AccessTreeWho[], members: number, byFolder: number | null = 0): string {
  const ws = writers(who)
  const tail = byFolder ? t('skillMgr.byFolderCount', { n: byFolder }) : null
  if (!ws.length) return tail ? t('skillMgr.editors', { list: tail }) : t(byFolder === null ? 'skillMgr.editorsBase' : 'skillMgr.editorsAdmins')
  const parts = ws.slice(0, WHO_NAMED).map((w) => whoLabel(t, w, members))
  const rest = ws.slice(WHO_NAMED).reduce((n, w) => n + w.count, 0)
  const list = rest > 0 ? t('accessTree.who.more', { list: parts.join(', '), n: rest }) : parts.join(', ')
  return t('skillMgr.editors', { list: tail ? `${list}, ${tail}` : list })
}

/** The folders inside skills/ whose own rules let someone beyond the owner and admins write there: everyone, the old
 * "members" row, a group, a person ("admins: write" changes nobody). From the rule rows Admin › Folder permissions
 * lists (GET /api/admin/folders), folders on disk the tree shows. */
export function skillFoldersWithEditors(rows: readonly Pick<Folder, 'path' | 'exists' | 'hidden' | 'rules'>[]): number {
  const gives = (r: Folder['rules'][number]) => r.access === 'write' && !(r.subjectType === 'role' && r.subjectId !== 'member')
  return rows.filter((f) => isSkillsPath(f.path) && f.path.includes('/') && f.exists && !f.hidden && f.rules.some(gives)).length
}

/** A person's or a group's own rule on skills/ (or a folder in it) decided: what the team skills dialog lists and
 * removes (PUT /api/admin/skill-managers). */
const ownSkillsRule = (w: AccessTreeWho) => !!w.subject && (w.subject.type === 'user' || w.subject.type === 'group') && w.folder !== null && isSkillsPath(w.folder)

/** skills/' editors through a rule that is not their own rule there: everyone, the old "members" row, a rule on the
 * team root ("모두", "Bob 님"). The team skills dialog names them and links to Folder permissions, where those rules
 * are changed. */
export function skillEditorsElsewhere(t: T, who: readonly AccessTreeWho[], members: number): string[] {
  return writers(who.filter((w) => !ownSkillsRule(w))).map((w) => whoLabel(t, w, members))
}
