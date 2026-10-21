// "Ask AI about this" and "Add to current chat" for the file screen and the file preview: which chat the files would
// go to (named, so the person knows), and a toast only once the server has taken them (or said why not).
import { useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { addToCurrentChat, askAiAbout, currentChatTarget, type AttachResult } from './teamAttach'

export function useTeamAttach() {
  const t = useT()
  const navigate = useNavigate()
  const userId = useMe()?.user.id ?? '-'
  const chats = useChats((s) => s.chats)
  const target = currentChatTarget(userId)
  // a draft id ("new", "project:<id>") is a chat that is not created yet
  const title = !target ? null : target === 'new' || target.startsWith('project:') ? t('chat.untitled') : chats.find((c) => c.id === target)?.title || t('chat.untitled')
  const report = (r: AttachResult) => {
    if (r.added > 0 && !r.failed) toast({ level: 'success', text: t('files.addedToChat') })
    else if (r.added > 0) toast({ level: 'info', text: t('files.addedSome', { n: String(r.added), failed: String(r.failed) }) })
    else toast({ level: 'error', text: r.error ?? t('error.network') })
  }
  return {
    /** the chat "Add to current chat" goes to, by name (null: none open in this tab) */
    target: target ? { id: target, title: title! } : null,
    addToChat: (paths: string[]) => void addToCurrentChat(userId, paths, navigate)?.then(report),
    askAi: (paths: string[]) => void askAiAbout(paths, navigate).then((r) => !r.added && report(r)),
  }
}
