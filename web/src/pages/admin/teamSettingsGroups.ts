// Team settings on a phone (below 768 px; docs/DECISIONS.md "Admin and Settings on phones", the form pages): a short
// list of the page's own groups, each its own page under "‹ Team settings" at /admin/settings/<group>, so a phone never
// scrolls the whole 6,700 px page. Computers and tablets keep the one page; there /admin/settings/<group> opens the page
// at that group (#anchor). A link to a part of the page (#ai, #ai-limits, #speech, #ts-time, …) opens, on a phone, the
// group that holds it. The groups are the page's sections in the page's order; small ones share a page (General with
// Time and updates; the AI defaults with who picks the engine and members' own accounts). `form`: its fields save with
// the page's one Save (the save bar shows there); the others save on their own. `heading`: no section of the group
// has the group's name, so the page says it (for screen readers; the phone bar shows it).
import { Archive, Briefcase, Cpu, Gauge, Mic, Network, Settings2, TerminalSquare, UsersRound } from 'lucide-react'
import type { MessageKey } from '../../i18n'

export interface TeamSettingsGroup {
  id: string
  label: MessageKey
  icon: typeof Settings2
  /** the ids of the page's sections in it: the first is where the computer's page opens for this group */
  anchors: string[]
  form?: boolean
  heading?: boolean
  /** only on a server with the dev environment experiment (Me.server.devEnv) */
  devEnv?: boolean
}

export const TEAM_SETTINGS_GROUPS: TeamSettingsGroup[] = [
  { id: 'general', label: 'teamSettings.section.general', icon: Settings2, anchors: ['ts-general', 'ts-time'], form: true },
  { id: 'data', label: 'teamSettings.section.data', icon: Archive, anchors: ['ts-data'], form: true },
  { id: 'members', label: 'teamSettings.section.ai', icon: UsersRound, anchors: ['ts-ai'], form: true },
  { id: 'voice', label: 'speech.title', icon: Mic, anchors: ['speech'], form: true },
  { id: 'ai', label: 'teamSettings.group.engine', icon: Cpu, anchors: ['ai'], heading: true },
  { id: 'limits', label: 'budgets.title', icon: Gauge, anchors: ['ai-limits'] },
  { id: 'knowledge', label: 'kg.title', icon: Network, anchors: ['knowledge-graph'] },
  { id: 'company', label: 'onboarding.profile.title', icon: Briefcase, anchors: ['company-profile'] },
  { id: 'dev-env', label: 'devEnv.title', icon: TerminalSquare, anchors: ['dev-env'], heading: true, devEnv: true },
]

/** The groups this server has. */
export const teamSettingsGroups = (devEnv: boolean | undefined) => TEAM_SETTINGS_GROUPS.filter((g) => !g.devEnv || devEnv)

export const teamSettingsGroup = (id: string | undefined, devEnv: boolean | undefined) => (id ? teamSettingsGroups(devEnv).find((g) => g.id === id) : undefined)

/** The group that holds a part of the page ("#ai-limits" → Usage limits), or undefined. */
export const groupOfHash = (hash: string, devEnv: boolean | undefined) => {
  const id = decodeURIComponent(hash.replace(/^#/, ''))
  return id ? teamSettingsGroups(devEnv).find((g) => g.anchors.includes(id)) : undefined
}

/**
 * Where /admin/settings goes instead, or null: on a phone a #part of the page opens its group's page (the #hash kept,
 * so the group scrolls to it); on a computer a group's page is the one page at that group. An unknown group: the
 * list (a phone) or the page (a computer).
 */
export function teamSettingsRedirect(o: { sub: string | undefined; hash: string; phone: boolean; devEnv: boolean | undefined }): string | null {
  if (o.sub) {
    const g = teamSettingsGroup(o.sub, o.devEnv)
    if (!g) return '/admin/settings'
    return o.phone ? null : `/admin/settings${o.hash || `#${g.anchors[0]}`}`
  }
  if (!o.phone || !o.hash) return null
  const g = groupOfHash(o.hash, o.devEnv)
  return g ? `/admin/settings/${g.id}${o.hash}` : null
}
