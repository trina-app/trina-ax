// The way back to a sharing dialog on a phone (store/wideningDraft.ts): an answer of the widening list opened on the
// same screen, so the dialog that listed it is gone. When the screen that opened it is back (the chat page's "‹ Back to
// sharing", or the system Back), the dialog opens again here on the list with the picks it had. A draft older than 30
// minutes is dropped. One host for every place that opens the Members dialog (the project page, a list card's ⋯, the
// line under a shared chat's box).
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Project } from '@mycel/shared/api'
import { useProjects } from '../store/projects'
import { freshDraft, useWideningDraft, type WideningDraft } from '../store/wideningDraft'
import { ProjectMembersDialog, projectNow } from './ProjectMembersDialog'

export function WideningDraftHost() {
  const location = useLocation()
  const draft = useWideningDraft((s) => s.draft)
  const [open, setOpen] = useState<{ draft: WideningDraft; project: Project } | null>(null)
  const here = location.pathname + location.search
  useEffect(() => {
    if (!draft?.left || here !== draft.from) return
    if (!freshDraft(draft)) { useWideningDraft.getState().drop(); return }
    useWideningDraft.getState().reopened()
    const kept = useProjects.getState().byId[draft.projectId]
    // (not cancelled when the draft changes: reopened() itself changes it)
    const show = (project: Project) => setOpen({ draft, project })
    if (kept) show(kept)
    else projectNow(draft.projectId).then(show, () => useWideningDraft.getState().drop())
  }, [draft, here])
  if (!open) return null
  return (
    <ProjectMembersDialog
      project={open.project}
      initial={open.draft}
      onClose={() => setOpen(null)}
      onSaved={(p) => useProjects.getState().put(p)}
    />
  )
}
