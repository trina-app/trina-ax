// The tabs of the personal settings screen (pages/Settings.tsx). "Browser" (the in-app browser's site setting) is
// there only inside a desktop app that offers it: the value lives in the desktop app, so a normal browser or the PWA
// has nothing to show, and /settings/browser there opens the profile instead. "AI connections" is there while the team
// lets members add their own (or one is still there).
import { Bell, Brain, CalendarClock, Download, Globe, Info, KeyRound, Laptop, Plug, User } from 'lucide-react'
import type { MessageKey } from '../i18n'

export interface SettingsTab {
  id: string
  label: MessageKey
  icon: typeof User
}

const TABS: SettingsTab[] = [
  { id: 'profile', label: 'settings.profile', icon: User },
  { id: 'security', label: 'settings.security', icon: Laptop },
  { id: 'browser', label: 'settings.browser', icon: Globe },
  { id: 'memory', label: 'settings.memory', icon: Brain },
  { id: 'credentials', label: 'settings.credentials', icon: KeyRound },
  { id: 'drive', label: 'drive.title', icon: Download },
  { id: 'connectors', label: 'connectors.title', icon: Plug },
  { id: 'schedules', label: 'settings.schedules', icon: CalendarClock },
  { id: 'notifications', label: 'notifications.title', icon: Bell },
  { id: 'apps', label: 'settings.apps', icon: Download },
  { id: 'about', label: 'settings.about', icon: Info },
]

/** The tabs to show: "browser" only when the desktop app offers Settings > Browser (lib/desktop.ts browserSettingsBridge),
 * "credentials" only when the member may have their own AI connections. */
export function settingsTabs(withBrowser: boolean, withCredentials = false): SettingsTab[] {
  return TABS.filter((x) => (x.id !== 'browser' || withBrowser) && (x.id !== 'credentials' || withCredentials))
}
