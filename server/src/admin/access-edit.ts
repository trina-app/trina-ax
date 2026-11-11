// Admin › Folder permissions › the edit panel (stage 5): what saving one folder's rules would change, asked while the
// admin edits (POST /api/admin/access/edit-preview), and the hash of a folder's rules that a save sends back, so a save
// over another admin's change is refused (409) instead of undoing it unseen. Like ./access-tree.ts this reads nothing:
// the server (admin/access-explain.ts) gives it the rules and the people, the web mock server
// (web/test/mock/server.ts) its own, and both answer with it. Every access here is RuleSet.access / explain, the same
// computation as the permission function; nothing here decides access, and nothing is saved.
//
// Why only the folder and the rule folders below it: the edit replaces the rules of one folder P. A folder below P
// without rules of its own between it and P answers like P for every person (decide() walks up to the first folder
// with a rule for them). A rule folder Q below P answers like P for the people that no rule from Q up to P (P left out)
// names, and is unchanged for the others. So a person whose access at P does not change has no change anywhere.
import { createHash } from 'node:crypto'
import type { Access, FolderEditBelow, FolderEditChange, FolderEditPreview, FolderEditWarning } from '@mycel/shared/api'
import { RuleSet, type DecidingRule, type Principal } from '../policy/access'
import { byPerson, cmp, segsOf, shownSegs } from './access-rows'
import { isSkills, rootOpensTo, treeCmp, whoAt } from './access-tree'

/** A rule as the API and the database have it (FolderRuleInput, DecidingRule, a row of `folder_rules`). */
export interface RuleLike { subjectType: string; subjectId: string | null; access: string }

/** The hash of one folder's rules: the same rules in any order give the same hash, and no rules the hash of none
 * (`Folder.rulesHash`, `FolderEditPreview.hash`). A save that sends the hash it started from is refused when the rules
 * are not those any more. */
export function rulesHash(rules: readonly RuleLike[]): string {
  const lines = rules.map((r) => `${r.subjectType}\u0000${r.subjectId ?? ''}\u0000${r.access}`).sort(cmp)
  return createHash('sha256').update(`rules-v1\u0002${lines.join('\u0001')}`).digest('base64url').slice(0, 32)
}

/** Every rule of `rules`, with the folder `at`'s replaced by `next` (none: the folder has no rules of its own). */
export function withRules(rules: RuleSet, at: string, next: readonly RuleLike[]): RuleSet {
  const rows: ConstructorParameters<typeof RuleSet>[0] = []
  for (const f of rules.ruleFolders()) {
    if (f === at) continue
    for (const r of rules.rulesAt(f)) rows.push({ path: f, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access })
  }
  for (const r of next) rows.push({ path: at, subject_type: r.subjectType as DecidingRule['subjectType'], subject_id: r.subjectId, access: r.access as Access })
  return new RuleSet(rows)
}

/** At most this many people are named per change; this many folders below are listed, each with this many names. */
export const EDIT_PEOPLE = 50
export const EDIT_BELOW = 20
export const EDIT_BELOW_PEOPLE = 5

export interface EditSource {
  /** the rules now */
  rules: RuleSet
  /** active people */
  people: readonly Principal[]
  /** people switched off (not deleted): not counted, but what they would get when switched back on is (`latentMore`) */
  uncounted?: readonly Principal[]
  groupName(id: string): string | null
  personName(id: string): string | null
}

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
/** `q` is strictly below `p` ('' = the team root) */
const strictlyBelow = (q: string, p: string) => q !== p && (p === '' || q.startsWith(p + '/'))
/** the step of "everyone" in rules: everyone, or every member (a role rule beats everyone for members) */
const everyoneStep = (r: RuleLike) => r.subjectType === 'everyone' || (r.subjectType === 'role' && r.subjectId === 'member')
const everyoneWrites = (rules: readonly RuleLike[]) => {
  // a member rule decides for members before an everyone rule does
  const member = rules.find((r) => r.subjectType === 'role' && r.subjectId === 'member')
  return (member ?? rules.find((r) => r.subjectType === 'everyone'))?.access === 'write'
}
/** a rule is for this person (policy/access.ts applies(), on the API's shape) */
const appliesTo = (r: DecidingRule, p: Principal) =>
  r.subjectType === 'everyone' || (r.subjectType === 'role' ? r.subjectId === p.role : r.subjectType === 'group' ? r.subjectId !== null && p.groups.includes(r.subjectId) : r.subjectId === p.id)

/**
 * People that no rule on the way from the folder up, nor any rule folder below it, can tell apart (the same role, the
 * same groups among those such rules name, not named by a person rule there, before or after the edit): they get the
 * same answer everywhere this edit can reach, so each class is computed once, on one of them.
 */
function classes(people: readonly Principal[], rulesets: readonly RuleSet[], path: string): Principal[][] {
  const groups = new Map<string, number>()
  const named = new Set<string>()
  const segs = segsOf(path)
  for (const rs of rulesets) {
    const folders = new Set<string>()
    for (let len = segs.length; len >= 0; len--) folders.add(segs.slice(0, len).join('/'))
    for (const f of rs.ruleFolders()) if (strictlyBelow(f, path)) folders.add(f)
    for (const f of folders) {
      for (const r of rs.rulesAt(f)) {
        if (r.subjectId === null) continue
        if (r.subjectType === 'group' && !groups.has(r.subjectId)) groups.set(r.subjectId, groups.size)
        else if (r.subjectType === 'user') named.add(r.subjectId)
      }
    }
  }
  const out = new Map<string, Principal[]>()
  for (const p of people) {
    const key = named.has(p.id) ? `u\u0000${p.id}` : `${p.role}\u0000${[...new Set(p.groups.map((g) => groups.get(g)).filter((i): i is number => i !== undefined))].sort((a, b) => a - b).join(',')}`
    const c = out.get(key)
    if (c) c.push(p)
    else out.set(key, [p])
  }
  return [...out.values()]
}

/**
 * The rule folders strictly below `path` that the answers may show, in the tree's order, with the nearest such folder
 * above each one (-1: none between it and `path`) and its rules. Every folder on the way from a shown folder up is
 * shown too, so a rule that decides on the way from one of them up to `path` is in this list.
 */
function belowOf(rules: RuleSet, path: string) {
  const paths = rules.ruleFolders().filter((q) => strictlyBelow(q, path) && shownSegs(q) !== null).sort(treeCmp)
  const index = new Map(paths.map((q, i) => [q, i]))
  const top = segsOf(path).length
  const parent = paths.map((q) => {
    const segs = segsOf(q)
    for (let k = segs.length - 1; k > top; k--) {
      const j = index.get(segs.slice(0, k).join('/'))
      if (j !== undefined) return j
    }
    return -1
  })
  return { paths, parent, rules: paths.map((q) => rules.rulesAt(q)) }
}

/**
 * Which of those folders `p` falls through to `path` from: no rule on the way up from the folder to `path` (left out)
 * is for them, so their access there is their access at `path` and changes with it. In the tree's order the folder
 * above comes first: one pass, one look at each folder's own rules (the walk of decide(), cut at `path`).
 */
function fallsThrough(below: ReturnType<typeof belowOf>, p: Principal): Uint8Array {
  const out = new Uint8Array(below.paths.length)
  for (let i = 0; i < out.length; i++) {
    const up = below.parent[i]!
    // decided at a folder above it (and below `path`): so is this one
    if (up >= 0 && !out[up]) continue
    out[i] = below.rules[i]!.some((r) => appliesTo(r, p)) ? 0 : 1
  }
  return out
}

/**
 * What saving `next` as the rules of `path` changes ('' = the team root; actual names on disk). `team`: the folder is
 * the team's shared/ or skills/ (the caller compares names the way the volume does). `chats`: how many chats of a person
 * start a fresh AI session when they lose read there (H7; the mock has none).
 */
export function editPreview(src: EditSource, path: string, next: readonly RuleLike[], o: { team: 'shared' | 'skills' | null; chats?: (userId: string) => number }):
  Omit<FolderEditPreview, 'path' | 'exists' | 'connected'> {
  const segs = segsOf(path)
  const before = src.rules
  const after = withRules(before, path, next)
  const current = before.rulesAt(path)
  const ws = { people: src.people, groupName: src.groupName, personName: src.personName }
  const now = whoAt({ ...ws, rules: before }, segs)
  const nextWho = whoAt({ ...ws, rules: after }, segs)
  const above = segs.length ? whoAt({ ...ws, rules: withRules(before, path, []) }, segs) : null
  // "the same as the folder above", in one line: what a member whom no person or group rule names gets here with no
  // rules of its own, and the folder whose rule decides it (null: no rule on the way up lets them in). Asked of the
  // permission function itself, for a member who is nobody (no groups, an id no person can have).
  const everyoneAbove = segs.length ? plainAbove(withRules(before, path, []), segs) : null

  // the rule folders below, the same before and after (only `path` changes)
  const below = belowOf(before, path)
  type Changed = { people: Principal[]; direction: FolderEditChange['direction']; before: Access; after: Access; through: Uint8Array | null }
  const changed: Changed[] = []
  for (const c of classes(src.people, [before, after], path)) {
    const p = c[0]!
    const b = before.access(p, segs)
    const a = after.access(p, segs)
    if (a === b) continue
    changed.push({ people: c, direction: RANK[a] < RANK[b] ? 'less' : 'more', before: b, after: a, through: below.paths.length ? fallsThrough(below, p) : null })
  }

  // the people whose access changes, grouped by the change (at most six groups)
  const byChange = new Map<string, { direction: FolderEditChange['direction']; before: Access; after: Access; people: Principal[] }>()
  let less = 0
  let more = 0
  let membersLosingRead = 0
  for (const c of changed) {
    if (c.direction === 'less') less += c.people.length
    else more += c.people.length
    if (c.after === 'none' && c.people[0]!.role === 'member') membersLosingRead += c.people.length
    const key = `${c.before}\u0000${c.after}`
    const g = byChange.get(key)
    if (g) g.people.push(...c.people)
    else byChange.set(key, { direction: c.direction, before: c.before, after: c.after, people: [...c.people] })
  }
  const changes: FolderEditChange[] = [...byChange.values()]
    .sort((x, y) =>
      (x.direction === y.direction ? 0 : x.direction === 'less' ? -1 : 1)
      // the biggest losses first (write → none, read → none, write → read); the widest gains first
      || (x.direction === 'less' ? RANK[x.after] - RANK[y.after] || RANK[y.before] - RANK[x.before] : RANK[y.after] - RANK[x.after] || RANK[x.before] - RANK[y.before]))
    .map((g) => {
      const people = [...g.people].sort(byPerson)
      const losesRead = g.after === 'none' && g.before !== 'none'
      return {
        direction: g.direction, before: g.before, after: g.after,
        people: people.slice(0, EDIT_PEOPLE).map((u) => ({ id: u.id, name: u.name })), count: people.length,
        chatsReset: losesRead && o.chats ? people.reduce((n, u) => n + o.chats!(u.id), 0) : 0,
      }
    })

  // the rule folders below that change with it, in the tree's order: how many lose and gain there, and the first names
  const counts = below.paths.map(() => ({ less: 0, more: 0 }))
  for (const c of changed) if (c.through) for (let i = 0; i < counts.length; i++) if (c.through[i]) counts[i]![c.direction] += c.people.length
  const hit = counts.map((n, i) => (n.less + n.more ? i : -1)).filter((i) => i >= 0)
  const shown = hit.slice(0, EDIT_BELOW)
  const belowRows: FolderEditBelow[] = shown.map((i) => {
    const people = changed.filter((c) => c.through![i]).flatMap((c) => c.people).sort(byPerson)
    return { path: below.paths[i]!, less: counts[i]!.less, more: counts[i]!.more, people: people.slice(0, EDIT_BELOW_PEOPLE).map((u) => ({ id: u.id, name: u.name })) }
  })

  const warnings: FolderEditWarning[] = []
  if (o.team && membersLosingRead > 0) warnings.push({ kind: o.team === 'shared' ? 'team-files' : 'team-instructions', count: membersLosingRead })
  // everyone gets write in skills/: every member manages the team's skills and rules (the step for everyone, by the
  // rules; a group or person rule may still keep someone at read)
  if (isSkills(path) && everyoneWrites(next) && !everyoneWrites(current)) {
    warnings.push({ kind: 'skills-everyone-writes', count: nextWho.filter((w) => w.reason === 'rule' && w.access === 'write' && w.folder === path && !!w.subject && everyoneStep({ subjectType: w.subject.type, subjectId: w.subject.id, access: w.access })).reduce((n, w) => n + w.count, 0) })
  }
  if (segs.length === 0 && rootOpensTo(nextWho) && !rootOpensTo(now)) {
    warnings.push({ kind: 'root-everyone', count: nextWho.filter((w) => w.reason === 'rule' && w.folder === '' && w.access !== 'none' && !!w.subject && everyoneStep({ subjectType: w.subject.type, subjectId: w.subject.id, access: w.access })).reduce((n, w) => n + w.count, 0) })
  }

  return {
    current, hash: rulesHash(current),
    people: src.people.length, members: src.people.filter((p) => p.role === 'member').length,
    now, next: nextWho, above, everyoneAbove, ...latentOf(src, before, after, path, below.paths), changes, below: belowRows, belowMore: hit.length - shown.length, less, more, warnings,
  }
}

/**
 * Whether the rules give more to someone the head count above cannot see (FolderEditPreview.latentMore): a person
 * switched off (they get it when switched back on), a member nobody names (whoever joins the team), or whoever joins
 * the groups the rules name later: one made-up member per group, per pair of the groups named on the way to the folder
 * and below it (group rules take the widest, so being in two groups can differ from either alone), and one in all of
 * them. At the folder and at each rule folder below it, asked of the permission function before and after.
 */
function latentOf(src: EditSource, before: RuleSet, after: RuleSet, path: string, belowPaths: readonly string[]): Pick<FolderEditPreview, 'latentMore' | 'latent'> {
  const groups = new Set<string>()
  for (const rs of [before, after]) for (const f of rs.ruleFolders()) for (const r of rs.rulesAt(f)) if (r.subjectType === 'group' && r.subjectId) groups.add(r.subjectId)
  // the groups named on the way up to the folder, at it and below it: the ones whose combinations can decide there
  const segs = segsOf(path)
  const near = new Set<string>()
  const folders = [...Array.from({ length: segs.length + 1 }, (_, len) => segs.slice(0, len).join('/')), ...belowPaths]
  for (const rs of [before, after]) for (const f of folders) for (const r of rs.rulesAt(f)) if (r.subjectType === 'group' && r.subjectId) near.add(r.subjectId)
  const at = [segs, ...belowPaths.map(segsOf)]
  const gains = (p: Principal) => at.some((s) => RANK[after.access(p, s)] > RANK[before.access(p, s)])
  const member = (id: string, gs: string[]): Principal => ({ id: `\u0000${id}`, name: '', role: 'member', groups: gs })
  // who: whoever joins the team, people switched off by name, whoever joins these groups
  const team = gains(NOBODY)
  const off = (src.uncounted ?? []).filter(gains)
  const named = new Set([...groups].filter((g) => gains(member(`group:${g}`, [g]))))
  const list = [...near]
  // pairs while they stay few (30 groups: 435); and always everyone in all of them. Known limit: with more than 30
  // groups named on the way, pairs are not tried, and the one member in all of them can miss a pair that gains when
  // being in all of them already gave more before the change
  if (list.length <= 30) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (gains(member(`pair:${list[i]}:${list[j]}`, [list[i]!, list[j]!]))) for (const g of [list[i]!, list[j]!]) named.add(g)
  }
  if (list.length > 2 && !named.size && gains(member('all-groups', list))) for (const g of list) named.add(g)
  const more = team || off.length > 0 || named.size > 0
  return {
    latentMore: more,
    latent: more ? {
      team,
      off: [...off].sort(byPerson).slice(0, EDIT_PEOPLE).map((u) => ({ id: u.id, name: u.name })),
      groups: [...named].map((id) => ({ id, name: src.groupName(id) ?? id })).sort((a, b) => cmp(a.name, b.name)),
    } : null,
  }
}

/** A member no person or group rule can name: what the folders above give "everyone" (FolderEditPreview.everyoneAbove). */
const NOBODY: Principal = { id: '\u0000everyone', name: '', role: 'member', groups: [] }
function plainAbove(rules: RuleSet, segs: readonly string[]): NonNullable<FolderEditPreview['everyoneAbove']> {
  const e = rules.explain(NOBODY, segs)
  return { access: e.access, folder: e.reason.kind === 'rule' ? e.reason.folder : null }
}
