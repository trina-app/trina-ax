// Where "a new chat with something ready" opens (docs/DECISIONS.md "Phones: Home like the AI apps, the list behind ☰").
// Many places prepare the new-chat box and then open it: files attached ("트리나에게 묻기" on a file), a scheduled task's
// start sentence, a skill's or a file's question (`?prompt=`), a project's new chat (`?project=`). The box is Home (`/`)
// on every screen: a phone's 트리나 tab opens on it too (the Trina list is behind its ☰), so `/new`, the phone's box of
// 11-13 morning, comes back to `/` with its question (old links, a page open across the update).
/** below 768 px now (the phone's tabs; the same query as lib/screenHistory.ts) */
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767.98px)').matches === true

/** The new-chat box's address now, with its question and project (the same query on both addresses). */
/** `folder`: one of my chat folders the new chat goes in (a folder's + in the Trina list). */
export function newChatPath(o: { project?: string | null; prompt?: string | null; folder?: string | null } = {}, phone: boolean = isPhone()): string {
  // encoded as the links always were (encodeURIComponent: a space is %20, not +)
  const parts = [o.project && `project=${encodeURIComponent(o.project)}`, o.folder && `folder=${encodeURIComponent(o.folder)}`, o.prompt && `prompt=${encodeURIComponent(o.prompt)}`].filter(Boolean)
  const query = parts.length ? `?${parts.join('&')}` : ''
  void phone
  return `/${query}`
}

/** The team folder's own top (its folders and the files kept loose there): `/files`, except on a phone, where `/files` is 파일's places and the top is `/files?team=1` (components/panels/FilesPanel.tsx). For links
 * that mean "put files in the team folder". */
export const TEAM_TOP_ON_PHONE = '/files?team=1'
export function teamFolderPath(phone: boolean = isPhone()): string {
  return phone ? TEAM_TOP_ON_PHONE : '/files'
}

/** What Home does with its address (pages/Home.tsx): `/new` goes to `/` with the same query; else it stays. Pure: unit
 * tested. (`phone` is kept for the callers; both screens do the same now.) */
export function homeRoute(pathname: string, search: string, phone: boolean): { to: string } | { list: boolean } {
  void phone
  if (pathname === '/new') return { to: `/${search}` }
  return { list: false }
}
