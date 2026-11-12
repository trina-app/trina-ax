// The units of the feature map (docs/FEATURES.md): every API endpoint of the contract (shared/src/api) and every screen
// of the web app, read from the code so nobody types them. Screens come from the routes in web/src/App.tsx, with the
// routes that take a section expanded into one screen per section: Settings (/settings/:tab? → web/src/pages/
// settingsTabs.ts), Admin (/admin/:section → the menu in pages/admin/AdminLayout.tsx; /admin/:section/:sub → the groups
// of Team settings and System, an item's page of ADMIN_DETAILS, a connector's page). Redirects (<Navigate>, the old
// Connectors addresses) and the catch-all are not screens.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { API_GROUPS } from '../../shared/src/api'
import { ADMIN_DETAILS } from '../../web/src/pages/admin/adminScreens'

export const ROOT = path.resolve(import.meta.dir, '..', '..')

export interface EndpointUnit {
  name: string
  /** the group of shared/src/api/index.ts API_GROUPS (ROOMS, CHATS …) */
  group: string
  method: string
  path: string
  auth: string
  summary: string
}

export interface ScreenUnit {
  /** an address pattern: "/rooms/:roomId", "/settings/profile", "/admin/system/backups" */
  path: string
  /** where it was read from */
  source: string
}

export function readEndpoints(): EndpointUnit[] {
  const out: EndpointUnit[] = []
  for (const [group, eps] of Object.entries(API_GROUPS)) {
    for (const [name, ep] of Object.entries(eps as Record<string, { method: string; path: string; auth: string; summary: string }>)) {
      out.push({ name, group, method: ep.method, path: ep.path, auth: ep.auth, summary: ep.summary })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

/** The `{ id: '…'` entries of a source file, optionally only inside the text after `start` up to `end`. */
export function idsIn(text: string, start?: string, end?: string): string[] {
  let body = text
  if (start) {
    const at = body.indexOf(start)
    if (at < 0) throw new Error(`features: "${start}" not found`)
    body = body.slice(at)
    if (end) {
      const stop = body.indexOf(end, start.length)
      if (stop >= 0) body = body.slice(0, stop)
    }
  }
  return [...body.matchAll(/\{\s*id:\s*'([^']*)'/g)].map((m) => m[1]!)
}

/** `<Route path="…" element={…}>` of App.tsx: the path and the start of its element. */
export function routesIn(appTsx: string): { path: string; element: string }[] {
  return [...appTsx.matchAll(/<Route\s+(?:index\s+)?(?:path="([^"]*)"\s+)?element=\{\s*<(\w+)/g)].map((m) => ({ path: m[1] ?? '', element: m[2]! }))
}

/** Elements that only send the address elsewhere, and the layout wrapper (no path of its own). */
const NOT_SCREENS = new Set(['Navigate', 'OldConnectors', 'NotFound', 'Layout'])

export function readScreens(): ScreenUnit[] {
  const app = read('web/src/App.tsx')
  const settingsTabs = idsIn(read('web/src/pages/settingsTabs.ts'), 'const TABS', ']\n')
  const adminMenu = idsIn(read('web/src/pages/admin/AdminLayout.tsx'), 'const MENU', ']\n\n')
  const teamSettings = idsIn(read('web/src/pages/admin/teamSettingsGroups.ts'))
  const systemGroups = idsIn(read('web/src/pages/admin/systemGroups.ts'))
  // a change of how these files are written must not drop screens without a word
  for (const [name, ids] of Object.entries({ settingsTabs, adminMenu, teamSettings, systemGroups })) if (!ids.length) throw new Error(`features: no ids read for ${name}: update scripts/features/units.ts`)
  const routes = routesIn(app)
  const tags = app.match(/<Route\b/g)?.length ?? 0
  if (routes.length !== tags) throw new Error(`features: ${tags} <Route> tags in App.tsx but ${routes.length} read (write path= before element=, or update scripts/features/units.ts)`)
  const out = new Map<string, string>()
  const add = (p: string, source: string) => { if (!out.has(p)) out.set(p, source) }
  for (const r of routes) {
    if (NOT_SCREENS.has(r.element) || r.path === '*' || r.path.endsWith('/*')) continue
    const p = r.path === '' ? '/' : r.path.startsWith('/') ? r.path : `/${r.path}`
    if (p === '/settings/:tab?') {
      add('/settings', 'App.tsx')
      for (const id of settingsTabs) add(`/settings/${id}`, 'settingsTabs.ts')
    } else if (p === '/admin/:section') {
      for (const id of adminMenu) if (id) add(`/admin/${id}`, 'AdminLayout.tsx MENU')
    } else if (p === '/admin/:section/:sub') {
      for (const id of teamSettings) add(`/admin/settings/${id}`, 'teamSettingsGroups.ts')
      for (const id of systemGroups) add(`/admin/system/${id}`, 'systemGroups.ts')
      for (const section of Object.keys(ADMIN_DETAILS)) add(`/admin/${section}/:id`, 'adminScreens.ts ADMIN_DETAILS')
    } else if (p === '/admin/:section/:sub/:item') {
      add('/admin/connectors/mcp/:id', 'App.tsx')
    } else add(p, 'App.tsx')
  }
  return [...out].map(([p, source]) => ({ path: p, source })).sort((a, b) => a.path.localeCompare(b.path))
}

/** A pattern of docs/features.ts: an exact name, or `*` for any run of characters. */
export function globRe(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
}
