// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx, pages/Settings.tsx), in groups
// that the dialog's list separates with a hairline. "Browser" (the in-app browser's site setting) is
// there only inside a desktop app that offers it: the value lives in the desktop app, so a normal browser or the PWA
// has nothing to show, and /settings/browser there opens the profile instead. "AI connections" is there while the team
// lets members add their own (or one is still there). "MCP" (the AI using other services with the person's own
// accounts) is always there: it also lists the team connections they may use.
import { Bell, Brain, Cable, Download, Globe, Info, KeyRound, Laptop, Plug, User } from 'lucide-react'
import type { MessageKey } from '../i18n'

export interface SettingsTab {
  id: string
  label: MessageKey
  icon: typeof User
  /** you and this device · what the AI knows and uses · notices, apps and about */
  group: 1 | 2 | 3
}

const TABS: SettingsTab[] = [
  { id: 'profile', label: 'settings.profile', icon: User, group: 1 },
  { id: 'security', label: 'settings.security', icon: Laptop, group: 1 },
  { id: 'browser', label: 'settings.browser', icon: Globe, group: 1 },
  { id: 'memory', label: 'settings.memory', icon: Brain, group: 2 },
  { id: 'credentials', label: 'settings.credentials', icon: KeyRound, group: 2 },
  { id: 'drive', label: 'drive.title', icon: Download, group: 2 },
  { id: 'integrations', label: 'integrations.title', icon: Cable, group: 2 },
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
