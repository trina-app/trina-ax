// 프로젝트's mark on the rail (Rail.tsx) and the phone's 프로젝트 tab (BottomTabs.tsx): one hook, so the computer and the
// phone never show two numbers (railBadges.ts projectsMark). It keeps my unread thread mentions read while mounted
// (store/chatMentions.ts: read again whenever the Inbox changes, here or on another device), so opening the chat or
// its thread clears the project's row and this mark at once.
import { useMemo } from 'react'
import { useMentions } from '../../store/chatMentions'
import { useChats } from '../../store/chats'
import { projectsMark, type RailMark } from './railBadges'

export function useProjectsMark(): RailMark {
  const { byProject } = useMentions()
  const chats = useChats((s) => s.chats)
  const others = useChats((s) => s.others)
  return useMemo(() => projectsMark(byProject.keys(), [...chats, ...Object.values(others)]), [byProject, chats, others])
}
