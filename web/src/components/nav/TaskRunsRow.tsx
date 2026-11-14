// The runs of one scheduled task folded into one row (docs/DECISIONS.md "Scheduled runs fold in Recent"): every run
// makes its own chat ("<task> · <date>"), and a daily task filled 트리나's 최근 기록 with them. In 최근 기록, the phone
// drawer's history and a project's chat list, the run chats of one task (Chat.schedule) are one row instead: the task's
// name with a clock, the newest run's time and its mark (a red dot for a failed run, amber for problems, the spinner
// while one runs), semibold while any run has an answer I have not seen. It opens the task's page, whose "Runs" list
// opens each run's chat. The run chats stay in Search, the task page and, pinned, in 고정. Its clock comes after the
// name, so the name starts where every other chat's starts (QA TC-990). A list with rows of its own (a project's page)
// draws the task's row with its own row (`task` of foldRuns) from the same pieces here: TaskRunsIcon, TaskRunsMark.
import clsx from 'clsx'
import { CalendarClock } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { listTime } from '../../lib/format'
import { markerOf, needsMe } from '../../lib/sessionMarkers'
import { useLocale, useT } from '../../i18n'
import { scheduleName } from '../../lib/scheduleText'
import { useProjects } from '../../store/projects'
import { useSessionMarkers } from '../../store/sessionMarkers'
import { ListRow } from '../list/List'
import { SessionMarker } from '../chat/ChatState'

export type Run = Chat & { schedule: NonNullable<Chat['schedule']> }
const isRun = (c: Chat): c is Run => !!c.schedule && !c.pinnedAt

/** The list without the older runs of each task (its newest run stands for the task's one row): what a capped list
 * counts, so "N more" never holds back only runs that fold into a row already in sight (panels/TrinaList.tsx) */
export const newestRunsOnly = (chats: readonly Chat[]): Chat[] => {
  const newest = new Map<string, Chat>()
  for (const c of chats) if (isRun(c) && !(c.updatedAt <= (newest.get(c.schedule.id)?.updatedAt ?? ''))) newest.set(c.schedule.id, c)
  return chats.filter((c) => !isRun(c) || newest.get(c.schedule.id) === c)
}

/** A list's rows with the runs of each task folded into one row where its newest run is (`chats` in the list's order,
 * newest first). `row`: the list's own row for every other chat. `pool`: the whole list when `chats` is one of its
 * groups (a date, a project): the task's row is in the group of its newest run only, and counts all of its runs. `task`:
 * the list's own row for a task (newest run first), where the list's rows are not ListRows. */
export function foldRuns(chats: readonly Chat[], row: (c: Chat) => ReactNode, o: { projectTag?: boolean; menuSpace?: boolean; pool?: readonly Chat[]; task?: (runs: Run[]) => ReactNode } = {}): ReactNode[] {
  const byTask = new Map<string, Run[]>()
  for (const c of o.pool ?? chats) if (isRun(c)) byTask.set(c.schedule.id, [...(byTask.get(c.schedule.id) ?? []), c])
  // newest first whatever the list's sort (by title, by creation)
  for (const runs of byTask.values()) runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return chats.flatMap((c) => {
    if (!isRun(c)) return [<Fragment key={c.id}>{row(c)}</Fragment>]
    const runs = byTask.get(c.schedule.id)
    if (!runs || runs[0]!.id !== c.id) return []
    return [o.task ? <Fragment key={`task:${c.schedule.id}`}>{o.task(runs)}</Fragment> : <TaskRunsRow key={`task:${c.schedule.id}`} runs={runs} projectTag={o.projectTag} menuSpace={o.menuSpace} />]
  })
}

/** Any run with an answer I have not seen (its "?" or dot): the folded row reads semibold. `here`: the chat on screen
 * in a visible window, which has no marker (the person is reading it; its seen goes to the server). */
export const runsUnread = (runs: readonly Chat[], here: string | null) => runs.some((c) => needsMe(markerOf(c, { here: c.id === here })))

/** The task's page (its "Runs" list opens each run's chat) */
export const taskRunsPath = (runs: readonly Run[]) => `/scheduled/${encodeURIComponent(runs[0]!.schedule.id)}`

/** The clock after a task row's name: it says the row is a scheduled task */
export function TaskRunsIcon() {
  const t = useT()
  return <CalendarClock size={13} className="shrink-0 text-faint" role="img" aria-label={t('scheduled.runsRowIcon')} data-testid="task-runs-icon" />
}

/** How the task's runs went, before its time: the spinner while one runs, a red dot for a failed newest run, amber for
 * problems, nothing for a good one */
export function TaskRunsMark({ runs }: { runs: readonly Run[] }) {
  const t = useT()
  const running = runs.find((c) => c.runState === 'running' || c.runState === 'queued')
  const outcome = runs[0]!.schedule.outcome
  const tone = running ? null : outcome === 'failed' ? 'danger' : outcome === 'problems' ? 'warn' : null
  if (running) return <SessionMarker marker={{ kind: 'running', reason: running.runState === 'queued' ? 'queued' : 'running' }} label={t('scheduled.run.running')} />
  if (!tone) return null
  return <span role="img" aria-label={t(tone === 'danger' ? 'scheduled.run.error' : 'scheduled.run.problems')} className={clsx('size-2 shrink-0 rounded-full', tone === 'danger' ? 'bg-danger' : 'bg-warn')} data-testid="task-runs-mark" />
}

/** The row's data-* (tests and styles): the task, unread, how its newest run went */
export const taskRunsAttrs = (runs: readonly Run[], unread: boolean) => {
  const running = runs.some((c) => c.runState === 'running' || c.runState === 'queued')
  return { 'data-schedule-id': runs[0]!.schedule.id, 'data-unread': unread ? '' : undefined, 'data-outcome': running ? 'running' : runs[0]!.schedule.outcome ?? undefined }
}

/** One task's runs as one row (`runs`: newest first, at least one). Its project and time are the row's trailing tag
 * (ListRow `tag`), at the same edge as a chat row's project. `menuSpace`: among chat rows with a "···" (the Trina list,
 * the filtered history): the same room for it, and its mark in their marker's spot. */
export function TaskRunsRow({ runs, projectTag = false, menuSpace = false }: { runs: Run[]; projectTag?: boolean; menuSpace?: boolean }) {
  const t = useT(), locale = useLocale()
  const newest = runs[0]!
  const task = newest.schedule
  const name = scheduleName(task, t)
  // the chat on screen in a visible window has no marker (the person is reading it)
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const unread = runsUnread(runs, here)
  const project = useProjects((s) => (projectTag && newest.projectId && (!s.listed || s.listed.has(newest.projectId)) ? s.byId[newest.projectId] ?? null : null))
  const selected = useLocation().pathname === `/scheduled/${task.id}`
  return (
    <ListRow
      to={taskRunsPath(runs)}
      selected={selected}
      unread={unread}
      testId="task-runs-row"
      link={taskRunsAttrs(runs, unread)}
      name={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{name}</span>
          <TaskRunsIcon />
        </span>
      }
      tag={
        // the project is cut first; the time always shows
        <span className="flex min-w-0 justify-end">
          {project && <span className="min-w-0 truncate" title={project.name} data-testid="task-runs-project">{project.name}</span>}
          <time dateTime={newest.updatedAt} className="shrink-0 whitespace-pre">{project ? ' · ' : ''}{listTime(newest.updatedAt, locale, t('sidebar.yesterday'))}</time>
        </span>
      }
      menuSpace={menuSpace}
      end={
        // in the "···" spot of the chat rows around it (ChatItem's marker), else after the tag
        <span className={clsx('flex shrink-0 items-center self-center empty:hidden', menuSpace && 'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 max-md:right-4')}>
          <TaskRunsMark runs={runs} />
        </span>
      }
    />
  )
}
