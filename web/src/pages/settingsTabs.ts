// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx, pages/Settings.tsx), in named
// groups the dialog's list shows: Account (you and this device: profile, security, the in-app browser, your own usage,
// what the AI remembers about you, a ZIP of your own chats (export), what you allowed it in advance (트리나에게 허용한 것: room folders for new files,
// components/settings/AiAllowances.tsx); the whole team's usage is Admin › Usage) · Connections (Connectors: the AI
// using other services with your accounts, pages/Connectors.tsx, for everyone, its pages under it at
// /settings/connectors/<id>; AI providers: your own AI accounts, while the team lets members add their own or one is still
// there; AI apps: outside AI apps such as Claude using this server) · App (notices, the apps to install, about).
// The same groups as Admin's menu, which has no AI group either. Every section is just for you (Admin is the team's).
// "Browser" is there inside a desktop app that offers it (the AI has the browser only there, server/src/chat/turn.ts);
// on the web and phones only while the person's own "Allow all websites" for the AI's web reads is on, so it can be
// turned off again (Me.user.webAllowAll, while the team allows it: Me.team.webAllowAll). Old addresses: /settings/integrations
// and /connectors (Connectors), /settings/drive (Connectors › Google Drive), /settings/credentials (AI providers,
// /settings/providers), SettingsDialog.tsx and App.tsx. "Dev
// environment sites" (the sites the person allowed for her own dev-environment commands, and her Full internet switch)
// is there while the dev environment on srt is on for her.
import { Bell, Bot, Brain, Cable, Download, FileArchive, Gauge, Globe, Info, KeyRound, Laptop, Network, ShieldCheck, User } from 'lucide-react'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { FREE_ROAM_HIDDEN_SETTINGS } from '../lib/freeRoam'

export interface SettingsTab {
  id: string
  label: MessageKey
  /** more words the search box finds it by (what is inside it: "비밀번호" finds 보안·기기) */
  find: MessageKey
  icon: typeof User
  group: SettingsGroup
  /** other words the dialog's search finds it by (a product name inside the section) */
  keywords?: string[]
}

export const SETTINGS_GROUPS = ['account', 'connections', 'app'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

const TABS: SettingsTab[] = [
  { id: 'profile', label: 'settings.profile', find: 'settings.find.profile', icon: User, group: 'account' },
  { id: 'security', label: 'settings.security', find: 'settings.find.security', icon: Laptop, group: 'account' },
  { id: 'browser', label: 'settings.browser', find: 'settings.find.browser', icon: Globe, group: 'account' },
  { id: 'usage', label: 'settings.usage', find: 'settings.find.usage', icon: Gauge, group: 'account' },
  { id: 'memory', label: 'settings.memory', find: 'settings.find.memory', icon: Brain, group: 'account' },
  // a ZIP of the person's own AI chats (components/settings/MyExport.tsx; QA AP-038)
  { id: 'export', label: 'settings.export', find: 'settings.find.export', icon: FileArchive, group: 'account' },
  // named after the AI where the product is (트리나에게 허용한 것), else "AI에게 허용한 것"
  { id: 'allowances', label: PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi', find: 'settings.find.allowances', icon: ShieldCheck, group: 'account' },
  // the person's own connections (Google Drive, Gmail, Slack, MCP services): everyone's, with its pages under it
  { id: 'connectors', label: 'integrations.title', find: 'settings.find.services', icon: Cable, group: 'connections', keywords: ['Google', 'Drive', 'Gmail', 'Slack', 'Notion', 'MCP'] },
  { id: 'providers', label: 'settings.providers', find: 'settings.find.credentials', icon: KeyRound, group: 'connections', keywords: ['Claude', 'Codex', 'ChatGPT', 'AI'] },
  { id: 'ai-apps', label: 'aiApps.title', find: 'settings.find.connectors', icon: Bot, group: 'connections', keywords: ['MCP', 'Claude', 'Claude Code'] },
  { id: 'dev-env-sites', label: 'settings.devEnvSites', find: 'settings.find.devEnvSites', icon: Network, group: 'connections' },
  { id: 'notifications', label: 'notifications.title', find: 'settings.find.notifications', icon: Bell, group: 'app' },
  { id: 'apps', label: 'settings.apps', find: 'settings.find.apps', icon: Download, group: 'app' },
  { id: 'about', label: 'settings.about', find: 'settings.find.about', icon: Info, group: 'app' },
]

/** The tabs to show: "browser" when browserTabShown says so, none of a free-roam demo's hidden ones (lib/freeRoam.ts:
 * which AI account answers, its usage, the AI apps' page, the dev environment),
 * "providers" only when the member may have their own AI accounts (or still has one), "dev-env-sites" only when the dev
 * environment on srt is on for the person (GET /api/dev-env/sites state is not 'off'). */
export function settingsTabs(withBrowser: boolean, withCredentials = false, withDevEnvSites = false, guest = false, guestAiOff = false, freeRoam = false): SettingsTab[] {
  return TABS.filter((x) => (x.id !== 'browser' || withBrowser) && (x.id !== 'providers' || withCredentials) && (x.id !== 'dev-env-sites' || withDevEnvSites) && !(guest && GUEST_HIDDEN.has(x.id)) && !(guestAiOff && GUEST_AI_OFF_HIDDEN.has(x.id)) && !(freeRoam && FREE_ROAM_HIDDEN_SETTINGS.has(x.id)))
}

/** A guest's Settings (lib/guests.ts): only their own account, AI sign-in and the app. What the team shares with its
 * members (connected apps, AI apps, the AI's allowances, the browser, the dev environment) and the AI's memory are not
 * theirs: the server refuses those to a guest (server/src/auth/guest-endpoints.ts has no memories and no own export). With their AI off
 * (`guestAiOff`) also the AI's usage and AI accounts: nothing to see or sign in to (their own sign-in keeps AI accounts). */
const GUEST_HIDDEN = new Set(['browser', 'allowances', 'connectors', 'ai-apps', 'dev-env-sites', 'memory', 'export'])
const GUEST_AI_OFF_HIDDEN = new Set(['usage', 'providers'])

/** Is there a Browser section: inside a desktop app that offers its site setting (the app's own browser); on a computer
 * for "Your Chrome" (`chromeHere`: the AI's browser in the person's own Chrome, components/settings/ChromeLink.tsx);
 * elsewhere only while the person's "Allow all websites" for the AI's web reads is on (Me.user.webAllowAll) and the team
 * allows it (Me.team.webAllowAll), so the choice can be turned off where it was turned on (an address card). */
export const browserTabShown = (desktopBridge: boolean, teamWebAllowAll: boolean | undefined, ownWebAllowAll?: boolean, chromeHere = false) =>
  desktopBridge || chromeHere || (teamWebAllowAll === true && ownWebAllowAll === true)

/** "Your Chrome" in Settings › Browser: on a computer (a desktop browser or the desktop app), never a phone (the phone
 * app or a phone-wide window) and never a free-roam demo (lib/freeRoam.ts). A guest has no Browser section at all. */
export const chromeLinkHere = (o: { phone: boolean; phoneApp: boolean; freeRoam: boolean }) => !o.phone && !o.phoneApp && !o.freeRoam

/** Whether the search box finds a section: by its name or by the words of what is inside it ("비밀번호" finds 보안·기기).
 * `q` is the search text, trimmed and in lower case. */
export const sectionMatches = (tab: SettingsTab, q: string, t: (key: MessageKey) => string) => !q || `${t(tab.label)} ${t(tab.find)} ${(tab.keywords ?? []).join(' ')}`.toLowerCase().includes(q)

/** Where the person's own connections are, in words, for every text that sends them there: "Settings › Connectors"
 * ("설정 › 커넥터"). */
export const connectorsPlace = (t: (key: MessageKey) => string) => `${t('settings.title')} › ${t('integrations.title')}`

/** The name of a Settings address for the phone's ‹ label (lib/backStack.ts): "Settings" for the list, the section's
 * own name for a section, "Activity" for the 나 tab's Activity page (pages/Activity.tsx, whose gear opens 알림); null
 * for anything else. */
export function settingsPageName(path: string, t: (key: MessageKey) => string): string | null {
  if (path === '/settings') return t('settings.title')
  if (path === '/activity') return t('inbox.title')
  if (!path.startsWith('/settings/')) return null
  const tab = TABS.find((x) => x.id === path.slice('/settings/'.length).split('/')[0])
  return tab ? t(tab.label) : null
}
