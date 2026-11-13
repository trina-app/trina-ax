// The note on the page of a team project whose folder is in the trash (docs/DECISIONS.md "Project contents only for
// members": nobody reads it there, its members neither; "A team project in the trash: its members keep its card"):
// "This project is in the trash.", who moved it there and when (Project.trashed), and either what the person can do
// about it (`children`: Restore, Delete for good, for whoever may) or, for everyone else, who can restore it ("An admin
// or its creator, Alice, can restore it."). The same lines on a shared chat link of it (pages/Chat.tsx).
import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type { Project } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { formatShortDateTime } from '../lib/format'

type Trashed = Partial<Pick<Project, 'trashed' | 'createdBy'>>

/** "Moved to the trash by Alice on Nov 13, 3:40 PM" (null: not known, an older server) and who can restore it. */
export function useTrashLines(project: Trashed): { moved: string | null; restores: string } {
  const t = useT()
  const locale = useLocale()
  const by = project.trashed?.by?.name
  const moved = project.trashed ? (by ? t('projects.trashedBy', { who: by, date: formatShortDateTime(project.trashed.at, locale) }) : t('projects.trashedAt', { date: formatShortDateTime(project.trashed.at, locale) })) : null
  const restores = project.createdBy?.name ? t('projects.trashRestoresCreator', { name: project.createdBy.name }) : t('projects.trashRestoresAdmin')
  return { moved, restores }
}

export function ProjectTrashNote({ project, children }: { project: Pick<Project, 'inTrash'> & Trashed; children?: ReactNode }) {
  const t = useT()
  const { moved, restores } = useTrashLines(project)
  if (!project.inTrash) return null
  return (
    <div className="max-w-3xl rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="project-in-trash">
      <p role="status" className="flex items-start gap-2">
        <Trash2 size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          {t('projects.inTrash')}
          {moved && <span className="block text-xs" data-testid="project-trashed-by">{moved}</span>}
          {/* nothing to press here: who can bring it back */}
          {!children && <span className="mt-1 block break-keep" data-testid="project-trash-restores">{restores}</span>}
        </span>
      </p>
      {children && <div className="mt-2 flex flex-wrap items-center gap-2 pl-[23px]">{children}</div>}
    </div>
  )
}
