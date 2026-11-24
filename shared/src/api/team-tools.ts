// "각자 연결하도록 권하기" / "Ask everyone to connect their own" (was "팀 추천"; docs/decisions/20261120-team-vs-personal-
// onboarding.md, 20261121-onboarding-google-team-or-own.md): the tools an owner or admin asks everyone to connect,
// for tools each person connects with their own account (Google Drive, Gmail, a listed service, an app on the
// computer). Recommended tools come first in each person's Settings › Connectors; nothing is gated by it, anyone may
// still connect anything. Stored as TeamSettings.recommendedTools (changed with PATCH /api/admin/settings) and read by
// everyone with their connections: GET /api/integrations `recommendedTools`.
import { z } from 'zod'
import { SERVICE_CATALOG } from '../service-catalog'

/** a tool's id: 'google-drive', a Google app's id ('gmail', 'calendar', 'docs', 'sheets'), a listed service's id
 * (shared/src/service-catalog.ts), a listed app on the computer (web/src/lib/localApps.ts) */
export const TeamToolId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export type TeamToolId = z.infer<typeof TeamToolId>
export const RECOMMENDED_TOOLS_MAX = 50
/** Tools the team only connects once for everyone (the welcome steps' [팀으로 연결]) and nobody connects on their own:
 * never asked for. Notion is not one since 2026-11-21: a person may connect their own Notion too, so its row has the
 * switch as well. */
export const TEAM_CONNECT_TOOLS = ['slack'] as const
/** The listed apps on a computer (web/src/lib/localApps.ts LISTED_LOCAL_APPS). */
const LOCAL_APP_TOOLS = ['aside', 'ego-lite', 'playwright', 'chrome-devtools'] as const
/** Every id a team pick may hold: Google Drive and the Google apps, the listed services and the listed apps on a
 * computer, minus the team-only tools (Slack). */
export const RECOMMENDABLE_TOOLS: readonly string[] = ['google-drive', 'gmail', 'calendar', 'docs', 'sheets', ...SERVICE_CATALOG.map((c) => c.id), ...LOCAL_APP_TOOLS]
  .filter((id) => !(TEAM_CONNECT_TOOLS as readonly string[]).includes(id))
export const isRecommendable = (id: string) => RECOMMENDABLE_TOOLS.includes(id)
/** The list as stored: known recommendable ids only, each once, in their order (the server writes this). */
export const cleanRecommended = (ids: readonly string[]): string[] => [...new Set(ids.filter(isRecommendable))]
/** in the order they were recommended; empty (and absent: every team before it, an older server): none, the usual order */
export const RecommendedTools = z.array(TeamToolId).max(RECOMMENDED_TOOLS_MAX)
export type RecommendedTools = z.infer<typeof RecommendedTools>

/** Whether the tool `id` is recommended to the team (absent: none). */
export const isRecommended = (recommended: readonly string[] | null | undefined, id: string) => !!recommended?.includes(id)

/** `items` with the recommended ones first, in the order they were recommended; the rest keep their order. */
export function recommendedFirst<T extends { id: string }>(items: readonly T[], recommended: readonly string[] | null | undefined): T[] {
  if (!recommended?.length) return [...items]
  const rank = (id: string) => { const i = recommended.indexOf(id); return i < 0 ? Infinity : i }
  return items.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.id) - rank(b.x.id) || a.i - b.i).map((v) => v.x)
}

/** The list after recommending `id` (on) or taking it back (off). */
export function withRecommended(recommended: readonly string[] | null | undefined, id: string, on: boolean): string[] {
  const rest = (recommended ?? []).filter((x) => x !== id)
  return on ? [...rest, id] : rest
}
