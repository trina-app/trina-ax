// "About this person and place" (docs/DECISIONS.md "The AI knows who it is talking to"): a few true lines in every
// turn's instructions about the person the AI answers and where they are, built from real state, so the AI stops
// answering as if everyone were the owner at a computer (it sent members to Admin pages they cannot open, told phone
// users nothing about where their settings are, and did not know whose AI account answers or that an admin turned
// personal sign-ins off).
//
// Kept short (it is in every prompt) and stable between turns (nothing that changes per answer: no usage numbers, no
// time). Nothing about anyone else: no admin names (refusal.ts "who can give access"), no connection or account names,
// never a secret. A guest gets only the line about the app: what a guest can do is said by the guest part of the
// instructions. Shared chats leave the block out (prompt.ts SHARED_PROMPT_SECTIONS: the person's role is not the chat's
// people's to know).
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { allowedCredentialKinds, isManaged, type AppConfig } from '../app-config'
import { getTeamSettings } from '../admin/settings'
import { personalConnectionsAllowed } from '../credentials/policy'
import { resolveCredential, type CredEngine } from '../credentials/resolve'
import { isGuestUser } from '../credentials/guest-ai'
import type { RunKind } from '../system/deployment'
import { currentPlan } from '../system/limits'
import { SCREEN } from '../policy/refusal'
import type { Role } from '../policy/access'

/** Where the person reads this answer. 'desktop' is the desktop app without its browser for this answer. */
export type SituationApp = 'web' | 'mobile' | 'desktop' | 'desktop-browser' | 'slack' | 'schedule'

export interface Situation {
  role: Role
  guest: boolean
  app: SituationApp | null
  /** whose AI account answers: their own sign-in, one the team set up, or the sign-in of the computer the server runs
   * on (a server without AI connections: an Office Mac, a developer's); null: not known (no usable one) */
  ai: 'own' | 'team' | 'host' | null
  /** may they add their own AI account (Settings › AI providers is shown to them) */
  ownAi: boolean
  /** may they add their own connected services (Settings › Connectors) */
  ownConnectors: boolean
  /** the team's plan, for the owner and admins only (a hosted team's plan file) */
  plan: { name: string; people: number | null; guests: number | null } | null
}

/** The app from the session's client kind and whether this answer has the desktop browser. */
export function appOf(clientKind: string | null, browser: boolean): SituationApp | null {
  if (browser) return 'desktop-browser'
  return clientKind === 'web' || clientKind === 'mobile' || clientKind === 'desktop' || clientKind === 'slack' || clientKind === 'schedule' ? clientKind : null
}

/** The situation of a turn, from the database and the server's config. Never throws: a part it cannot read is left out. */
export function situationOf(ctx: { db: Database; config: AppConfig }, p: { userId: string; role: Role; clientKind: string | null; browser: boolean; engine: string; locale: Locale }): Situation {
  const guest = p.role === 'guest' || safe(() => isGuestUser(ctx.db, p.userId), true)
  const staff = !guest && (p.role === 'owner' || p.role === 'admin')
  let ai: Situation['ai'] = null
  if (!isManaged(ctx.config)) ai = p.engine === 'api' ? 'team' : 'host'
  else if (p.engine === 'api') ai = 'team'
  else if (p.engine === 'claude-code' || p.engine === 'codex') {
    const r = safe(() => resolveCredential(ctx.db, { userId: p.userId, engine: p.engine as CredEngine, allowedKinds: allowedCredentialKinds(ctx.config) }), null)
    ai = r?.ok ? (r.tier === 'own' ? 'own' : 'team') : null
  }
  const plan = staff ? safe(() => currentPlan(), null) : null
  return {
    role: p.role, guest, app: appOf(p.clientKind, p.browser), ai,
    ownAi: safe(() => personalConnectionsAllowed(ctx.db, p.userId), false),
    ownConnectors: !guest && safe(() => getTeamSettings(ctx.db).personalIntegrations !== false, false),
    plan: plan ? { name: plan.display?.name?.[p.locale] ?? plan.display?.name?.en ?? plan.plan, people: plan.maxActiveMembers ?? null, guests: plan.maxGuests ?? null } : null,
  }
}

function safe<T>(f: () => T, fallback: T): T { try { return f() } catch { return fallback } }

/** The app line: where the person reads the answer, and what that means for where things are. */
function appLine(s: Situation, L: Locale): string {
  const settingsWhere = (phone: boolean) => phone ? `${SCREEN.settings(L)} is under ${SCREEN.meTab(L)} at the bottom of the phone app` : ''
  switch (s.app) {
    case 'mobile': return `- App: the ${PRODUCT.displayName} phone app.${s.guest ? '' : ` ${settingsWhere(true)}${s.role === 'owner' || s.role === 'admin' ? ', and Admin is in that list too' : ''}.`}`
    case 'web': return `- App: ${PRODUCT.displayName} in a web browser.`
    case 'desktop': return `- App: the ${PRODUCT.displayName} desktop app, but its browser is not connected to this answer: if they need a website opened or used, read public pages with your web tools and say they can ask again with this chat open in the desktop app.`
    case 'desktop-browser': return `- App: the ${PRODUCT.displayName} desktop app, with its browser next to the chat.`
    case 'slack': return '- App: they asked from Slack, and your answer goes back to them there: no cards or buttons of the app show in Slack, so name any file you save by its team path.'
    case 'schedule': return '- App: none. This is a scheduled task\'s run; nobody is watching.'
    default: return ''
  }
}

/** The block itself ('' when there is nothing to say). */
export function situationSection(s: Situation, L: Locale): string {
  const lines: string[] = []
  const app = appLine(s, L)
  if (s.guest) return app ? plainNames(['## About this person and place', app].join('\n')) : ''
  const staff = s.role === 'owner' || s.role === 'admin'
  // role, and what that role may open
  if (staff) lines.push(`- Role: ${s.role === 'owner' ? 'the team\'s owner' : 'an admin'}. They can open ${SCREEN.adminSettings(L)} for team-wide changes, and ${SCREEN.settings(L)} for their own.`)
  else lines.push(`- Role: a member. They cannot open Admin: for a team-wide change (who sees which folder, groups, the team's connected apps, plugins, the team's AI accounts, team settings) say the team's owner or an admin does it; never send them to an Admin page. Their own things are in ${SCREEN.settings(L)}.`)
  if (app) lines.push(app)
  // whose AI answers, and what they may add themselves
  const ownAi = s.ownAi ? `They can add their own AI sign-in in ${SCREEN.ownProviders(L)}.` : `Adding their own AI account is turned off for this team${staff ? ` (${SCREEN.adminProviders(L)})` : ' by an admin: do not suggest it'}.`
  if (s.ai === 'own') lines.push(`- AI: your answers use their own AI account (${SCREEN.ownProviders(L)}).`)
  else if (s.ai === 'team') lines.push(`- AI: your answers use an AI account the team set up${staff ? ` (${SCREEN.adminProviders(L)})` : ''}. ${ownAi}`)
  else if (s.ai === 'host') lines.push(`- AI: your answers use the AI sign-in of the computer this server runs on${staff ? ` (${SCREEN.adminProviders(L)})` : ', set up by the owner'}.`)
  else lines.push(`- AI: ${ownAi}`)
  lines.push(`- Their own AI usage and limits are in ${SCREEN.usage(L)}.`)
  lines.push(s.ownConnectors
    ? `- Their own connected services (their accounts at other services) are in ${SCREEN.connectors(L)}, or connect one with a card in this chat.`
    : `- Adding their own connected services is turned off for this team by an admin${staff ? '' : ': do not offer to connect one for them; the team\'s connected apps are an admin\'s'}.`)
  if (s.plan) {
    const caps = [s.plan.people !== null ? `up to ${s.plan.people} active people including the owner` : '', s.plan.guests !== null ? `${s.plan.guests} guests` : ''].filter(Boolean).join(', and ')
    lines.push(`- Team plan: ${oneLine(s.plan.name)}${caps ? ` (${caps})` : ''}; ${SCREEN.adminSystem(L)} shows it.`)
  }
  return plainNames(['## About this person and place', ...lines].join('\n'))
}

/** `Admin › System ("Admin › System")` in English is just `Admin › System`: the quoted name only when it differs. */
export const plainNames = (t: string) => t.replace(/([A-Z][\w&]*(?: [\w&]+)*(?: › [\w&]+(?: [\w&]+)*)*) \("\1"\)/g, '$1')

const oneLine = (x: string) => x.replace(/[\r\n<>]+/g, ' ').slice(0, 60)

/** Where the server runs, as the AI says it (prompt.ts environmentSection): on a hosted team it is not "in the office". */
export function serverWhere(kind: RunKind): string {
  return kind === 'hosted' ? `a server the ${PRODUCT.displayName} service runs for the team in the cloud`
    : kind === 'office' ? 'a Mac in the team\'s office'
      : 'the team\'s own server'
}
