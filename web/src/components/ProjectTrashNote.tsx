// The note on the page of a team project whose folder is in the trash (docs/DECISIONS.md "Project contents only for
// members": nobody reads it there, its members neither; the owner and admins see that it is there, and its chats get
// nothing of it): "이 프로젝트는 휴지통에 있어요.", with what the owner and admins can do about it (`children`: 되돌리기,
// 완전히 삭제) under the words.
import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type { Project } from '@mycel/shared/api'
import { useT } from '../i18n'

export function ProjectTrashNote({ project, children }: { project: Pick<Project, 'inTrash'>; children?: ReactNode }) {
  const t = useT()
  if (!project.inTrash) return null
  return (
    <div className="max-w-3xl rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="project-in-trash">
      <p role="status" className="flex items-start gap-2">
        <Trash2 size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span>{t('projects.inTrash')}</span>
      </p>
      {children && <div className="mt-2 flex flex-wrap items-center gap-2 pl-[23px]">{children}</div>}
    </div>
  )
}
