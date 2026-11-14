// "Who can open it" on the Files page, for admins (docs/DECISIONS.md "Who can open it, like Drive's Share", "Folder access
// adds up like Google Drive (P2)"): what the
// panel shows and when it asks before saving. Words and comparisons only: who can open what is the server's answer for
// the draft on screen (POST /api/admin/access/edit-preview, the permission function itself); nothing here decides access.
import type { Access, AccessTreeWho, FolderEditChange, FolderEditPreview, FolderEditWarning } from '@mycel/shared/api'
import type { Basic } from './access-edit'
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }

/** A team project's folder in `projects/`, or anything inside it: the panel shows it and changes nothing there (its
 * people follow the project's members), and asks no admin endpoint about it. By its path (`projects` in any letter case,
 * as the server folds it), so a project list that failed to load changes nothing. */
export const inProjects = (path: string) => /^projects\/[^/]+(\/|$)/i.test(path)

/** The top folders that only hold folders with their own settings, and the team root: they have no panel. */
const NO_PANEL = new Set(['', 'users', 'groups', 'projects', 'connected'])
export const hasPanel = (path: string) => !NO_PANEL.has(path)

/** The folder that holds `path` ('' for a top folder); null for the team root. */
export const parentOf = (path: string): string | null => (path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * General access as Drive shows it (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"): Restricted, or the
 * team with a role. What the team gets here: its own setting, and on a folder that is not limited also what it gets from
 * the folders above (access adds up; the wider wins).
 */
export const generalLevel = (basic: Basic, limited: boolean, above: Access): Access => {
  const own: Access = basic === 'read' || basic === 'write' ? basic : 'none'
  return limited || RANK[own] >= RANK[above] ? own : above
}
export type Audience = 'restricted' | 'team'
export const audienceOf = (level: Access): Audience => (level === 'none' ? 'restricted' : 'team')

/**
 * The basic access a General access pick saves. Back to what the folder had: kept as it was. Restricted: no setting of
 * the team's here. On a folder that is not limited a role equal to what it gets from above needs no setting either. The
 * dialog offers nothing lower than that there: lower needs Limit access first (pickable).
 */
export function pickBasic(level: Access, o: { initial: Basic; limited: boolean; above: Access }): Basic {
  const own = o.initial === 'read' || o.initial === 'write' ? o.initial : 'none'
  if (level === own) return o.initial === 'read' || o.initial === 'write' ? o.initial : o.limited ? 'named' : 'follow'
  if (level === 'none') return o.limited ? 'named' : 'follow'
  if (!o.limited && level === o.above) return 'follow'
  return level
}
/** On a folder that is not limited, a team role (or Restricted) lower than what the folders above give cannot be chosen:
 * access adds up. */
export const pickable = (level: Access, o: { limited: boolean; above: Access }): boolean => o.limited || RANK[level] >= RANK[o.above]

/**
 * What a person or group row gets from the folders above (on a folder that is not limited), from the server's rows of
 * who decides with no rules here (`above`): the widest rule that applies to them, and its folder. A role below it cannot
 * be chosen here ("Editor from 'Company-wide'"). A person counts only their own rules above and the team's, never their
 * groups. null: nothing from above.
 */
export function inheritedOf(above: readonly AccessTreeWho[] | null | undefined, n: { subjectType: 'user' | 'group'; subjectId: string }): { access: Access; folder: string } | null {
  let best: { access: Access; folder: string } | null = null
  for (const w of above ?? []) {
    if (w.reason !== 'rule' || w.folder === null || !w.subject || w.access === 'none' || w.count <= 0) continue
    const s = w.subject
    const applies = s.type === 'everyone'
      // a person: their own rules above and the team's, never their groups (a group they leave later must not leave
      // them a raised row by name; re-review of #787, as the server's raiseToAbove)
      || (n.subjectType === 'user' && s.type === 'user' && s.id === n.subjectId)
      || (n.subjectType === 'group' && s.type === 'group' && s.id === n.subjectId)
    if (applies && (!best || RANK[w.access] > RANK[best.access])) best = { access: w.access, folder: w.folder }
  }
  return best
}

/** Drive's "Access removed" on a limited folder: the people who can open the folder above but not this one (the limit
 * stops them), from the folder answers of both (no row of their own here). */
export function removedPeople(here: readonly { user: { id: string; name: string }; access: Access; reason: { kind: string; cutAt?: string } }[], above: readonly { user: { id: string }; access: Access }[], path: string): { id: string; name: string }[] {
  const opensAbove = new Set(above.filter((p) => p.access !== 'none').map((p) => p.user.id))
  return here.filter((p) => p.access === 'none' && p.reason.kind === 'no-rule' && p.reason.cutAt === path && opensAbove.has(p.user.id))
    .map((p) => p.user).sort((a, b) => a.name.localeCompare(b.name))
}

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

/** Names said in a line: at most three, then "and N others" (the server sends up to 50 names of `count`). */
export function namesText(t: T, locale: string, names: readonly string[], count: number): string {
  const shown = names.slice(0, 3)
  const rest = Math.max(0, count - shown.length)
  if (rest > 0) return t('folderAccess.andOthers', { names: shown.join(', '), n: rest })
  if (locale.startsWith('ko')) return shown.join(', ')
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

/** Who gains that no head count can see, by name, a line each (the confirm before Save): people switched off, whoever
 * joins these groups, whoever joins the team. "Can open it" when they only get view, "open or edit" when one of them
 * gets edit somewhere (QA TC-232), or when the answer does not say (an older server). The groups group by group: the
 * ones whose new people get edit in one line, the ones whose new people only open it in another (QA TC-284); an answer
 * without a group's own `edit` (an older server) says them in one line, as before. */
export function latentLines(t: T, locale: string, latent: FolderEditPreview['latent'], team: string): string[] {
  if (!latent) return []
  const edit = latent.edit ?? { team: true, off: true, groups: true }
  const out: string[] = []
  if (latent.off.length) out.push(t(edit.off ? 'folderAccess.latentOff' : 'folderAccess.latentOffView', { names: namesText(t, locale, latent.off.map((u) => u.name), latent.off.length) }))
  const groupsLine = (gs: { name: string }[], canEdit: boolean) => {
    if (gs.length) out.push(t(canEdit ? 'folderAccess.latentGroups' : 'folderAccess.latentGroupsView', { groups: namesText(t, locale, gs.map((g) => g.name), gs.length) }))
  }
  if (latent.groups.some((g) => g.edit !== undefined)) {
    groupsLine(latent.groups.filter((g) => g.edit !== false), true)
    groupsLine(latent.groups.filter((g) => g.edit === false), false)
  } else groupsLine(latent.groups, edit.groups)
  if (latent.team) out.push(t(edit.team ? 'folderAccess.latentTeam' : 'folderAccess.latentTeamView', { team }))
  return out
}

/** What Save asks before saving, from the server's fresh answer for exactly the draft (nothing here guesses): more
 * access, counted (`changes`, here or in folders inside: exact for everyone in the team now) or not (`latentMore`: a
 * person switched off, whoever joins the team or a group the rules name), or everyone editing skills/; and the team's
 * own files or skills taken from members (the server's warnings). Nothing: save straight away (it only narrows, or
 * changes nobody, and "What will happen" named who). `later`: the more access is only for people not counted now. */
export interface SaveAsk { widen: boolean; later: boolean; narrow: FolderEditWarning[]; skillsEveryone: boolean }
export function saveAsk(data: Pick<FolderEditPreview, 'changes' | 'below' | 'warnings' | 'latentMore'>): SaveAsk | null {
  const counted = data.changes.some((c) => c.direction === 'more') || data.below.some((b) => b.more > 0)
  const later = !counted && data.latentMore === true
  const skillsEveryone = data.warnings.some((w) => w.kind === 'skills-everyone-writes')
  const narrow = data.warnings.filter((w) => w.kind === 'team-files' || w.kind === 'team-instructions')
  const widen = counted || data.latentMore === true || skillsEveryone || data.warnings.some((w) => w.kind === 'root-everyone')
  return widen || narrow.length ? { widen, later, narrow, skillsEveryone } : null
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
