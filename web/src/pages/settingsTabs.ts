// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx, pages/Settings.tsx), in named
// groups the dialog's list shows: Account (you and this device: profile, security, the in-app browser, your own usage,
// what the AI remembers about you, what you allowed it in advance (트리나에게 허용한 것: room folders for new files,
// components/settings/AiAllowances.tsx); the whole team's usage is Admin › Usage) · Connections (Providers: your own AI
// accounts, while the team lets members add their own or one is still there; AI apps: outside AI apps such as Claude
// using this server). Connectors (the AI using other services with your accounts) is not here: it is its own item of
// the main sidebar (pages/Connectors.tsx) · App (notices, the apps to install, about).
// The same groups as Admin's menu, which has no AI group either. Every section is just for you (Admin is the team's).
// "Browser" is there inside a desktop app that offers it (the AI has the browser only there, server/src/chat/turn.ts);
// on the web and phones only while the person's own "Allow all websites" for the AI's web reads is on, so it can be
// turned off again (Me.user.webAllowAll, while the team allows it: Me.team.webAllowAll). Old addresses: /settings/connectors,
// /settings/integrations and /settings/drive (Connectors), /settings/credentials (Providers, /settings/providers), SettingsDialog.tsx. "Dev
// environment sites" (the sites the person allowed for her own dev-environment commands, and her Full internet switch)
// is there while the dev environment on srt is on for her.
import { Bell, Bot, Brain, Download, Gauge, Globe, Info, KeyRound, Laptop, Network, ShieldCheck, User } from 'lucide-react'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

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
  // named after the AI where the product is (트리나에게 허용한 것), else "AI에게 허용한 것"
  { id: 'allowances', label: PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi', find: 'settings.find.allowances', icon: ShieldCheck, group: 'account' },
  { id: 'providers', label: 'settings.providers', find: 'settings.find.credentials', icon: KeyRound, group: 'connections', keywords: ['Claude', 'Codex', 'ChatGPT', 'AI'] },
  { id: 'ai-apps', label: 'aiApps.title', find: 'settings.find.connectors', icon: Bot, group: 'connections', keywords: ['Claude', 'Claude Code'] },
  { id: 'dev-env-sites', label: 'settings.devEnvSites', find: 'settings.find.devEnvSites', icon: Network, group: 'connections' },
  { id: 'notifications', label: 'notifications.title', find: 'settings.find.notifications', icon: Bell, group: 'app' },
  { id: 'apps', label: 'settings.apps', find: 'settings.find.apps', icon: Download, group: 'app' },
  { id: 'about', label: 'settings.about', find: 'settings.find.about', icon: Info, group: 'app' },
]

/** The tabs to show: "browser" when browserTabShown says so,
 * "providers" only when the member may have their own AI accounts (or still has one), "dev-env-sites" only when the dev
 * environment on srt is on for the person (GET /api/dev-env/sites state is not 'off'). */
export function settingsTabs(withBrowser: boolean, withCredentials = false, withDevEnvSites = false): SettingsTab[] {
  return TABS.filter((x) => (x.id !== 'browser' || withBrowser) && (x.id !== 'providers' || withCredentials) && (x.id !== 'dev-env-sites' || withDevEnvSites))
}

/** Is there a Browser section: inside a desktop app that offers its site setting (the only client whose AI has the
 * browser); elsewhere only while the person's "Allow all websites" for the AI's web reads is on (Me.user.webAllowAll)
 * and the team allows it (Me.team.webAllowAll), so the choice can be turned off where it was turned on (an address card). */
export const browserTabShown = (desktopBridge: boolean, teamWebAllowAll: boolean | undefined, ownWebAllowAll?: boolean) =>
  desktopBridge || (teamWebAllowAll === true && ownWebAllowAll === true)

/** Whether the search box finds a section: by its name or by the words of what is inside it ("비밀번호" finds 보안·기기).
 * `q` is the search text, trimmed and in lower case. */
export const sectionMatches = (tab: SettingsTab, q: string, t: (key: MessageKey) => string) => !q || `${t(tab.label)} ${t(tab.find)} ${(tab.keywords ?? []).join(' ')}`.toLowerCase().includes(q)

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
