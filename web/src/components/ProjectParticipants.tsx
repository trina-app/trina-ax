// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/"): the participant picker of the project
// create, edit and share dialogs, and the "볼 수 있는 사람" line under it. People come from the people directory
// (/api/people, every member may read it); groups ("부서" in Korean copy) are a member's own groups (Me.groups) and, for
// admins, every group (Admin › Groups). The creator, the owner and admins always see the project: the line says so. The
// count is the server's (POST /api/projects/access-preview), so it matches who really sees it.
import { useEffect, useId, useMemo, useState } from 'react'
import { Search, Users } from 'lucide-react'
import type { Group, ProjectAccessPreview, ProjectParticipant } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { usePeopleList } from '../store/people'
import { isAdmin, useMe } from '../store/session'

export const participantKey = (x: { subjectType: string; subjectId: string }) => `${x.subjectType}:${x.subjectId}`
export const sameParticipants = (a: readonly ProjectParticipant[], b: readonly ProjectParticipant[]) => {
  const ka = new Set(a.map(participantKey))
  return ka.size === new Set(b.map(participantKey)).size && b.every((x) => ka.has(participantKey(x)))
}

export interface ParticipantOption extends ProjectParticipant { name: string }

/** What the picker offers: groups (a member's own; every group for admins), then the active people, both by name. */
export function useParticipantOptions(extra: readonly ParticipantOption[] = []): ParticipantOption[] {
  const me = useMe()
  const people = usePeopleList()
  const admin = isAdmin(me)
  const [allGroups, setAllGroups] = useState<Group[] | null>(null)
  useEffect(() => {
    if (!admin) return
    let live = true
    api.call(API.listGroups).then((r) => live && setAllGroups(r.items), () => live && setAllGroups([]))
    return () => { live = false }
  }, [admin])
  return useMemo(() => {
    const groups = (admin ? allGroups ?? [] : me?.groups ?? []).map((g) => ({ subjectType: 'group' as const, subjectId: g.id, name: g.name }))
    const persons = (people ?? []).map((p) => ({ subjectType: 'user' as const, subjectId: p.id, name: p.name }))
    const out = new Map<string, ParticipantOption>()
    for (const x of [...groups.sort(byName), ...persons.sort(byName), ...extra]) if (!out.has(participantKey(x))) out.set(participantKey(x), x)
    return [...out.values()]
  }, [admin, allGroups, me, people, extra])
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

/**
 * A searchable list of groups and people with a checkbox each. `fixed`: always on and not changeable here (the creator,
 * a person or group with a rule set in Admin › Folder permissions); `tags` says why beside the name.
 */
export function ParticipantPicker({ options, value, onChange, fixed = new Map(), testId = 'project-participants' }: {
  options: readonly ParticipantOption[]
  value: readonly ProjectParticipant[]
  onChange: (v: ProjectParticipant[]) => void
  /** key → the tag shown instead of a checkbox (e.g. "만든 사람") */
  fixed?: ReadonlyMap<string, string>
  testId?: string
}) {
  const t = useT()
  const [q, setQ] = useState('')
  const searchId = useId()
  const picked = new Set(value.map(participantKey))
  // the fixed ones (me, the creator, a rule set in Admin) first, then the picker's order
  const shown = options.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(fixed.has(participantKey(b))) - Number(fixed.has(participantKey(a))))
  const toggle = (x: ParticipantOption) =>
    onChange(picked.has(participantKey(x)) ? value.filter((y) => participantKey(y) !== participantKey(x)) : [...value, { subjectType: x.subjectType, subjectId: x.subjectId }])
  return (
    <div className="rounded-lg border border-line" data-testid={testId}>
      <label htmlFor={searchId} className="flex items-center gap-2 border-b border-line px-2.5">
        <Search size={14} className="shrink-0 text-faint" aria-hidden />
        <input id={searchId} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('projects.participantsSearch')} aria-label={t('projects.participantsSearch')} data-testid={`${testId}-search`} />
      </label>
      <ul className="max-h-48 overflow-y-auto p-1 text-sm">
        {shown.map((x) => {
          const k = participantKey(x)
          const tag = fixed.get(k)
          return (
            <li key={k}>
              <label className={`flex min-h-9 items-center gap-2 rounded-md px-2 ${tag === undefined ? 'cursor-pointer hover:bg-hover' : ''}`}>
                <input type="checkbox" checked={tag !== undefined || picked.has(k)} disabled={tag !== undefined} onChange={() => toggle(x)} data-testid={`participant-${x.subjectType}-${x.subjectId}`} />
                {x.subjectType === 'group' && <Users size={14} className="shrink-0 text-faint" aria-hidden />}
                <span className="min-w-0 truncate">{x.name}</span>
                {x.subjectType === 'group' && <span className="shrink-0 text-xs text-faint">{t('projects.groupTag')}</span>}
                {tag !== undefined && <span className="ml-auto shrink-0 text-xs text-faint">{tag}</span>}
              </label>
            </li>
          )
        })}
        {!shown.length && <li className="px-2 py-2 text-faint">{t('projects.participantsNone')}</li>}
      </ul>
    </div>
  )
}

/** "볼 수 있는 사람: 영업 부서 · 김소라 · 팀장·관리자 (9명)": the names chosen (at most 4, then "외 N"), the owner and
 * admins, and how many people that is (null while the server counts). */
export function AccessSummary({ names, count, testId = 'project-access-summary' }: { names: readonly string[]; count: number | null; testId?: string }) {
  const t = useT()
  const MAX = 4
  const parts = [...names.slice(0, MAX), ...(names.length > MAX ? [t('projects.whoMore', { n: names.length - MAX })] : []), t('projects.whoAdmins')]
  return (
    <p className="text-xs leading-5 break-keep text-muted" data-testid={testId}>
      <span className="font-medium text-ink">{t('projects.who')}</span> {count === null ? parts.join(' · ') : t('projects.whoLine', { names: parts.join(' · '), n: count })}
    </p>
  )
}

/** The names of the summary line, in the picker's order: groups as "{name} 부서", then people. */
export function summaryNames(t: ReturnType<typeof useT>, chosen: readonly ProjectParticipant[], options: readonly ParticipantOption[], first: readonly string[] = []): string[] {
  const byKey = new Map(options.map((x) => [participantKey(x), x]))
  const items = chosen.map((x) => byKey.get(participantKey(x))).filter((x): x is ParticipantOption => !!x)
  return [...first, ...items.filter((x) => x.subjectType === 'group').map((x) => t('projects.whoGroup', { name: x.name })), ...items.filter((x) => x.subjectType === 'user').map((x) => x.name)]
}

/** How many people would see the project with these participants (the server's dry run), asked again 300 ms after the
 * last change; null while asking or when it failed. */
export function useAccessCount(participants: readonly ProjectParticipant[], o: { projectId?: string; enabled: boolean }): number | null {
  const [n, setN] = useState<number | null>(null)
  const key = participants.map(participantKey).sort().join(',')
  useEffect(() => {
    if (!o.enabled) return
    let live = true
    setN(null)
    const h = setTimeout(() => {
      api.call(API.previewProjectAccess, { body: { participants: [...participants], ...(o.projectId ? { projectId: o.projectId } : {}) } }).then((r) => live && setN(r.people), () => {})
    }, 300)
    return () => { live = false; clearTimeout(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, o.projectId, o.enabled])
  return n
}

/** The widening confirm's lines: who gains it, and what they will see (only what there is). */
export function widenLines(t: ReturnType<typeof useT>, p: ProjectAccessPreview): string[] {
  return [
    ...(p.files ? [p.othersFiles ? t('projects.widenFilesOthers', { n: p.files, m: p.othersFiles }) : t('projects.widenFiles', { n: p.files })] : []),
    ...(p.sharedChats ? [t('projects.widenChats', { n: p.sharedChats })] : []),
    ...(p.skills ? [t('projects.widenSkills', { n: p.skills })] : []),
  ]
}
