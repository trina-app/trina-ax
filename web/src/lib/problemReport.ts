// What a problem report says about where it came from (components/ProblemReportSheet.tsx): the kind of screen, a fixed
// word from the route, never an id, a path or a file name; and the app, its version and the OS family, never the user
// agent. The server takes the client kind from the session and checks the rest against the contract.
import type { ProblemReportOs, ProblemReportScreen } from '@mycel/shared/cloud-protocol/problem-report'
import { clientKind, desktop } from './desktop'
import { mobileApp } from './mobile'
import { platform } from './pwa'

const FIRST: Record<string, ProblemReportScreen> = {
  c: 'chat', new: 'chat', projects: 'chat', rooms: 'room', files: 'files', f: 'files', 'sent-files': 'files', trash: 'files',
  settings: 'settings', admin: 'admin', connectors: 'connectors', skills: 'skills', activity: 'inbox', scheduled: 'chat', welcome: 'home',
}

/** The kind of screen of a route path ("/c/0190…" → "chat"); the home page is "home", anything else "other". */
export function screenKindOf(pathname: string): ProblemReportScreen {
  const first = pathname.split('/').filter(Boolean)[0]
  if (!first) return 'home'
  return FIRST[first] ?? 'other'
}

export function problemReportClient(): { kind: 'web' | 'desktop' | 'phone'; version: string | null; os: ProblemReportOs } {
  const kind = clientKind()
  const phone = mobileApp()
  const d = desktop()
  const p = phone?.platform ?? (d ? (d.platform === 'darwin' ? 'mac' : d.platform === 'win32' ? 'windows' : 'linux') : platform())
  const os: ProblemReportOs = p === 'mac' ? 'macos' : p === 'windows' ? 'windows' : p === 'linux' ? 'linux' : p === 'ios' ? 'ios' : p === 'android' ? 'android' : 'other'
  const version = kind === 'mobile' ? phone?.appVersion ?? null : kind === 'desktop' ? d?.appVersion ?? null : null
  return { kind: kind === 'mobile' ? 'phone' : kind, version: version && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(version) ? version : null, os }
}

/** The file a team-file address names ("/files/view?path=users%2Fa%2F보고서.md&page=2" → "보고서.md"), or null. */
function fileNameOf(address: string): string | null {
  const q = address.indexOf('?')
  if (q < 0) return null
  let p: string | null = null
  try { p = new URLSearchParams(address.slice(q + 1).replace(/&amp;/g, '&')).get('path') } catch { /* not a query */ }
  const clean = p?.replace(/^\/+|\/+$/g, '')
  return clean ? clean.slice(clean.lastIndexOf('/') + 1) : null
}

const TEAM_FILE = String.raw`(?:https?:\/\/[^\s/()<>\]]+)?\/(?:files\/view|api\/files\/download)\?[^\s()<>\]]+`
const MD_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\((${TEAM_FILE})\)`, 'g')
const BARE = new RegExp(TEAM_FILE, 'g')

/** The problem report preview's words for an answer (components/ProblemReportSheet.tsx): a file link reads as the file
 * name, never its "/files/view?path=users%2F…" address. A Markdown link keeps its own words (or the file's name when it
 * has none); a bare address becomes the name. Display only: what is sent is the text as the server cuts it. */
export function reportPreviewText(text: string): string {
  return text
    .replace(MD_LINK, (all, label: string, href: string) => label.trim() || fileNameOf(href) || all)
    // (a sentence's full stop or comma after a bare address stays the sentence's)
    .replace(BARE, (all) => { const tail = /[.,;:!?]+$/.exec(all)?.[0] ?? ''; const href = all.slice(0, all.length - tail.length); return (fileNameOf(href) ?? href) + tail })
}
