// The way back to a sharing dialog on a phone (store/wideningDraft.ts): an answer of the widening list opened on the
// same screen, so the dialog that listed it is gone. When the screen that opened it is back (the chat page's "‹ Back to
// sharing", or the system Back), the dialog opens again here on the list with the picks it had. A draft older than 30
// minutes is dropped. One host for every place that opens the Members dialog (the project page, a list card's ⋯, the
// line under a shared chat's box) and for a chat's Share dialog (components/chat/ChatShareDialog.tsx).
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useChats } from '../store/chats'
import { ChatShareDialog } from './chat/ChatShareDialog'
import { useProjects } from '../store/projects'
import { freshDraft, useWideningDraft, type WideningDraft } from '../store/wideningDraft'
import { ProjectMembersDialog, projectNow } from './ProjectMembersDialog'

export function WideningDraftHost() {
  const location = useLocation()
  const draft = useWideningDraft((s) => s.draft)
  const [open, setOpen] = useState<{ draft: WideningDraft; project: Project } | { draft: WideningDraft; chat: Chat } | null>(null)
  const here = location.pathname + location.search
  // only on coming back to that screen (not while it is still the one the answer is opened from)
  const was = useRef<string | null>(null)
  useEffect(() => {
    const before = was.current
    was.current = here
    // the dialog opened here, and a page opened from inside it (another answer of its list): it goes with that screen
    if (before !== null && before !== here) setOpen(null)
    if (!draft?.left || here !== draft.from || before === here) return
    if (!freshDraft(draft)) { useWideningDraft.getState().drop(); return }
    useWideningDraft.getState().reopened()
    // a chat's Share dialog (components/chat/ChatShareDialog.tsx): the chat as this window has it
    if (draft.chatId) {
      const s = useChats.getState()
      const chat = s.chats.find((c) => c.id === draft.chatId) ?? s.others[draft.chatId]
      if (chat) setOpen({ draft, chat })
      else api.call(API.getChat, { params: { id: draft.chatId } }).then((c) => setOpen({ draft, chat: c }), () => useWideningDraft.getState().drop())
      return
    }
    const kept = useProjects.getState().byId[draft.projectId]
    // (not cancelled when the draft changes: reopened() itself changes it)
    const show = (project: Project) => setOpen({ draft, project })
    if (kept) show(kept)
    else projectNow(draft.projectId).then(show, () => useWideningDraft.getState().drop())
  }, [draft, here])
  if (!open) return null
  if ('chat' in open) return <ChatShareDialog chat={open.chat} initial={open.draft} onClose={() => setOpen(null)} />
  return (
    <ProjectMembersDialog
      project={open.project}
      initial={open.draft}
      onClose={() => setOpen(null)}
      onSaved={(p) => useProjects.getState().put(p)}
    />
  )
}
