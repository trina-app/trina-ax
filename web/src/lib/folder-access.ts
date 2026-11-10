// Who can see a folder, on the Files page (docs/DECISIONS.md "Who can see a folder, in place"): where the chip shows and
// what it says. Words only: what a member may learn is decided by the server (GET /api/files/audience answers a count
// only where they can write), and admins' names come from the admin endpoints.
import type { Access, AccessTreeNode, AudienceSplit, FolderAudience, Project } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** Top folders that only hold folders with rules of their own: a count of the container itself would mislead. */
const CONTAINERS = new Set(['users', 'groups', 'projects', 'connected'])

/**
 * Where a folder's chip comes from, before anything is asked: `own` the caller's own folder (and anything in it),
 * `project` the folder of a team project they see (its `Project.audience`), `ask` a folder they can write (the server's
 * count), or none: the team root, the containers, someone else's personal folder (never listed anyway), a folder they
 * can only read or pass through.
 */
export type ChipPlace = 'own' | 'project' | 'ask'
export function chipPlace(path: string, o: { me: string; access: Access; project?: Project | null }): ChipPlace | null {
  if (path === '' || CONTAINERS.has(path)) return null
  const segs = path.split('/')
  if (segs[0] === 'users') return segs[1] === o.me ? 'own' : null
  if (o.project && !o.project.inTrash && o.project.audience !== undefined) return 'project'
  return o.access === 'write' ? 'ask' : null
}

/** No rule lets a member open it: only the owner and admins can (an admin's tree answer; never for members). */
export const adminsOnly = (self: Pick<AccessTreeNode, 'who'>, members: number) => members > 0 && !self.who.some((w) => w.reason === 'rule' && w.access !== 'none')

/** `people`: how many see it. With `byRole` (the owner and admins only: the server's AudienceSplit), `n` is the people
 * by its rules and `byRole` the owner and admins who see it only by their role; without it, `n` is everyone who sees it,
 * the owner and admins included (a member's answer). */
export type Chip = { kind: 'onlyYou' } | { kind: 'team' } | { kind: 'adminsOnly' } | { kind: 'people'; n: number; byRole?: number }

/** A count as a chip: apart when the server split it (nobody by a rule: the owner and admins only). */
const people = (n: number, split?: AudienceSplit): Chip =>
  !split ? { kind: 'people', n } : split.direct === 0 ? { kind: 'adminsOnly' } : { kind: 'people', n: split.direct, byRole: split.byRole }

/** What the chip says, once the answers it needs are here; null while they are not (never a wrong number). */
export function chipOf(place: ChipPlace | null, o: { audience?: FolderAudience | null; project?: Project | null; adminsOnly?: boolean }): Chip | null {
  if (place === 'own') return { kind: 'onlyYou' }
  if (place === 'project') return o.project?.audience !== undefined ? people(o.project.audience, o.project.audienceSplit) : null
  if (place !== 'ask' || o.audience?.people === undefined) return null
  if (o.adminsOnly) return { kind: 'adminsOnly' }
  return o.audience.everyone ? { kind: 'team' } : people(o.audience.people, o.audience.split)
}

/** The chip's words: "나만 봐요", "팀 전체가 봐요", "팀장과 관리자만", "3명" (by its rules: the owner and admins apart),
 * "6명이 봐요" (everyone, a member's count). */
export function chipText(t: T, c: Chip): string {
  if (c.kind === 'onlyYou') return t('folderAccess.onlyYou')
  if (c.kind === 'team') return t('folderAccess.team')
  if (c.kind === 'adminsOnly') return t('accessTree.who.adminsOnly')
  return c.byRole !== undefined ? t('folderAccess.direct', { n: c.n }) : t('folderAccess.people', { n: c.n })
}

/** The panel's headline: "3명이 봐요" by its rules (the role line follows), or a member's total, which says the owner
 * and admins are in it. */
export function headlineText(t: T, c: Chip): string {
  if (c.kind !== 'people') return chipText(t, c)
  return c.byRole !== undefined ? t('folderAccess.people', { n: c.n }) : t('folderAccess.peopleAll', { n: c.n })
}

/** Under the headline, quieter: "팀장·관리자 2명도 볼 수 있어요" (never a name); nothing when nobody sees it only by role. */
export function byRoleText(t: T, c: Chip): string | null {
  return c.kind === 'people' && c.byRole ? t('projects.whoByRole', { n: c.byRole }) : null
}

/** The chip's accessible name: the headline and the role line. */
export const chipLabel = (t: T, c: Chip): string => [headlineText(t, c), byRoleText(t, c)].filter(Boolean).join(' · ')
