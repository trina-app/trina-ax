// "Leave project" (docs/DECISIONS.md "Leaving a project"; QA TC-1020): in a team project's name menu and its card's "…",
// for its members (Project.leave). One confirm in plain words, then POST …/leave: the project goes from my lists, my
// private chats in it stay as my own chats. The last person in it sees the item off, with what to do instead.
import { LogOut } from 'lucide-react'
import type { Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useProjects } from '../store/projects'
import { toast } from '../store/ui'
import { confirmDialog } from './ui'
import type { MenuItem } from './rooms/MenuButton'

/** The menu item (none when the project is not one I may leave); off for the last person, the reason beside it. */
export function leaveItems(t: ReturnType<typeof useT>, p: Project, onSelect: () => void, testId: string): (MenuItem & { testId: string })[] {
  if (!p.leave) return []
  const last = p.leave === 'last'
  return [{ label: t('projects.leave'), icon: <LogOut size={14} aria-hidden />, onSelect, testId, ...(last ? { disabled: true, hint: t('projects.leaveLast') } : {}) }]
}

/** Ask, then leave. True when I am out of it (or it was gone already). */
export function useLeaveProject() {
  const t = useT()
  const locale = useLocale()
  const out = (id: string) => {
    useProjects.getState().drop(id, true)
    // my private chats there are my own chats now (the server moved them); its shared chats leave my lists by their events
    useChats.setState((s) => ({ chats: s.chats.map((c) => (c.projectId === id && !c.shared ? { ...c, projectId: null } : c)) }))
  }
  return async (p: Project): Promise<boolean> => {
    if (!(await confirmDialog({ title: t('projects.leaveTitle', { name: p.name }), body: t('projects.leaveBody'), confirm: t('projects.leaveConfirm'), danger: true }))) return false
    try {
      await api.call(API.leaveProject, { params: { id: p.id } })
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        out(p.id)
        toast({ level: 'info', text: t('projects.missing') })
        return true
      }
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return false
    }
    out(p.id)
    toast({ level: 'success', text: t('projects.left', { name: p.name }) })
    return true
  }
}
