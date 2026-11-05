// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx, pages/Settings.tsx), in groups
// ("Usage" is the person's own usage, components/settings/MyUsage.tsx; the whole team's is Admin > Usage),
// that the dialog's list separates with a hairline. "Browser" (the in-app browser's site setting) is
// there only inside a desktop app that offers it: the value lives in the desktop app, so a normal browser or the PWA
// has nothing to show, and /settings/browser there opens the profile instead. "AI connections" is there while the team
// lets members add their own (or one is still there). "MCP" (the AI using other services with the person's own
// accounts) is always there: it also lists the team connections they may use, and Google Drive (once a section of its
// own: /settings/drive opens it there, components/settings/SettingsDialog.tsx).
import { Bell, Brain, Cable, Download, Gauge, Globe, Info, KeyRound, Laptop, Plug, User } from 'lucide-react'
import type { MessageKey } from '../i18n'

export interface SettingsTab {
  id: string
  label: MessageKey
  icon: typeof User
  /** you and this device · what the AI knows and uses · notices, apps and about */
  group: 1 | 2 | 3
  /** other words the dialog's search finds it by (a product name inside the section) */
  keywords?: string[]
}

const TABS: SettingsTab[] = [
  { id: 'profile', label: 'settings.profile', icon: User, group: 1 },
  { id: 'security', label: 'settings.security', icon: Laptop, group: 1 },
  { id: 'browser', label: 'settings.browser', icon: Globe, group: 1 },
  { id: 'usage', label: 'settings.usage', icon: Gauge, group: 1 },
  { id: 'memory', label: 'settings.memory', icon: Brain, group: 2 },
  { id: 'credentials', label: 'settings.credentials', icon: KeyRound, group: 2 },
  { id: 'integrations', label: 'integrations.title', icon: Cable, group: 2, keywords: ['Google Drive'] },
  { id: 'connectors', label: 'connectors.title', icon: Plug, group: 2 },
  { id: 'notifications', label: 'notifications.title', icon: Bell, group: 3 },
  { id: 'apps', label: 'settings.apps', icon: Download, group: 3 },
  { id: 'about', label: 'settings.about', icon: Info, group: 3 },
]

/** The tabs to show: "browser" only when the desktop app offers Settings > Browser (lib/desktop.ts browserSettingsBridge),
 * "credentials" only when the member may have their own AI connections. */
export function settingsTabs(withBrowser: boolean, withCredentials = false): SettingsTab[] {
  return TABS.filter((x) => (x.id !== 'browser' || withBrowser) && (x.id !== 'credentials' || withCredentials))
}
