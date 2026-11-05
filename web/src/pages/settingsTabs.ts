// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx, pages/Settings.tsx), in named
// groups the dialog's list shows: Account (you and this device: profile, security, the in-app browser, your own usage;
// the whole team's usage is Admin › Usage) · AI (your own AI providers, while the team lets members add their own or one
// is still there; memory) · Connections (MCP: the AI using other services with your accounts, and the team connections
// you may use; App connectors: apps the AI here uses with your account, Google Drive for now; AI apps: outside AI apps
// such as Claude using this server) · App (notices, the apps to install, about). Every section is just for you
// (Admin is the team's). "Browser" is there only inside a desktop app that offers it. Old addresses: /settings/drive
// (App connectors) and /settings/credentials (AI providers, now /settings/providers), SettingsDialog.tsx.
import { Bell, Bot, Brain, Cable, Download, Gauge, Globe, Info, KeyRound, Laptop, Plug, User } from 'lucide-react'
import type { MessageKey } from '../i18n'

export interface SettingsTab {
  id: string
  label: MessageKey
  icon: typeof User
  group: SettingsGroup
  /** other words the dialog's search finds it by (a product name inside the section) */
  keywords?: string[]
}

export const SETTINGS_GROUPS = ['account', 'ai', 'connections', 'app'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

const TABS: SettingsTab[] = [
  { id: 'profile', label: 'settings.profile', icon: User, group: 'account' },
  { id: 'security', label: 'settings.security', icon: Laptop, group: 'account' },
  { id: 'browser', label: 'settings.browser', icon: Globe, group: 'account' },
  { id: 'usage', label: 'settings.usage', icon: Gauge, group: 'account' },
  { id: 'providers', label: 'settings.providers', icon: KeyRound, group: 'ai', keywords: ['Claude', 'Codex', 'ChatGPT'] },
  { id: 'memory', label: 'settings.memory', icon: Brain, group: 'ai' },
  { id: 'integrations', label: 'integrations.title', icon: Cable, group: 'connections' },
  { id: 'connectors', label: 'connectors.title', icon: Plug, group: 'connections', keywords: ['Google Drive'] },
  { id: 'ai-apps', label: 'aiApps.title', icon: Bot, group: 'connections', keywords: ['Claude', 'Claude Code'] },
  { id: 'notifications', label: 'notifications.title', icon: Bell, group: 'app' },
  { id: 'apps', label: 'settings.apps', icon: Download, group: 'app' },
  { id: 'about', label: 'settings.about', icon: Info, group: 'app' },
]

/** The tabs to show: "browser" only when the desktop app offers Settings > Browser (lib/desktop.ts browserSettingsBridge),
 * "providers" only when the member may have their own AI accounts (or still has one). */
export function settingsTabs(withBrowser: boolean, withCredentials = false): SettingsTab[] {
  return TABS.filter((x) => (x.id !== 'browser' || withBrowser) && (x.id !== 'providers' || withCredentials))
}
