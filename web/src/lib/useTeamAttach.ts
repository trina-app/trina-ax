// "Ask AI about this" and "Add to current chat" for the file screen and the file preview: which chat the files would
// go to (named, so the person knows), and a toast only once the server has taken them (or said why not).
import { useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { setPanelExpanded } from './sidePanel'
import { addToCurrentChat, askAiAbout, currentChatTarget, type AttachResult } from './teamAttach'

export function useTeamAttach() {
  const t = useT()
  const navigate = useNavigate()
  const userId = useMe()?.user.id ?? '-'
  const chats = useChats((s) => s.chats)
  const target = currentChatTarget(userId)
  // its name when the list knows it; a draft ("new", "project:<id>") or a chat the list has not loaded (a project's)
  // has none, and the menu says "Add to current chat" instead of a made-up "Untitled" (QA TC-5744)
  const title = !target || target === 'new' || target.startsWith('project:') ? null : chats.find((c) => c.id === target)?.title?.trim() || null
  const report = (r: AttachResult) => {
    if (r.added > 0 && !r.failed) toast({ level: 'success', text: t('files.addedToChat') })
    else if (r.added > 0) toast({ level: 'info', text: t('files.addedSome', { n: String(r.added), failed: String(r.failed) }) })
    else toast({ level: 'error', text: r.error ?? t('error.network') })
  }
  return {
    /** the chat "Add to current chat" goes to (null: none open in this tab), by name when it has one */
    target: target ? { id: target, title } : null,
    // the chat the files go to must show: a big side panel (lib/sidePanel.ts) goes back side by side first
    addToChat: (paths: string[]) => {
      setPanelExpanded(false)
      void addToCurrentChat(userId, paths, navigate)?.then(report)
    },
    askAi: (paths: string[]) => {
      setPanelExpanded(false)
      void askAiAbout(paths, navigate).then((r) => !r.added && report(r))
    },
  }
}
