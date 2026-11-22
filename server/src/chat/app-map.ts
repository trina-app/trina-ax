// "Where things are in the app" (docs/decisions/20261116-ai-app-map.md): a short map of the app's screens in every
// turn's instructions, so that asked "where do I …" or "can I …" the AI names the real place instead of hedging ("if
// there is such a setting"), sending people to an admin, or saying a feature does not exist (AI scenario check, first
// run 2026-11-16, root cause #2).
//
// One line per place or group of places, at most 20 lines (docs/decisions/20261117-ai-app-map-five-places.md added
// Shared with me, folder sharing, threads under an answer, Open the app; meeting notes were removed 2026-11-19). The places are named by the
// labels the person's app shows, in their language: each label is a web i18n key (APP_MAP_KEYS), its words in app-map-labels.ts, generated from web/src/i18n by
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
// A free-roam demo (`freeRoam`, QA TC-5570) gets a map without the places the demo fences (demo/guard.ts) or hides (web
// lib/freeRoam.ts FREE_ROAM_HIDDEN_SETTINGS / FREE_ROAM_HIDDEN_PAGES): no Admin page, no Settings › Security, Apps, AI
// apps, Connectors or own AI and model, no room apps, no Open the app; one line says Admin is not in the demo.
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
  settings: { allowances: 'settings.allowances', notifications: 'notifications.title', apps: 'settings.apps', about: 'settings.about', 'ai-apps': 'aiApps.title', profile: 'settings.profile', security: 'settings.security', connectors: 'integrations.title' },
  admin: { members: 'admin.members', groups: 'admin.groups', connectors: 'admin.integrations', usage: 'admin.usage', audit: 'admin.audit', settings: 'admin.settings', plugins: 'admin.plugins', providers: 'admin.providers', system: 'admin.system' },
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
  /** this person may pick their own AI and model for new chats (admin/engine-choice.ts canChooseEngine; an owner or
   * admin always may); not known (a shared chat, whose map says nothing about the asker): "if allowed" */
  pickModel?: boolean
  /** a free-roam demo instance (app-config.ts isFreeRoam): the map names no page the demo fences or hides; absent: not one */
  freeRoam?: boolean
}

/** What the dev environment does, in everyday words: "server" and "programs" came back in answers to members (AI
 * scenario ADM-07.member, 2026-11-17). Not data work: totals, pivots and splits of big data files work everywhere
 * (query_data, QA TC-4913: "big data files" here made the AI refuse them where the dev environment is off). */
export const DEV_ENV_WORDS = 'the AI builds and runs its own tools for unusual jobs, e.g. a small app or a website; everyday work with big data files does not need it'

/** Which form a person's turn gets: a shared chat's role-neutral one, an owner's or admin's, a member's. */
export const appMapView = (role: string, shared: boolean): AppMapInput['view'] => shared ? 'shared' : role === 'owner' || role === 'admin' ? 'staff' : 'member'

/** One label in the person's language: `{product}` is the product's name (the AI's name for the ready-made skills, as
 * the Skills page says it: web lib/tabs.ts namedProduct), `{name}` the AI's name. */
export function appLabel(key: AppMapKey, L: Locale): string {
  const row = APP_MAP_LABELS[key]
  const text = row?.[L] ?? row?.en ?? key
  const product = key === 'skills.catalog.more' && PRODUCT_NAMED_AFTER_AI ? appLabelRaw('rooms.aiName', L) : PRODUCT.displayName
  // `{name}` is the AI's name, as the thread's button says it (web lib/tabs.ts aiName)
  const name = PRODUCT_NAMED_AFTER_AI ? appLabelRaw('rooms.aiName', L) : PRODUCT.shortName
  // a count after " · " ("트리나가 준비한 스킬 · {n}개 더", "연동 · {count}") is the screen's, not the place's name
  return text.split(' · ')[0]!.replaceAll('{product}', product).replaceAll('{name}', name)
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
    'Asked where or how in the app: answer from this map, with its labels; not here: say you are not sure, never that it does not exist, and never describe it as a feature.',
    // where a chat is shared (web HeaderShare in the chat's title row, chatMenuItems "Share"; lib/sharedChat.ts
    // shareKindOf): asked "how do I show this chat to Daniel?", the AI said it did not know where (AI scenario CHT-04.how)
    `- Chat title menu (its creator): ${q('chat.rename')}; top right ${q('projects.share')} (its starter): with people or groups, who then see it all and can ask (a team project's chat: with its members). A chat's ⋯ in the list: ${q('chat.pin')}, ${q('navFolders.moveTo')}; ${q('navFolders.new')}. Answer: ${q('chat.regenerate')}; own message: ${q('chat.edit')}.`,
    // a shared chat's own section (prompt.ts sharedSection, after this one) says how the AI reads the thread
    // (share-words.ts answerCommentsLine): there only the labels and who is told
    o.view === 'shared'
      // the AI reads a thread when asked (the shared chat section says how); there is no button that sends it
      ? `- Under a finished answer: ${q('rooms.replyInThread')}: people's talk, which you read when asked (shared chat section). Asker and repliers are told.`
      // the AI there reads a thread when someone asks (docs/decisions/20261117-ai-reads-answer-comments.md)
      : `- Shared chat (a project's or shared with people), under a finished answer: ${q('rooms.replyInThread')}: people's talk; the AI there reads it when someone asks. Asker and repliers are told; not in a private chat.`,
    `- ${tr('cardAlways', L)} on a card: not asked again; undo in ${set(PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi')}.`,
    // a free-roam demo fences adding room apps (demo/guard.ts ROOM_APPS)
    o.freeRoam
      ? `- Room ⋯: ${q('chat.pin')}. A group chat's also ${q('rooms.info.rename')}, ${q('rooms.info.addPeople')}; a team room: people follow its group, owners and admins rename.`
      : `- Room ⋯: ${q('chat.pin')}, ${q('roomApps.menuAdd')} (${q('roomApps.menuList')} once it has some): Google Forms or any service posts into the room by its ${q('roomApps.address')}. A group chat's also ${q('rooms.info.rename')}, ${q('rooms.info.addPeople')}; a team room: people follow its group, owners and admins rename.`,
    `- Room bell or ⋯ › ${q('rooms.menu.notify')}: ${q('rooms.notify.mentions')} / ${q('rooms.notify.off')}. ${q('notifications.quiet')}: ${set('notifications.title')}. Message hover: ${q('rooms.react')}. Mentions, thread replies: ${q('inbox.title')}.`,
    // the person's own AI and model only for someone who may pick one: a member read "if allowed" and told the asker
    // Profile might let them (CON-07.member, dev f394c9258 rerun 2026-11-17)
    // a free-roam demo hides Security, Apps, AI apps (FREE_ROAM_HIDDEN_SETTINGS), fences connecting services and the
    // engine and model (demo/guard.ts connect, usage)
    o.freeRoam
      ? `- ${q('settings.title')}: ${q('settings.profile')} (photo, name), ${q('settings.about')} (version). Own photo menu: ${q('status.set')}, ${q('presence.setAway')}.`
      : `- ${q('settings.title')}: ${q('settings.profile')} (photo, name${o.pickModel === undefined ? '; own AI and model, if allowed' : o.pickModel ? '; own AI and model for new chats' : ''}), ${q('settings.security')} (${q('auth.changePassword')}; ${q('settings.devices')}: sign one out), ${q('integrations.title')} (own Slack, Google…), ${q('settings.apps')} (phone, computer apps), ${q('settings.about')} (version), ${q('aiApps.title')} (team files from Claude or another AI app). Own photo menu: ${q('status.set')}, ${q('presence.setAway')}.`,
    `- ${q('projects.title')} › ${q('projects.new')}: anyone (the team may keep team projects to owners and admins). ${q('sidebar.skills')}: ${q('skills.catalog.more')} (ready-made; owners and admins see it while some are missing); ${q('skills.catalog.bring')} (on a computer; a member's are reviewed).`,
    // QA TC-7391: "several people can edit the PPT at once in Files" (web FilePanel.tsx edits plain text only)
    `- ${q('sidebar.files')}: a file opens to view and download (text files edit there; Word, Excel, PowerPoint and PDF are never edited in the app, nobody edits live together). ${q('sidebar.files')} › ${q('filesPanel.shared')}: files and folders shared with them, newest first. In ${ownFolderLabel(L)}, a folder's ⋯ › ${q('folderAccess.menu')}: view only, later files too; take people off or ${q('fileShare.stop')} anytime, ${q('common.undo')} right after; the team can turn members' sharing off. Team folders: owners and admins share.`,
    `- ${q('sidebar.files')} › ${ownFolderLabel(L)}, desktop app (not the Mac App Store one): ${q('files.findWork.entryButton')}; in a Mac or Windows browser ${q('openApp.lineLink')} › ${q('openApp.mac')} (or Windows) opens the desktop app signed in, no password (not opened: ${q('openApp.download')}, press again, a new one-time sign-in; not from a phone).`,
  ]
  if (o.freeRoam) {
    // the desktop app signs in through a one-time app sign-in, fenced in the demo (demo/guard.ts account: appSignIn)
    lines.pop()
    // every Admin page is fenced (demo/guard.ts admin): one line for every role, no page named
    lines.push(`- ${q('admin.title')} and every page in it are not in the demo: never send anyone there, whatever they ask about.`)
    return lines.join('\n')
  }
  if (o.view === 'member') {
    // situation.ts's member line already names folders, groups, connected apps, plugins, AI accounts and team settings
    lines.push(`- Also the owner's or an admin's, in ${q('admin.title')}: invites, roles (admins: the owner only), a forgotten password (they make a reset link), guests, handover, usage and limits, activity log, time zone, voice input, ${o.pickModel === false ? 'who may pick their own AI model, ' : ''}system (storage, updates, backups, team address), ${q('devEnv.title')} (${DEV_ENV_WORDS}${o.devEnv ? '' : `; not on ${here}, so nobody can turn it on`}).`)
    return lines.join('\n')
  }
  lines.push(
    `Pages of ${q('admin.title')}${o.view === 'shared' ? ' (owners and admins only)' : ''} (say ${q('admin.title')} › page):`,
    `- ${q('admin.members')}: ${q('members.inviteToTeam')} (or ${q('members.inviteMore')} › ${q('teamLink.title')}), roles (admins: owner only); a person's ⋯: ${q('members.resetLinkButton')} or ${q('members.reset')} (a forgotten password); owner: ${q('handover.menu')}; ${q('guest.admin.title')}. ${q('admin.groups')}.`,
    `- ${q('admin.integrations')}: the team's shared ones (Slack…); ${q('integrations.requests.add')}: one person links their own.`,
    // the choice is on screen on every install (web GuestInvite.tsx GuestAiChoices); where the AI runs on this computer's
    // own sign-in only No AI can be picked (noGuestAi, guest.ai.hostSignIn). "Not on this team's app" read as "no such
    // setting in Admin" (ADM-03, 2026-11-17)
    `- Guest AI (${q('guest.invite.ai')}, at invite or on their row in ${q('guest.admin.title')}): ` + (o.managed
      ? `${q('guest.ai.none')} / ${q('guest.ai.own')} / ${q('guest.ai.team')} with a monthly limit.`
      : `only ${q('guest.ai.none')} can be picked on ${here}.`),
    `- ${q('admin.usage')}: who used how much. ${q('admin.audit')}: who did what.`,
    `- ${q('admin.settings')}: ${q('teamSettings.section.general')} (${q('teamSettings.timeZone')}), ${q('budgets.title')}, ${q('speech.title')}, ${q('teamSettings.group.engine')} (team AI and model, who may pick)${o.devEnv ? `, ${q('devEnv.title')} (${DEV_ENV_WORDS})` : `; ${q('devEnv.title')} (${DEV_ENV_WORDS}): not on ${here}, it comes with how the app was installed`}.`,
    `- ${q('admin.plugins')}: Hangul (HWP) writing. ${q('admin.providers')}: team AI accounts.`,
    o.office
      ? `- ${q('admin.system')}: ${q('storage.title')}, ${q('system.updates')}; owner also ${q('system.backups')}, ${q('system.export')}, ${q('system.connection')} (${q('system.address')}).`
      : `- ${q('admin.system')}: ${q('storage.title')}; owner also ${q('system.updates')}, ${q('system.backups')}, ${q('system.export')}, ${q('system.connection')} (${q('system.address')}).`,
  )
  return lines.join('\n')
}
