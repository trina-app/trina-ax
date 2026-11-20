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
import { ACCOUNT_DELETION_GRACE_DAYS, type Locale } from '@mycel/shared/api'
import { allowedCredentialKinds, isFreeRoam, isManaged, type AppConfig } from '../app-config'
import { getTeamSettings } from '../admin/settings'
import { personalConnectionsAllowed } from '../credentials/policy'
import { resolveCredential, type CredEngine } from '../credentials/resolve'
import { isGuestUser } from '../credentials/guest-ai'
import { featuresOf, type RunKind } from '../system/deployment'
import { currentPlan } from '../system/limits'
import { guestLimit } from '../auth/guests'
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
  /** the team's plan, for the owner and admins only (a hosted team's plan file); name null: the file has no display
   * name (the plan's id, such as "basic", is not what people see) */
  plan: { name: string | null; people: number | null; guests: number | null } | null
  /** this answer can read public web pages (web search is off for guests, confidential and restricted chats) */
  web: boolean
  /** this install can mirror a folder of its computer into the team folder (system/deployment.ts connectedFolders:
   * not on a hosted team or a demo); absent: not said */
  connectedFolders?: boolean
  /** a free-roam demo instance (app-config.ts isFreeRoam; docs/decisions/20261119-demo-free-roam-a.md): the block names
   * no page the demo fences or hides (demo/guard.ts, web lib/freeRoam.ts FREE_ROAM_HIDDEN_SETTINGS); absent: not one */
  freeRoam?: boolean
}

/** The app from the session's client kind and whether this answer has the desktop browser. */
export function appOf(clientKind: string | null, browser: boolean): SituationApp | null {
  if (browser) return 'desktop-browser'
  return clientKind === 'web' || clientKind === 'mobile' || clientKind === 'desktop' || clientKind === 'slack' || clientKind === 'schedule' ? clientKind : null
}

/** The situation of a turn, from the database and the server's config. Never throws: a part it cannot read is left out. */
/** `managed`: this turn's engine answers through the team's AI connections behind the model proxy (chat/engines.ts:
 * Claude in managed mode, Codex on an installed server), as the turn decides it (turn.ts); absent: engine.authMode says.
 * The engine is the one the turn starts with: a limit that hands the answer to the other engine midway does not
 * change the block (the next turn's does). */
export function situationOf(ctx: { db: Database; config: AppConfig }, p: { userId: string; role: Role; clientKind: string | null; browser: boolean; engine: string; locale: Locale; managed?: boolean; webSearch?: boolean }): Situation {
  const guest = p.role === 'guest' || safe(() => isGuestUser(ctx.db, p.userId), true)
  const staff = !guest && (p.role === 'owner' || p.role === 'admin')
  let ai: Situation['ai'] = null
  if (p.engine === 'api') ai = 'team'
  else if (!(p.managed ?? isManaged(ctx.config))) ai = 'host'
  else if (p.engine === 'claude-code' || p.engine === 'codex') {
    const r = safe(() => resolveCredential(ctx.db, { userId: p.userId, engine: p.engine as CredEngine, allowedKinds: allowedCredentialKinds(ctx.config) }), null)
    ai = r?.ok ? (r.tier === 'own' ? 'own' : 'team') : null
  }
  const plan = staff ? safe(() => currentPlan(), null) : null
  return {
    role: p.role, guest, app: appOf(p.clientKind, p.browser), ai,
    ownAi: safe(() => personalConnectionsAllowed(ctx.db, p.userId), false),
    ownConnectors: !guest && safe(() => getTeamSettings(ctx.db).personalIntegrations !== false, false),
    // guests: the cap the server applies (auth/guests.ts guestLimit: 3 while the plan file has none)
    plan: plan ? { name: plan.display?.name?.[p.locale] ?? plan.display?.name?.en ?? null, people: plan.maxActiveMembers ?? null, guests: safe(() => guestLimit(), null) } : null,
    web: p.webSearch ?? true,
    connectedFolders: safe(() => featuresOf(ctx.config).connectedFolders, false),
    ...(safe(() => isFreeRoam(ctx.config), false) ? { freeRoam: true } : {}),
  }
}

function safe<T>(f: () => T, fallback: T): T { try { return f() } catch { return fallback } }

/** The app line: where the person reads the answer, and what that means for where things are. */
function appLine(s: Situation, L: Locale): string {
  switch (s.app) {
    // the phone's Me tab is Settings: its list holds the same pages (SettingsDialog.tsx PhoneSettingsList), Admin too
    case 'mobile': return `- App: the ${PRODUCT.displayName} phone app.${s.guest ? '' : ` There ${SCREEN.settings(L)} is ${SCREEN.meTab(L)} at the bottom: its list has the same pages${(s.role === 'owner' || s.role === 'admin') && !s.freeRoam ? ', and Admin is in that list too' : ''}.`}`
    case 'web': return `- App: ${PRODUCT.displayName} in a web browser.`
    // a guest has no browser (chat/guest-tools.ts) and the Guest section says what they cannot do: the app's name only
    case 'desktop': if (s.guest) return `- App: the ${PRODUCT.displayName} desktop app.`
      return `- App: the ${PRODUCT.displayName} desktop app, but its browser is not connected to this answer${s.web ? ': if they need a website opened or used, read public pages with your web tools and say they can ask again in a moment, when the app\'s browser can join' : ''}.`
    case 'desktop-browser': if (s.guest) return `- App: the ${PRODUCT.displayName} desktop app.`
      return `- App: the ${PRODUCT.displayName} desktop app, with its browser next to the chat.`
    case 'slack': return '- App: they asked from Slack, and your answer goes back to them there: no cards or buttons of the app show in Slack, so give the team path of any file you save, next to its link.'
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
  // a free-roam demo (QA TC-5570): these lines sent visitors to Settings › Usage and Settings › Profile › Delete account,
  // pages the demo hides, over the demo's own rule (prompt.ts demoRule). Here the block names no page the demo fences or
  // hides: Admin (every admin endpoint), AI providers and Usage, connecting services, deleting the account, the plan
  // (Admin › System). What is not in the demo is demoRule's to say.
  if (s.freeRoam) {
    lines.push(`- Role: ${s.role === 'owner' ? 'the team\'s owner' : s.role === 'admin' ? 'an admin' : 'a member'} in this demo. Admin and its pages are not in the demo: never send them to an Admin page. Their own things are in ${SCREEN.settings(L)}.`)
    if (app) lines.push(app)
    if (s.connectedFolders !== undefined) lines.push(`- Files: earlier versions are in ${SCREEN.fileHistory(L)}; you can show who saved each version and what changed (read with versions); bringing one back is the person's ${SCREEN.restoreButton(L)} there (the current one is kept as a version too).`)
    return plainNames(['## About this person and place', ...lines].join('\n'))
  }
  // role, and what that role may open
  if (staff) lines.push(`- Role: ${s.role === 'owner' ? 'the team\'s owner' : 'an admin'}. They can open ${SCREEN.adminSettings(L)} for team-wide changes, and ${SCREEN.settings(L)} for their own.`)
  else lines.push(`- Role: a member. They cannot open Admin: for a team-wide change (who sees which folder, groups, the team's connected apps, plugins, the team's AI accounts, team settings) say the team's owner or an admin does it; never send them to an Admin page. Their own things are in ${SCREEN.settings(L)}.`)
  if (app) lines.push(app)
  // whose AI answers, and what they may add themselves
  const ownAi = s.ownAi ? `They can add their own AI sign-in in ${SCREEN.ownProviders(L)}.` : `Adding their own AI account is turned off for this team${staff ? ` (${SCREEN.adminProviders(L)})` : ' by an admin: do not suggest it'}.`
  if (s.ai === 'own') lines.push(`- AI: your answers use their own AI account (${SCREEN.ownProviders(L)}).`)
  else if (s.ai === 'team') lines.push(`- AI: your answers use an AI account the team set up${staff ? ` (${SCREEN.adminProviders(L)})` : ''}. ${ownAi}`)
  // everyone answers on that one sign-in (app-config.ts local-login): asked "can I switch to my own Claude account?", the
  // AI sent people to Settings or Admin pages to add one (AI scenario CON-07, 2026-11-17)
  else if (s.ai === 'host') lines.push(`- AI: your answers use the AI sign-in of the computer the team's ${PRODUCT.displayName} runs on${staff ? ` (${SCREEN.adminProviders(L)} shows it but cannot change it)` : ', set up by the owner'}. It serves everyone: nobody can switch to their own AI account here; another account means ${staff ? 'signing in again on that computer itself, not in the app' : 'the owner signs in again on that computer itself'}.`)
  else lines.push(`- AI: ${ownAi}`)
  lines.push(`- Their own AI usage and limits are in ${SCREEN.usage(L)}.`)
  // a card needs someone in the app: never in Slack or a scheduled run
  const card = s.app !== 'slack' && s.app !== 'schedule'
  lines.push(s.ownConnectors
    ? `- Their own connected services (their accounts at other services) are in ${SCREEN.connectors(L)}${card ? ', or connect one with a card in this chat' : ''}.`
    : `- Adding their own connected services is turned off for this team by an admin${staff ? '' : ': do not offer to connect one for them; the team\'s connected apps are an admin\'s'}.`)
  // leaving: a member or an admin deletes their own account, the owner hands the team over first (AccountDeletion.tsx;
  // asked "how do I delete my account?", the AI said only an admin can: AI scenario ACC-03, 2026-11-17)
  lines.push(s.role === 'owner'
    ? `- Deleting their account: not as the owner; first hand the team over (${SCREEN.handover(L)}), then ${SCREEN.deleteAccount(L)}.`
    : `- Deleting their account: themselves, in ${SCREEN.deleteAccount(L)}; done ${ACCOUNT_DELETION_GRACE_DAYS} days later, cancellable until then.`)
  // earlier versions and connected folders (AI scenario SYS-04, 2026-11-17: "I don't know where the version history is")
  // what the AI itself does with them (read with versions, files/service.ts readVersions: who saved each, what changed)
  // and what is the person's (Restore there): a rerun offered to bring the old content back itself (dev f394c9258,
  // 2026-11-17)
  if (s.connectedFolders !== undefined) lines.push(`- Files: earlier versions are in ${SCREEN.fileHistory(L)}; you can show who saved each version and what changed (read with versions); bringing one back is the person's ${SCREEN.restoreButton(L)} there (the current one is kept as a version too). ${s.connectedFolders
    ? `Connected folders: the owner can mirror a folder of the computer the team's app runs on (a NAS or Google Drive there too) read-only${s.role === 'owner' ? ` (${SCREEN.connectedFolders(L)})` : ''}; only folders of that computer, not of anyone's other computers.`
    : 'Connected folders (a computer\'s folder kept in the team folder): not on this install.'}`)
  if (s.plan) {
    const caps = [s.plan.people !== null ? `up to ${s.plan.people} active people including the owner` : '', s.plan.guests !== null ? `${s.plan.guests} guests` : ''].filter(Boolean).join(', and ')
    lines.push(`- Team plan: ${s.plan.name ? `${oneLine(s.plan.name)}${caps ? ` (${caps})` : ''}` : caps || 'set by the hosting service'}; ${SCREEN.adminSystem(L)} shows it.`)
  }
  return plainNames(['## About this person and place', ...lines].join('\n'))
}

/** `Admin › System ("Admin › System")` in English is just `Admin › System`: the quoted name only when it differs. */
export const plainNames = (t: string) => t.replace(/([A-Z][\w&]*(?: [\w&]+)*(?: › [\w&]+(?: [\w&]+)*)*) \("\1"\)/g, '$1').replace(/the Me tab \("Me"\)/g, 'the Me tab')

const oneLine = (x: string) => x.replace(/[\r\n<>]+/g, ' ').slice(0, 60)

/** Where the server runs, as the AI says it (prompt.ts environmentSection): on a hosted team it is not "in the office". */
export function serverWhere(kind: RunKind): string {
  return kind === 'hosted' ? `run for the team by the ${PRODUCT.displayName} service in the cloud`
    : kind === 'office' ? 'a Mac in the team\'s office'
      : 'a computer the team runs itself'
}
