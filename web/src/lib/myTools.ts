// "Connect your tools", the My setup card's row (components/onboarding/MyToolsRow.tsx; docs/decisions/20261120-my-setup-
// card.md): which tools it lists and how each one stands. Pure rules, unit-tested in web/test/unit/my-tools.test.ts.
//
// The team's recommended tools first, then the usual ones, at most MAX_TOOLS. The recommended list is
// TeamSettings.recommendedTools as GET /api/integrations sends it (shared/src/api/team-tools.ts, ordered with its
// recommendedFirst); absent (an older server) or empty is none, so the usual ones alone show. Nothing is gated by it:
// owners, admins and members see the same list. A tool this server cannot connect for the person (Drive not set up, a
// Google app off, personal connections off) is left out.
import { recommendedFirst } from '@mycel/shared/api'
import { CONNECTORS } from './connectors'
import { isGoogleApp } from './googleApps'

/** the usual tools after the team's own: Google Drive, Gmail, Google Calendar, Notion */
export const DEFAULT_TOOLS = ['google-drive', 'gmail', 'calendar', 'notion'] as const
export const MAX_TOOLS = 4

export type ToolKind = 'drive' | 'google' | 'listed'
/** mine: connected with the person's own account; team: the team connected it for everyone (no button); open: [연결] */
export type ToolState = 'mine' | 'team' | 'open'
export interface ToolOffer { id: string; kind: ToolKind; state: ToolState }

/** What the row knows about each tool, read from the person's own lists (the server's words, simplified). */
export interface ToolFacts {
  /** TeamSettings.recommendedTools (undefined: not sent) */
  recommended: readonly string[] | null | undefined
  drive: { configured: boolean; mine: boolean } | null
  google: readonly { id: string; available: boolean; mine: boolean; team: boolean }[]
  /** the person may add their own connections (IntegrationList.personalAllowed) */
  listedAllowed: boolean
  /** the listed services (by catalog id) they have connected, and the ones the team connected for everyone */
  listedMine: ReadonlySet<string>
  listedTeam: ReadonlySet<string>
}

function offer(id: string, f: ToolFacts): ToolOffer | null {
  if (id === 'google-drive') return f.drive?.configured ? { id, kind: 'drive', state: f.drive.mine ? 'mine' : 'open' } : null
  if (isGoogleApp(id)) {
    const g = f.google.find((x) => x.id === id)
    if (!g) return null
    if (g.mine) return { id, kind: 'google', state: 'mine' }
    if (g.team) return { id, kind: 'google', state: 'team' }
    return g.available ? { id, kind: 'google', state: 'open' } : null
  }
  if (!CONNECTORS.some((c) => c.id === id)) return null
  if (f.listedMine.has(id)) return { id, kind: 'listed', state: 'mine' }
  if (f.listedTeam.has(id)) return { id, kind: 'listed', state: 'team' }
  return f.listedAllowed ? { id, kind: 'listed', state: 'open' } : null
}

/** The row's tools, in order: the team's recommended ones, then the usual ones; each once, at most MAX_TOOLS. */
export function myTools(f: ToolFacts, max = MAX_TOOLS): ToolOffer[] {
  const ids = recommendedFirst([...new Set([...(f.recommended ?? []), ...DEFAULT_TOOLS])].map((id) => ({ id })), f.recommended).map((x) => x.id)
  const out: ToolOffer[] = []
  for (const id of ids) {
    if (out.length >= max) break
    const o = offer(id, f)
    if (o) out.push(o)
  }
  return out
}
