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
import { tr } from './i18n'

/** The web app's i18n keys this map names (web/src/i18n/en.ts). The generator writes their words to app-map-labels.ts. */
export const APP_MAP_KEYS = [
  'settings.title', 'admin.title', 'sidebar.files', 'sidebar.skills', 'rooms.aiName',
  // chats
  'chat.rename', 'navFolders.new', 'navFolders.moveTo', 'chat.regenerate', 'chat.edit',
  // cards and allowances (the card's own "Always allow" is the server's: chat/i18n.ts cardAlways)
  'settings.allowances', 'settings.allowancesAi',
  // rooms
  'rooms.menu.label', 'roomApps.menuAdd', 'roomApps.listTitle', 'roomApps.address', 'rooms.menu.notify',
  'rooms.notify.all', 'rooms.notify.mentions', 'rooms.notify.off',
  // Settings
  'notifications.title', 'notifications.quiet', 'settings.apps', 'settings.about', 'aiApps.title', 'settings.profile',
  // skills, files
  'skills.tabSkills', 'skills.catalog.title', 'skills.catalog.bring', 'files.findWork.entryButton',
  // Admin
  'admin.members', 'handover.menu', 'guest.admin.title', 'guest.invite.ai', 'guest.ai.none', 'guest.ai.own', 'guest.ai.team',
  'admin.usage', 'budgets.title', 'admin.audit', 'admin.settings', 'teamSettings.section.general', 'teamSettings.timeZone',
  'speech.title', 'teamSettings.group.engine', 'devEnv.title', 'admin.plugins', 'admin.providers', 'admin.system',
  'storage.title', 'system.updates', 'system.backups', 'system.export', 'system.connection', 'system.address',
] as const
export type AppMapKey = (typeof APP_MAP_KEYS)[number]

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
}

/** One label in the person's language: `{product}` is the product's name (the AI's name for the ready-made skills, as
 * the Skills page says it: web lib/tabs.ts namedProduct), `{level}` "…". */
export function appLabel(key: AppMapKey, L: Locale): string {
  const row = APP_MAP_LABELS[key]
  const text = row?.[L] ?? row?.en ?? key
  const product = key === 'skills.catalog.title' && PRODUCT_NAMED_AFTER_AI ? appLabelRaw('rooms.aiName', L) : PRODUCT.displayName
  return text.replaceAll('{product}', product).replaceAll('{level}', '…')
}
const appLabelRaw = (key: string, L: Locale) => APP_MAP_LABELS[key]?.[L] ?? APP_MAP_LABELS[key]?.en ?? key

/** The section's text. */
export function appMapSection(o: AppMapInput, L: Locale): string {
  // labels in the person's words, a path joined by " › " (no quotes: the labels stand out in an English line)
  const q = (...keys: AppMapKey[]) => keys.map((k) => appLabel(k, L)).join(' › ')
  const set = (k: AppMapKey) => q('settings.title', k)
  const allowed = set(PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi')
  const lines = [
    '## Where things are in the app',
    'Asked where or how to do something in the app, or if it can, answer from this map with its labels. Not here: say you are not sure; do not guess that it does not exist.',
    `- Chat title menu: ${q('chat.rename')}. Chat list: ${q('navFolders.new')}, ${q('navFolders.moveTo')}. Answer: ${q('chat.regenerate')}; own message: ${q('chat.edit')}.`,
    `- ${tr('cardAlways', L)} on a card: that kind is not asked again; see or undo in ${allowed}.`,
    `- Room ⋯ › ${q('roomApps.menuAdd')}: Google Forms, GitHub, Sentry or any service with a ${q('roomApps.address')} posts into the room (list: ${q('roomApps.listTitle')}); group chat and 1:1 people add them, team rooms owners and admins.`,
    `- Room bell or ⋯ › ${q('rooms.menu.notify')}: ${q('rooms.notify.all')} / ${q('rooms.notify.mentions')} / ${q('rooms.notify.off')}. Defaults, ${q('notifications.quiet')}: ${set('notifications.title')}.`,
    `- ${set('settings.apps')}: phone, Mac and Windows apps. ${set('settings.about')}: version.`,
    `- ${set('aiApps.title')}: team files from Claude or another AI app on their computer.`,
    `- ${set('settings.profile')}: their AI and model, if the team lets them choose.`,
    `- ${q('sidebar.skills')} › ${q('skills.tabSkills')}; ready-made: ${q('skills.catalog.title')} (owners, admins add); ${q('skills.catalog.bring')} (computer): own Claude Code or Codex skills, a member's reviewed by skill managers.`,
    `- Desktop app only: ${q('sidebar.files')} › ${ownFolderLabel(L)} › ${q('files.findWork.entryButton')} (Documents, Desktop, Downloads; adds only what they tick).`,
  ]
  if (o.view === 'member') {
    lines.push(`- Owner or admin, in ${q('admin.title')}: people, guests, handover, usage and limits, activity log, team settings (time zone, voice input), plugins, team AI, system (storage, updates, backups, team address).${o.devEnv ? '' : ' No dev environment (AI running programs) on this install.'}`)
    return lines.join('\n')
  }
  lines.push(
    `Pages of ${q('admin.title')}${o.view === 'shared' ? ' (owners and admins only)' : ''} (say ${q('admin.title')} › page):`,
    `- ${q('admin.members')}: invites, roles; owner: ${q('handover.menu')} on a person's ⋯; ${q('guest.admin.title')}.`,
    o.managed
      ? `- Guest AI (${q('guest.invite.ai')}, at invite or on their row): ${q('guest.ai.none')} / ${q('guest.ai.own')} / ${q('guest.ai.team')} with a monthly limit.`
      : '- Guest AI: none on this install (it runs on this computer\'s own sign-in).',
    `- ${q('admin.usage')}: who used how much. ${q('admin.audit')}: who did what (deleted a file, changed a setting).`,
    `- ${q('admin.settings')}: ${q('teamSettings.section.general')} (${q('teamSettings.timeZone')}, the zone in your Now line), ${q('budgets.title')} (per person, group, team), ${q('speech.title')}, ${q('teamSettings.group.engine')} (team AI and model, who may pick)${o.devEnv ? `, ${q('devEnv.title')} (AI running programs)` : ''}.`,
    ...(o.devEnv ? [] : ['- No dev environment (AI running programs) on this install; only some Linux servers have it.']),
    `- ${q('admin.plugins')}: Hangul (HWP) writing, add-ons. ${q('admin.providers')}: team AI accounts.`,
    `- ${q('admin.system')}: ${q('storage.title')}, ${q('system.updates')}; owner also ${q('system.backups')}, ${q('system.export')}, ${q('system.connection')} (${q('system.address')} for use from outside).`,
  )
  return lines.join('\n')
}
