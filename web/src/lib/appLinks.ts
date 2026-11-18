// Named app links (docs/decisions/20261118-named-app-links.md): which addresses in a message are links to something in
// this app that can show its name as a chip (components/AppLinkChip.tsx), what to ask the server for
// (POST /api/link-names) and where the chip opens inside the app. Only this page's host and the team address count
// (lib/messageLinks.ts linkHosts): a look-alike address of another site stays the plain link it was. Pure:
// test/unit/app-links.test.ts.
import type { LinkNameKind } from '@mycel/shared/api'
import { fileViewTarget } from './markdown'

export interface AppLinkRef {
  kind: LinkNameKind
  /** what the server is asked about: an id, a file link's token, or a team path (folder / file) */
  id: string
  /** where it opens in the app (a path on this page's origin) */
  to: string
  /** a file in Files: opened in the preview panel by its path (lib/sidePanel.ts openTeamFile), as a team-file link */
  path?: string
}

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const CHAT = new RegExp(`^/c/(${ID})(?:/t/${ID})?/?$`)
const PROJECT = new RegExp(`^/projects/(${ID})(?:/files)?/?$`)
/** a conversation itself; a thread in it (/t/<root>) and a message (?m=) are message links with their own look */
const ROOM = new RegExp(`^/rooms/(${ID})/?$`)
/** a file link's token (files/shares.ts: 22 URL-safe characters); /f/batch/<id> is a list of files, not one */
const SHARE = /^\/f\/([A-Za-z0-9_-]{22})\/?$/

/** `href` as a link to something in this app with a name, or null (another site, an unknown page, a message link:
 * those keep their own look). A path ("/c/…": the renderer makes this page's own addresses paths) is on `origin`. */
export function appLinkRef(href: string, hosts: ReadonlySet<string>, origin: string): AppLinkRef | null {
  if (!href || href.startsWith('//')) return null
  let u: URL
  try { u = new URL(href, origin) } catch { return null }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null
  if (!hosts.has(u.host.toLowerCase())) return null
  const p = u.pathname
  // "https://<this server>//evil.example/…": the router would read it as another site (lib/markdown.ts classifyLink)
  if (p.startsWith('//')) return null
  const rest = p + u.search + u.hash
  let m = CHAT.exec(p)
  if (m) return { kind: 'chat', id: m[1]!.toLowerCase(), to: rest }
  m = PROJECT.exec(p)
  if (m) return { kind: 'project', id: m[1]!.toLowerCase(), to: rest }
  m = ROOM.exec(p)
  // a link to a message (?m=) is a message link: its own chip and card (MessageLinkChip.tsx), or the plain link
  if (m) return u.searchParams.has('m') ? null : { kind: 'room', id: m[1]!.toLowerCase(), to: rest }
  m = SHARE.exec(p)
  if (m) return { kind: 'share', id: m[1]!, to: `/f/${m[1]}` }
  if (p === '/files/view' || p === '/files') {
    const raw = u.searchParams.get('path')
    if (raw === null) return null
    const clean = raw.replace(/^\/+|\/+$/g, '')
    if (!clean) return null
    const folderOnly = p === '/files'
    const target = folderOnly ? { kind: 'folder' as const, path: clean } : fileViewTarget(clean, u.searchParams)
    if (target.kind === 'file') return { kind: 'file', id: target.path, to: `/files/view?path=${encodeURIComponent(target.path)}`, path: target.path }
    return { kind: 'folder', id: target.path, to: `/files?path=${encodeURIComponent(target.path)}` }
  }
  return null
}

/** The key a link's name is kept under (the same thing asked twice is one ask). */
export const appLinkKey = (r: Pick<AppLinkRef, 'kind' | 'id'>) => `${r.kind}:${r.id}`

/** Is this link's label its own address (a pasted address, an autolinked one), so the chip may show the name instead?
 * A `[label](url)` with any other label keeps the author's words. */
export function labelIsAddress(label: unknown, href: string): boolean {
  if (typeof label !== 'string') return false
  const a = label.trim()
  if (!a) return false
  if (a === href) return true
  // GFM writes a bare "www." or a trailing slash differently from the href; compare without the scheme and one "/"
  const bare = (s: string) => s.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return bare(a) === bare(href)
}
