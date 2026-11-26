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
