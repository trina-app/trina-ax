// Where each Admin address sits (docs/DECISIONS.md "Admin and Settings on phones: a list you tap into"): the Admin list
// (/admin) under the 나 list (/settings); a page under the Admin list; a group of Team settings under Team settings; an
// item's own page under its page (a connector, a plugin, an engine, a person, a group, an Activity log record); in
// Folder permissions a folder under the tree, its rule editor under the folder, and a person under By person.
//
// One table for ‹ (AdminLayout.tsx: where it goes and its name), the lists put under a page opened from outside
// (lib/backStack.ts useListUnderPage) and, later, the app's route table (lib/screens.ts calls adminParent for its
// /admin addresses). Pure: no React, so the route table and the unit tests can use it.

/** Admin pages whose items have a page of their own at /admin/<section>/<id>. `phoneOnly`: computers keep the item in
 * the page (a row that opens in place, a dialog, a highlighted row), and the address leads there (adminDesktopOf). */
export const ADMIN_DETAILS: Readonly<Record<string, { phoneOnly: boolean }>> = {
  connectors: { phoneOnly: false },
  plugins: { phoneOnly: false },
  providers: { phoneOnly: true },
  members: { phoneOnly: true },
  groups: { phoneOnly: true },
  audit: { phoneOnly: true },
}

/** Folder permissions' query: the folder chosen in the tree, its rule editor (a phone's own entry), By person and the
 * person chosen there. */
export const FOLDER_Q = { folder: 'folder', rules: 'rules', view: 'view', person: 'person', isNew: 'new' } as const

function split(to: string): { pathname: string; q: URLSearchParams } {
  const at = to.search(/[?#]/)
  const pathname = at < 0 ? to : to.slice(0, at)
  const search = at < 0 ? '' : to.slice(at).split('#')[0]!
  return { pathname: pathname.replace(/\/+$/, '') || '/', q: new URLSearchParams(search) }
}

/** The address one level up from an Admin address (see the top of this file); null outside Admin. */
export function adminParent(to: string): string | null {
  const { pathname, q } = split(to)
  if (pathname === '/admin') return '/settings'
  if (!pathname.startsWith('/admin/')) return null
  const [section, sub] = pathname.slice('/admin/'.length).split('/')
  if (sub) return `/admin/${section}`
  if (section === 'folders') {
    const folder = q.get(FOLDER_Q.folder)
    if (folder !== null && q.get(FOLDER_Q.rules) === '1') return `/admin/folders?${new URLSearchParams({ folder })}`
    if (folder !== null) return '/admin/folders'
    if (q.get(FOLDER_Q.view) === 'people' && (q.has(FOLDER_Q.person) || q.get(FOLDER_Q.isNew) === '1')) return '/admin/folders?view=people'
  }
  return '/admin'
}

/** The Admin addresses under `to`, the outermost first, `to` not included: what goes under a page opened from outside
 * Admin (Back walks them in turn). /admin itself has none here (the 나 list under it is Settings'). */
export function adminChain(to: string): string[] {
  const out: string[] = []
  for (let p = adminParent(to); p && p.startsWith('/admin') && out.length < 6; p = adminParent(p)) out.unshift(p)
  return out
}

/** Is this a page under another page of the same section (an item's own page, a folder, the rule editor, a person)? */
export const isAdminDetail = (to: string) => {
  const p = adminParent(to)
  return !!p && p !== '/admin' && p !== '/settings'
}

/** An item's page on a computer, for the phone-only ones: where the same thing is there (null: the address stays). */
export function adminDesktopOf(section: string, sub: string): string | null {
  if (!ADMIN_DETAILS[section]?.phoneOnly) return null
  if (section === 'providers') return `/admin/providers?${new URLSearchParams({ engine: sub })}`
  if (section === 'members') return `/admin/members?${new URLSearchParams({ member: sub })}`
  return `/admin/${section}`
}
