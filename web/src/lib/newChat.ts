// Where "a new chat with something ready" opens (docs/DECISIONS.md "Phone tabs: 트리나 · 대화 · 파일 · 나"). Many places
// prepare the new-chat box and then open it: files attached ("트리나에게 묻기" on a file), a scheduled task's start
// sentence, a skill's or a file's question (`?prompt=`), a project's new chat (`?project=`). The box is Home (`/`), except
// on a phone with the new navigation's tabs, where `/` is 트리나's list and the box is its own page, `/new`
// (pages/Home.tsx sends a `/` that carries `?prompt=` or `?project=` there, and a computer's `/new` back to `/`).
import { phoneTabsV2 } from './tabs'

/** below 768 px now (the phone's tabs; the same query as lib/screenHistory.ts) */
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767.98px)').matches === true

/** The new-chat box's address now, with its question and project (the same query on both addresses). */
/** `folder`: one of my chat folders the new chat goes in (a folder's + in the Trina list). */
export function newChatPath(o: { project?: string | null; prompt?: string | null; folder?: string | null } = {}, phone: boolean = isPhone()): string {
  // encoded as the links always were (encodeURIComponent: a space is %20, not +)
  const parts = [o.project && `project=${encodeURIComponent(o.project)}`, o.folder && `folder=${encodeURIComponent(o.folder)}`, o.prompt && `prompt=${encodeURIComponent(o.prompt)}`].filter(Boolean)
  const query = parts.length ? `?${parts.join('&')}` : ''
  return `${phone && phoneTabsV2() ? '/new' : '/'}${query}`
}

/** The team folder's own top (its folders and the files kept loose there): `/files`, except on a phone with the new
 * tabs, where `/files` is 파일's places and the top is `/files?team=1` (components/panels/FilesPanel.tsx). For links
 * that mean "put files in the team folder". */
export const TEAM_TOP_ON_PHONE = '/files?team=1'
export function teamFolderPath(phone: boolean = isPhone()): string {
  return phone && phoneTabsV2() ? TEAM_TOP_ON_PHONE : '/files'
}

/** What Home does with its address (pages/Home.tsx): a computer's (or the old tabs') `/new` goes to `/` with the same
 * query; on a phone with the new tabs a `/` carrying a question or a project goes to `/new`; else it stays (null).
 * `list`: the address is 트리나's list (a phone with the new tabs, plain `/`). Pure: unit tested. */
export function homeRoute(pathname: string, search: string, phone: boolean, v2: boolean): { to: string } | { list: boolean } {
  const onPhoneTabs = phone && v2
  if (pathname === '/new' && !onPhoneTabs) return { to: `/${search}` }
  if (pathname === '/' && onPhoneTabs) {
    const q = new URLSearchParams(search)
    if (q.has('prompt') || q.has('project') || q.has('folder')) return { to: `/new${search}` }
    return { list: true }
  }
  return { list: false }
}
