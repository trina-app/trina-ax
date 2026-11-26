// "Leave project" (docs/DECISIONS.md "Leaving a project"; QA TC-1020): in a team project's name menu and its card's "…",
// for its members (Project.leave). One confirm in plain words, then POST …/leave: the project goes from my lists, my
// private chats in it stay as my own chats. The last person in it sees the item off, with what to do instead.
import type { Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useProjects } from '../store/projects'
import { toast } from '../store/ui'
import { destructive } from '../lib/destructive'
import { menuItem, type EntityItem } from './menus/entityMenu'

/** The menu item (none when the project is not one I may leave); off for the last person, the reason beside it. */
export function leaveItems(t: ReturnType<typeof useT>, p: Project, onSelect: () => void, testId: string): EntityItem[] {
  if (!p.leave) return []
  const last = p.leave === 'last'
  // the one list's leave item (components/menus/entityMenu.tsx): the danger style, as in a project room's "···"
  return [menuItem(t, 'leave', { label: t('projects.leave'), onSelect, testId, ...(last ? { disabled: true, hint: t('projects.leaveLast') } : {}) })]
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
    // lib/destructive.ts: its confirm, then "You left …" (no undo: only whoever manages it adds me again)
    let missing = false
    const r = await destructive({
      confirm: { title: t('projects.leaveTitle', { name: p.name }), body: t('projects.leaveBody'), confirm: t('projects.leaveConfirm') },
      run: async () => {
        try {
          await api.call(API.leaveProject, { params: { id: p.id } })
        } catch (e) {
          if (isApiError(e, 'not_found')) {
            missing = true
            out(p.id)
            return true
          }
          toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
          return false
        }
        out(p.id)
        return true
      },
      done: () => (missing ? { text: t('projects.missing') } : { text: t('projects.left', { name: p.name }), level: 'success' }),
    })
    return r !== false
  }
}
