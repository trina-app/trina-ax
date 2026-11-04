// The one line an admin sees on the page of a project whose folder is in the trash (only admins and the owner see such
// a project; its chats get nothing of it): restore the folder, or point the project at another folder.
import { Trash2 } from 'lucide-react'
import type { Project } from '@mycel/shared/api'
import { useT } from '../i18n'

export function ProjectTrashNote({ project }: { project: Pick<Project, 'inTrash'> }) {
  const t = useT()
  if (!project.inTrash) return null
  return (
    <p role="status" className="flex max-w-3xl items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="project-in-trash">
      <Trash2 size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span>{t('projects.inTrash')}</span>
    </p>
  )
}
