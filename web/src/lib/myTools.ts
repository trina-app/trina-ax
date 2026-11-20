// "Connect your tools", the My setup card's row (components/onboarding/MyToolsRow.tsx; docs/decisions/20261120-my-setup-
// card.md): which tools it lists and how each one stands. Pure rules, unit-tested in web/test/unit/my-tools.test.ts.
//
// The team's recommended tools first, then the usual ones, at most MAX_TOOLS. The recommended list is
// TeamSettings.memberTools as GET /api/integrations sends it (docs/decisions/20261120-team-tools-step.md, PR #93):
// null or left out (not chosen, an older server, a build before it) is "every tool", so the usual ones alone show.
// For a member a tool shows only while it is on for members; owners and admins see every tool. A tool this server
// cannot connect for the person (Drive not set up, a Google app off, personal connections off) is left out.
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
  /** TeamSettings.memberTools (undefined: not sent) */
  recommended: readonly string[] | null | undefined
  /** an owner or admin: every tool, whatever is on for members */
  admin: boolean
  drive: { configured: boolean; mine: boolean } | null
  google: readonly { id: string; available: boolean; mine: boolean; team: boolean }[]
  /** the person may add their own connections (IntegrationList.personalAllowed) */
  listedAllowed: boolean
  /** the listed services (by catalog id) they have connected, and the ones the team connected for everyone */
  listedMine: ReadonlySet<string>
  listedTeam: ReadonlySet<string>
}

/** whether the tool `id` is on for members (null or left out: every tool) */
const onForMembers = (tools: readonly string[] | null | undefined, id: string) => tools == null || tools.includes(id)

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
  const ids = [...new Set([...(f.recommended ?? []), ...DEFAULT_TOOLS])]
  const out: ToolOffer[] = []
  for (const id of ids) {
    if (out.length >= max) break
    if (!f.admin && !onForMembers(f.recommended, id)) continue
    const o = offer(id, f)
    if (o) out.push(o)
  }
  return out
}
