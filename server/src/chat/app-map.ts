// "Where things are in the app" (docs/decisions/20261116-ai-app-map.md): a short map of the app's screens in every
// turn's instructions, so that asked "where do I …" or "can I …" the AI names the real place instead of hedging ("if
// there is such a setting"), sending people to an admin, or saying a feature does not exist (AI scenario check, first
// run 2026-11-16, root cause #2).
//
// One line per place, about 25 lines. The places are named by the labels the person's app shows, in their language:
// each label is a web i18n key (APP_MAP_KEYS), its words in app-map-labels.ts, generated from web/src/i18n by
// scripts/app-map-labels.ts; tests/unit/ai-app-map.test.ts fails when a key is gone or its words changed, and when a
// Settings tab, Admin page, Team settings group or System group named here is gone.
//
// Who gets which form (`view`):
//   staff   the owner or an admin in their own chat: every Admin line;
//   member  a member in their own chat: one line for all of Admin ("the owner or an admin does it there"; the
//           situation block already says never to send them to an Admin page);
//   shared  a shared chat (no role known to its people, prompt.ts SHARED_PROMPT_SECTIONS): the Admin lines, headed
//           "owners and admins", the same for everyone, so nothing about the asker's role shows.
// A guest gets none (none of the team's screens are theirs; the guest section says what they can do).
// Install facts: guest AI only where the AI runs on the team's connections (managed); the dev environment only where
// the server has it (MYCEL_DEV_ENV, devenv/setting.ts devEnvFlag); otherwise one line says it is not on this install.
import { ownFolderLabel, PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Locale } from '@mycel/shared/api'
import { APP_MAP_LABELS } from './app-map-labels'
import { APP_MAP_KEYS, type AppMapKey } from './app-map-keys'

export { APP_MAP_KEYS, type AppMapKey }
import { tr } from './i18n'

/** The Settings tabs (web/src/pages/settingsTabs.ts), Admin pages (AdminLayout.tsx MENU), Team settings groups
 * (teamSettingsGroups.ts) and System groups (systemGroups.ts) the map names, by id, with the label key the map names
 * them by: the test checks each still exists with that label. */
export const APP_MAP_PLACES = {
  settings: { allowances: 'settings.allowances', notifications: 'notifications.title', apps: 'settings.apps', about: 'settings.about', 'ai-apps': 'aiApps.title', profile: 'settings.profile' },
  admin: { members: 'admin.members', usage: 'admin.usage', audit: 'admin.audit', settings: 'admin.settings', plugins: 'admin.plugins', providers: 'admin.providers', system: 'admin.system' },
  teamSettings: { general: 'teamSettings.section.general', voice: 'speech.title', ai: 'teamSettings.group.engine', limits: 'budgets.title', 'dev-env': 'devEnv.title' },
  system: { storage: 'storage.title', updates: 'system.updates', backups: 'system.backups', export: 'system.export', connection: 'system.connection' },
} as const satisfies Record<string, Record<string, AppMapKey>>

export interface AppMapInput {
  view: 'staff' | 'member' | 'shared'
  /** the AI answers through the team's AI connections (guests can have AI) */
  managed: boolean
  /** the server has the dev environment (Me.server.devEnv) */
  devEnv: boolean
  /** an office Mac (config.office): admins see System's updates there too (web systemGroups.ts `office`) */
  office: boolean
}

/** Which form a person's turn gets: a shared chat's role-neutral one, an owner's or admin's, a member's. */
export const appMapView = (role: string, shared: boolean): AppMapInput['view'] => shared ? 'shared' : role === 'owner' || role === 'admin' ? 'staff' : 'member'

/** One label in the person's language: `{product}` is the product's name (the AI's name for the ready-made skills, as
 * the Skills page says it: web lib/tabs.ts namedProduct), `{level}` "…". */
export function appLabel(key: AppMapKey, L: Locale): string {
  const row = APP_MAP_LABELS[key]
  const text = row?.[L] ?? row?.en ?? key
  const product = key === 'skills.catalog.more' && PRODUCT_NAMED_AFTER_AI ? appLabelRaw('rooms.aiName', L) : PRODUCT.displayName
  // a count after " · " ("트리나가 준비한 스킬 · {n}개 더", "연동 · {count}") is the screen's, not the place's name
  return text.split(' · ')[0]!.replaceAll('{product}', product)
}
const appLabelRaw = (key: string, L: Locale) => APP_MAP_LABELS[key]?.[L] ?? APP_MAP_LABELS[key]?.en ?? key

/** The section's text. */
export function appMapSection(o: AppMapInput, L: Locale): string {
  // labels in the person's words, a path joined by " › " (no quotes: the labels stand out in an English line)
  const q = (...keys: AppMapKey[]) => keys.map((k) => appLabel(k, L)).join(' › ')
  const set = (k: AppMapKey) => q('settings.title', k)
  const here = `this team's ${PRODUCT.displayName}`
  const lines = [
    '## Where things are in the app',
    'Asked where or how to do something in the app, answer from this map with its labels. Not here: say you are not sure, not that it does not exist.',
    `- Chat title menu (its creator): ${q('chat.rename')}. Chat list: ${q('navFolders.new')}, ${q('navFolders.moveTo')}. Answer: ${q('chat.regenerate')}; own message: ${q('chat.edit')}.`,
    `- ${tr('cardAlways', L)} on a card: not asked again; undo in ${set(PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi')}.`,
    `- Room ⋯ › ${q('roomApps.menuAdd')} (${q('roomApps.menuList')} once it has some): Google Forms or any service with a ${q('roomApps.address')} posts into the room.`,
    `- Room bell or ⋯ › ${q('rooms.menu.notify')}: ${q('rooms.notify.mentions')} / ${q('rooms.notify.off')}. ${q('notifications.quiet')}: ${set('notifications.title')}.`,
    `- ${q('settings.title')}: ${q('settings.apps')} (phone, Mac, Windows apps), ${q('settings.about')} (version), ${q('aiApps.title')} (team files from Claude or another AI app), ${q('settings.profile')} (their AI and model, if the team allows).`,
    `- ${q('sidebar.skills')}: ${q('skills.catalog.more')} (ready-made; owners and admins see it while some are missing); ${q('skills.catalog.bring')} (on a computer; a member's are reviewed).`,
    `- Desktop app only, not the Mac App Store one: ${q('sidebar.files')} › ${ownFolderLabel(L)} › ${q('files.findWork.entryButton')}.`,
  ]
  if (o.view === 'member') {
    // situation.ts's member line already names folders, groups, connected apps, plugins, AI accounts and team settings
    lines.push(`- Also the owner's or an admin's, in ${q('admin.title')}: guests, handover, usage and limits, activity log, time zone, voice input, system (storage, updates, backups, team address).${o.devEnv ? '' : ` A setting that lets the AI run programs for you: ${here} doesn't have it.`}`)
    return lines.join('\n')
  }
  lines.push(
    `Pages of ${q('admin.title')}${o.view === 'shared' ? ' (owners and admins only)' : ''} (say ${q('admin.title')} › page):`,
    `- ${q('admin.members')}: invites, roles; owner: ${q('handover.menu')} on a person's ⋯; ${q('guest.admin.title')}.`,
    o.managed
      ? `- Guest AI (${q('guest.invite.ai')}, at invite or on their row): ${q('guest.ai.none')} / ${q('guest.ai.own')} / ${q('guest.ai.team')} with a monthly limit.`
      : `- Guest AI: not on ${here}.`,
    `- ${q('admin.usage')}: who used how much. ${q('admin.audit')}: who did what.`,
    `- ${q('admin.settings')}: ${q('teamSettings.section.general')} (${q('teamSettings.timeZone')}), ${q('budgets.title')}, ${q('speech.title')}, ${q('teamSettings.group.engine')} (team AI and model, who may pick)${o.devEnv ? `, ${q('devEnv.title')} (lets the AI run programs for you)` : `; a setting that lets the AI run programs for you: ${here} doesn't have it`}.`,
    `- ${q('admin.plugins')}: Hangul (HWP) writing. ${q('admin.providers')}: team AI accounts.`,
    o.office
      ? `- ${q('admin.system')}: ${q('storage.title')}, ${q('system.updates')}; owner also ${q('system.backups')}, ${q('system.export')}, ${q('system.connection')} (${q('system.address')}).`
      : `- ${q('admin.system')}: ${q('storage.title')}; owner also ${q('system.updates')}, ${q('system.backups')}, ${q('system.export')}, ${q('system.connection')} (${q('system.address')}).`,
  )
  return lines.join('\n')
}
