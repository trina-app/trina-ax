// "Who can open it" on the Files page, for admins (docs/DECISIONS.md "Who can open it, like Drive's Share"): what the
// panel shows and when it asks before saving. Words and comparisons only: who can open what is the server's answer for
// the draft on screen (POST /api/admin/access/edit-preview, the permission function itself); nothing here decides access.
import type { Access, AccessTreeWho, FolderEditChange, FolderEditPreview, FolderEditWarning, Group, User } from '@mycel/shared/api'
import type { Basic, Draft } from './access-edit'
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }

/** A team project's folder in `projects/`, or anything inside it: the panel shows it and changes nothing there (its
 * people follow the project's members), and asks no admin endpoint about it. By its path, so a project list that failed
 * to load changes nothing. */
export const inProjects = (path: string) => /^projects\/[^/]+(\/|$)/.test(path)

/** The top folders that only hold folders with their own settings, and the team root: they have no panel. */
const NO_PANEL = new Set(['', 'users', 'groups', 'projects', 'connected'])
export const hasPanel = (path: string) => !NO_PANEL.has(path)

/** The folder that holds `path` ('' for a top folder); null for the team root. */
export const parentOf = (path: string): string | null => (path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** What "everyone" gets with a basic access (the general access): "same as above" is what the folder above gives. */
export const generalLevel = (basic: Basic, above: Access): Access => (basic === 'follow' ? above : basic === 'named' ? 'none' : basic)

/** The people and groups the folders above let in here (or keep out), from the server's answer: the person and group
 * rules of a folder above that decide for someone here. Groups first, then people, by name; "no access" last. */
export interface AboveRow { type: 'user' | 'group'; id: string; name: string; access: Access; folder: string }
export function aboveRows(next: readonly AccessTreeWho[], path: string): AboveRow[] {
  const out: AboveRow[] = []
  const seen = new Set<string>()
  for (const w of next) {
    if (w.reason !== 'rule' || w.folder === null || w.folder === path || !w.subject || w.count <= 0) continue
    if (w.subject.type !== 'user' && w.subject.type !== 'group') continue
    if (!w.subject.id) continue
    const k = `${w.subject.type}\u0000${w.subject.id}\u0000${w.folder}\u0000${w.access}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ type: w.subject.type, id: w.subject.id, name: w.subject.name ?? '', access: w.access, folder: w.folder })
  }
  return out.sort((a, b) => (a.access === 'none') !== (b.access === 'none') ? (a.access === 'none' ? 1 : -1)
    : a.type !== b.type ? (a.type === 'group' ? -1 : 1) : a.name.localeCompare(b.name))
}

/** A person set here who is also in a group set here with another setting: the person's own setting wins here (the
 * permission function's order), and the row says so. The first such group by name, or null. */
export function overridingGroup(d: Draft, userId: string, groups: ReadonlyMap<string, Group>): Group | null {
  const mine = d.named.find((n) => n.subjectType === 'user' && n.subjectId === userId)
  if (!mine) return null
  const hits = d.named
    .filter((n) => n.subjectType === 'group' && n.access !== mine.access)
    .map((n) => groups.get(n.subjectId))
    .filter((g): g is Group => !!g && g.memberIds.includes(userId))
    .sort((a, b) => a.name.localeCompare(b.name))
  return hits[0] ?? null
}

/** "In Sales, but can only view here" */
export function overrideText(t: T, group: string, mine: Access): string {
  return t(mine === 'write' ? 'folderAccess.inGroupEdit' : mine === 'read' ? 'folderAccess.inGroupView' : 'folderAccess.inGroupNone', { group })
}

/** Names said in a line: at most three, then "and N others" (the server sends up to 50 names of `count`). */
export function namesText(t: T, locale: string, names: readonly string[], count: number): string {
  const shown = names.slice(0, 3)
  const rest = Math.max(0, count - shown.length)
  if (rest > 0) return t('folderAccess.andOthers', { names: shown.join(', '), n: rest })
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(shown)
  } catch {
    return shown.join(', ')
  }
}

/** The kinds of change a line says, from the server's `changes` (before → after). */
export type ChangeKind = 'open' | 'edit' | 'lose' | 'viewOnly'
export const kindOf = (c: Pick<FolderEditChange, 'before' | 'after'>): ChangeKind =>
  c.before === 'none' ? 'open' : c.after === 'none' ? 'lose' : RANK[c.after] > RANK[c.before] ? 'edit' : 'viewOnly'

/** The people of one kind of change, merged (none → read and none → write are both "can open it"). */
export function peopleOf(changes: readonly FolderEditChange[], kind: ChangeKind): { names: string[]; count: number } {
  const hit = changes.filter((c) => kindOf(c) === kind)
  return { names: hit.flatMap((c) => c.people.map((p) => p.name)), count: hit.reduce((n, c) => n + c.count, 0) }
}

/** "What will happen", in plain lines with names: who will be able to open or edit it, who will no longer, from the
 * answer for exactly the draft on screen. `skills`: losing edit in skills/ means no longer changing the team's skills. */
export function outcomeLines(t: T, locale: string, data: Pick<FolderEditPreview, 'changes' | 'below'>, o: { skills: boolean }): { kind: ChangeKind | 'below' | 'none'; text: string }[] {
  const out: { kind: ChangeKind | 'below' | 'none'; text: string }[] = []
  const keys: Record<ChangeKind, MessageKey> = { open: 'folderAccess.willOpen', edit: 'folderAccess.willEdit', lose: 'folderAccess.willLose', viewOnly: o.skills ? 'folderAccess.willLoseSkills' : 'folderAccess.willViewOnly' }
  for (const kind of ['lose', 'viewOnly', 'open', 'edit'] as const) {
    const p = peopleOf(data.changes, kind)
    if (p.count > 0) out.push({ kind, text: t(keys[kind], { names: namesText(t, locale, p.names, p.count) }) })
  }
  if (!out.length && data.below.length) out.push({ kind: 'below', text: t('folderAccess.belowOnly', { n: data.below.length }) })
  if (!out.length) out.push({ kind: 'none', text: t('folderAccess.noChange') })
  return out
}

const key = (n: { subjectType: string; subjectId: string }) => `${n.subjectType}\u0000${n.subjectId}`

/**
 * Whether the draft lets anyone in more than the stored rules do, by the settings themselves: a person or group added
 * with view or edit or raised, a "no access" row raised or removed, the general access up (through what the folder above
 * gives where it follows it), or a row removed that names a switched-off person, or a group with one, while what they
 * then follow may give more. The server's head count misses these: switched-off people are not counted, and "everyone"
 * may count nobody today (every member named by a group) but lets in whoever joins.
 */
export function raisesAccess(o: { stored: Draft; draft: Draft; above: Access; users: ReadonlyMap<string, Pick<User, 'status'>>; groups: ReadonlyMap<string, Pick<Group, 'memberIds'>> }): boolean {
  const general = generalLevel(o.draft.basic, o.above)
  if (RANK[general] > RANK[generalLevel(o.stored.basic, o.above)]) return true
  const before = new Map(o.stored.named.map((n) => [key(n), n.access]))
  const after = new Map(o.draft.named.map((n) => [key(n), n.access]))
  for (const [k, a] of after) {
    const b = before.get(k)
    if (b === undefined ? a !== 'none' : RANK[a] > RANK[b]) return true
  }
  const off = (id: string) => o.users.get(id)?.status === 'disabled'
  for (const n of o.stored.named) {
    if (after.has(key(n))) continue
    if (n.access === 'none') return true
    // someone not counted now follows the rest of the rules, which may give them more than this row did
    const involvesOff = n.subjectType === 'user' ? off(n.subjectId) : (o.groups.get(n.subjectId)?.memberIds ?? []).some(off)
    if (involvesOff && n.access !== 'write') return true
  }
  return false
}

/** What Save asks before saving, from the fresh answer for the draft: more access (a gain counted by the server here
 * or in folders inside, a raised setting, everyone editing skills/), and the team's own files or skills taken from
 * members (the server's warnings). Nothing: save straight away (it only narrows, and "What will happen" named who). */
export interface SaveAsk { widen: boolean; narrow: FolderEditWarning[]; skillsEveryone: boolean }
export function saveAsk(data: Pick<FolderEditPreview, 'changes' | 'below' | 'warnings'>, raised: boolean): SaveAsk | null {
  const gains = data.changes.some((c) => c.direction === 'more') || data.below.some((b) => b.more > 0)
  const skillsEveryone = data.warnings.some((w) => w.kind === 'skills-everyone-writes')
  const narrow = data.warnings.filter((w) => w.kind === 'team-files' || w.kind === 'team-instructions')
  const widen = gains || raised || skillsEveryone || data.warnings.some((w) => w.kind === 'root-everyone')
  return widen || narrow.length ? { widen, narrow, skillsEveryone } : null
}

/** The confirm's title: how many more people can open it, else how many can edit it, else "Give more access?" (nobody
 * counted: switched-off people, whoever joins later); narrowing alone: "Take access away?". */
export function askTitle(t: T, data: Pick<FolderEditPreview, 'changes'>, ask: SaveAsk): string {
  if (!ask.widen) return t('folderAccess.narrowTitle')
  const open = peopleOf(data.changes, 'open').count
  if (open > 0) return t('folderAccess.confirmOpen', { n: open })
  const edit = peopleOf(data.changes, 'edit').count
  if (edit > 0) return t('folderAccess.confirmEdit', { n: edit })
  return t('folderAccess.confirmMore')
}

/** The two answers say the same thing on screen: the same changes (by whom), folders inside, warnings and what the
 * folders above give. Save compares the answer it asks again with the one shown; another one is shown first. */
export function sameOutcome(a: FolderEditPreview, b: FolderEditPreview): boolean {
  const sig = (p: FolderEditPreview) => JSON.stringify([
    p.hash,
    p.changes.map((c) => [c.direction, c.before, c.after, c.count, c.people.map((u) => u.id)]),
    p.below.map((x) => [x.path, x.less, x.more]),
    p.warnings.map((w) => [w.kind, w.count]),
    p.everyoneAbove ?? null,
    p.next.map((w) => [w.reason, w.folder, w.subject?.type ?? null, w.subject?.id ?? null, w.access, w.count]),
  ])
  return sig(a) === sig(b)
}
