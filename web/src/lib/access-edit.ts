// Admin › Folder permissions › the edit panel (stage 5): a folder's rules as the panel shows them, and back. Nothing
// here decides access: what a draft changes comes from the server (POST /api/admin/access/edit-preview,
// server/src/admin/access-edit.ts). The panel asks one thing first, the basic access for everyone not named below it,
// then the people and groups named; old role rows are read as the basic access and saved as "everyone".
//
// Why this conversion changes nobody's access (tests/unit/access-edit-api.test.ts checks it on random worlds): rules
// change nothing for the owner and admins (they write everywhere a rule can reach), so a "role admin" row has no effect,
// and every other person has the role "member", so "role member X" gives the same as "everyone X" except that inside one
// folder the role step comes before the everyone step. Both in one folder: the member row decides for everyone it can
// decide for. So "member X" (else "everyone Y") saved as "everyone X" (resp. Y) is the same for every person.
import type { Access, FolderEditPreview, FolderRuleInput } from '@mycel/shared/api'

/** The basic access, for everyone the rows below do not name: follow the folder above (no everyone rule), only the
 * people named (everyone: none), everyone reads, everyone reads and writes. */
export type Basic = 'follow' | 'named' | 'read' | 'write'
export const BASICS: readonly Basic[] = ['follow', 'named', 'read', 'write']
/** A person or a group named in the folder's rules, with their access there ("none" keeps them out of an open folder). */
export interface Named { subjectType: 'user' | 'group'; subjectId: string; access: Access }
export interface Draft { basic: Basic; named: Named[] }
/** A rule as the API has it. */
export interface RuleLike { subjectType: string; subjectId: string | null; access: Access }

/** What the stored rules hold that the panel will save another way (one line says so; access stays the same). */
export interface Converted { member: boolean; admin: boolean }

const basicOf = (a: Access | undefined): Basic | undefined => (a === undefined ? undefined : a === 'none' ? 'named' : a)

/**
 * The draft for a folder's rules. The basic access is the "member" row's access when there is one (it decides for
 * every member before an everyone row does), else the everyone row's, else "follow". At the team root there is no
 * folder above: no everyone rule there is "only the people named" too (nobody else gets a rule).
 */
export function draftOf(rules: readonly RuleLike[], root: boolean): { draft: Draft; converted: Converted } {
  const member = rules.find((r) => r.subjectType === 'role' && r.subjectId === 'member')
  const every = rules.find((r) => r.subjectType === 'everyone')
  const basic = basicOf((member ?? every)?.access) ?? (root ? 'named' : 'follow')
  const named = rules.filter((r): r is Named => (r.subjectType === 'user' || r.subjectType === 'group') && !!r.subjectId).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access }))
  return { draft: { basic, named }, converted: { member: !!member, admin: rules.some((r) => r.subjectType === 'role' && r.subjectId === 'admin') } }
}

/**
 * The rules a draft saves: the people and groups named, then the basic access as an everyone rule ("follow": none).
 * At the team root, "only the people named" is no everyone rule unless the root had "everyone: none" (both give nobody
 * but the owner and admins; the stored form is kept).
 */
export function rulesOf(draft: Draft, o: { root: boolean; rootNoneRow?: boolean }): FolderRuleInput[] {
  const out: FolderRuleInput[] = draft.named.map((n) => (n.subjectType === 'user' ? { subjectType: 'user', subjectId: n.subjectId, access: n.access } : { subjectType: 'group', subjectId: n.subjectId, access: n.access }))
  const every: Access | null = draft.basic === 'follow' ? null : draft.basic === 'named' ? (o.root && !o.rootNoneRow ? null : 'none') : draft.basic
  if (every) out.push({ subjectType: 'everyone', subjectId: null, access: every })
  return out
}

/** The root had "everyone: none" (or "member: none"): kept as it is when the root stays "only the people named". */
export const rootNoneRow = (rules: readonly RuleLike[]) => draftOf(rules, true).draft.basic === 'named' && rules.some((r) => (r.subjectType === 'everyone' || (r.subjectType === 'role' && r.subjectId === 'member')) && r.access === 'none')

const ruleKey = (r: RuleLike) => `${r.subjectType}\u0000${r.subjectId ?? ''}\u0000${r.access}`
/** The same rules, in any order. */
export function sameRules(a: readonly RuleLike[], b: readonly RuleLike[]): boolean {
  if (a.length !== b.length) return false
  const x = a.map(ruleKey).sort()
  const y = b.map(ruleKey).sort()
  return x.every((k, i) => k === y[i])
}
/** One string per set of rules (in the order given): the server's answer is kept by it, and an older one dropped. */
export const rulesKey = (rules: readonly RuleLike[]) => rules.map(ruleKey).join('\u0001')
/** One string per draft: whether the admin changed anything. */
export const draftKey = (d: Draft) => `${d.basic}\u0002${d.named.map((n) => `${n.subjectType}\u0000${n.subjectId}\u0000${n.access}`).join('\u0001')}`

/** The draft with a person or group added (read, at the end), or with their access changed, or without them. */
export const addNamed = (d: Draft, n: Omit<Named, 'access'>, access: Access = 'read'): Draft =>
  d.named.some((x) => x.subjectType === n.subjectType && x.subjectId === n.subjectId) ? d : { ...d, named: [...d.named, { ...n, access }] }
export const setNamed = (d: Draft, i: number, access: Access): Draft => ({ ...d, named: d.named.map((x, j) => (j === i ? { ...x, access } : x)) })
export const removeNamed = (d: Draft, i: number): Draft => ({ ...d, named: d.named.filter((_, j) => j !== i) })

/** What the Save button says, from the answer for this draft: how many people lose and gain access. */
export type SaveImpact = { kind: 'none' } | { kind: 'less'; n: number } | { kind: 'more'; n: number } | { kind: 'both'; less: number; more: number }
export function saveImpact(p: Pick<FolderEditPreview, 'less' | 'more'>): SaveImpact {
  if (p.less && p.more) return { kind: 'both', less: p.less, more: p.more }
  if (p.less) return { kind: 'less', n: p.less }
  if (p.more) return { kind: 'more', n: p.more }
  return { kind: 'none' }
}

/** The choices of the basic access a folder offers: no "follow" at the team root (nothing is above it); no "everyone
 * writes" in a connected folder (a one-way copy, server/src/team-files/connected.ts: what is written there never reaches
 * the source, and a file changed there stops following it), unless it is what the folder has now (shown as it is, not
 * dropped unseen). */
export function basicChoices(o: { root: boolean; connected: boolean; current: Basic }): Basic[] {
  return BASICS.filter((b) => !(o.root && b === 'follow') && !(o.connected && b === 'write' && o.current !== 'write'))
}
