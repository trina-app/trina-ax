// The runs of one scheduled task folded into one row (docs/DECISIONS.md "Scheduled runs fold in Recent"): every run
// makes its own chat ("<task> · <date>"), and a daily task filled 트리나's 최근 기록 with them. In 최근 기록, the phone
// drawer's history and a project's chat list, the run chats of one task (Chat.schedule) are one row instead: the task's
// name with a clock, the newest run's time and its mark (a red dot for a failed run, amber for problems, the spinner
// while one runs), semibold while any run has an answer I have not seen. It opens the task's page, whose "Runs" list
// opens each run's chat. The run chats stay in Search, the task page and, pinned, in 고정.
import clsx from 'clsx'
import { CalendarClock } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { listTime } from '../../lib/format'
import { markerOf, needsMe } from '../../lib/sessionMarkers'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useProjects } from '../../store/projects'
import { useSessionMarkers } from '../../store/sessionMarkers'
import { ListRow } from '../list/List'
import { SessionMarker } from '../chat/ChatState'

type Run = Chat & { schedule: NonNullable<Chat['schedule']> }
const isRun = (c: Chat): c is Run => !!c.schedule && !c.pinnedAt

/** A list's rows with the runs of each task folded into one row where its newest run is (`chats` in the list's order,
 * newest first). `row`: the list's own row for every other chat. `pool`: the whole list when `chats` is one of its
 * groups (a date, a project): the task's row is in the group of its newest run only, and counts all of its runs. */
export function foldRuns(chats: readonly Chat[], row: (c: Chat) => ReactNode, o: { projectTag?: boolean; pool?: readonly Chat[] } = {}): ReactNode[] {
  const byTask = new Map<string, Run[]>()
  for (const c of o.pool ?? chats) if (isRun(c)) byTask.set(c.schedule.id, [...(byTask.get(c.schedule.id) ?? []), c])
  // newest first whatever the list's sort (by title, by creation)
  for (const runs of byTask.values()) runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return chats.flatMap((c) => {
    if (!isRun(c)) return [<Fragment key={c.id}>{row(c)}</Fragment>]
    const runs = byTask.get(c.schedule.id)
    if (!runs || runs[0]!.id !== c.id) return []
    return [<TaskRunsRow key={`task:${c.schedule.id}`} runs={runs} projectTag={o.projectTag} />]
  })
}

/** One task's runs as one row (`runs`: newest first, at least one). */
export function TaskRunsRow({ runs, projectTag = false }: { runs: Run[]; projectTag?: boolean }) {
  const t = useT(), locale = useLocale()
  const newest = runs[0]!
  const task = newest.schedule
  const name = task.templateId === 'daily-file-index' || task.templateId === 'weekly-summary' ? t(`scheduleTemplates.${task.templateId}` as MessageKey) : task.title
  // the chat on screen in a visible window has no marker (the person is reading it)
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const unread = runs.some((c) => needsMe(markerOf(c, { here: c.id === here })))
  const running = runs.find((c) => c.runState === 'running' || c.runState === 'queued')
  const tone = running ? null : task.outcome === 'failed' ? 'danger' : task.outcome === 'problems' ? 'warn' : null
  const project = useProjects((s) => (projectTag && newest.projectId && (!s.listed || s.listed.has(newest.projectId)) ? s.byId[newest.projectId] ?? null : null))
  const selected = useLocation().pathname === `/scheduled/${task.id}`
  return (
    <ListRow
      to={`/scheduled/${encodeURIComponent(task.id)}`}
      selected={selected}
      unread={unread}
      testId="task-runs-row"
      link={{ 'data-schedule-id': task.id, 'data-unread': unread ? '' : undefined, 'data-outcome': running ? 'running' : task.outcome ?? undefined }}
      name={
        <span className="flex min-w-0 items-center gap-1.5">
          <CalendarClock size={13} className="shrink-0 text-faint" role="img" aria-label={t('scheduled.runsRowIcon')} />
          <span className="truncate">{name}</span>
        </span>
      }
      end={
        <span className="flex shrink-0 items-center gap-2 self-center">
          {project && <span className="max-w-24 truncate text-meta text-faint" title={project.name} data-testid="task-runs-project">{project.name}</span>}
          {running ? (
            <SessionMarker marker={{ kind: 'running', reason: running.runState === 'queued' ? 'queued' : 'running' }} label={t('scheduled.run.running')} />
          ) : tone ? (
            <span role="img" aria-label={t(tone === 'danger' ? 'scheduled.run.error' : 'scheduled.run.problems')} className={clsx('size-2 rounded-full', tone === 'danger' ? 'bg-danger' : 'bg-warn')} data-testid="task-runs-mark" />
          ) : null}
          <time dateTime={newest.updatedAt} className="text-meta font-normal text-faint tabular-nums">{listTime(newest.updatedAt, locale, t('sidebar.yesterday'))}</time>
        </span>
      }
    />
  )
}
