// System on a phone (below 768 px; QA TC-269, ADM-14): a list of the page's parts, each its own page at
// /admin/system/<group> under "‹ System", like Team settings (teamSettingsGroups.ts), so a phone never scrolls the
// whole 2,500 px page. Computers and tablets keep the one page; there /admin/system/<group> opens the page. The groups
// are the page's sections in the page's order: the plan shares the storage page (its disk is the storage's size).
// Pure: no React, so AdminLayout's routing and the unit tests can use it.
import { Archive, CircleArrowUp, Download, FolderSync, Globe, HardDrive, HeartPulse } from 'lucide-react'
import type { MessageKey } from '../../i18n'

export type SystemGroupId = 'storage' | 'updates' | 'health' | 'connection' | 'connected' | 'backups' | 'export'

export interface SystemGroup {
  id: SystemGroupId
  label: MessageKey
  icon: typeof HardDrive
  /** the owner's only (an admin sees the plan, the storage and, in office mode, the automatic updates) */
  owner?: boolean
  /** only where the server offers it (Me.server.features; absent from older servers = offered) */
  feature?: 'connectedFolders'
  /** an admin's only in office mode, which the page learns when it loads (System.tsx sends them to the list else) */
  office?: boolean
}

export const SYSTEM_GROUPS: SystemGroup[] = [
  { id: 'storage', label: 'storage.title', icon: HardDrive },
  { id: 'updates', label: 'system.updates', icon: CircleArrowUp, office: true },
  { id: 'health', label: 'system.health', icon: HeartPulse, owner: true },
  { id: 'connection', label: 'system.connection', icon: Globe, owner: true },
  { id: 'connected', label: 'connected.title', icon: FolderSync, owner: true, feature: 'connectedFolders' },
  { id: 'backups', label: 'system.backups', icon: Archive, owner: true },
  { id: 'export', label: 'system.export', icon: Download, owner: true },
]

type Features = Partial<Record<'connectedFolders', boolean>> | undefined

/** The groups this person has on this server; `office`: the automatic updates are this server's (an admin's updates). */
export const systemGroups = (o: { owner: boolean; features: Features; office?: boolean }) =>
  SYSTEM_GROUPS.filter((g) => (!g.owner || o.owner) && (!g.feature || o.features?.[g.feature] !== false) && (o.owner || !g.office || o.office !== false))

export const systemGroup = (id: string | undefined, o: { owner: boolean; features: Features; office?: boolean }) =>
  id ? systemGroups(o).find((g) => g.id === id) : undefined

/** Where /admin/system/<group> goes instead, or null: a computer's page is the one page; a group this person or server
 * does not have, the list. */
export function systemRedirect(o: { sub: string | undefined; phone: boolean; owner: boolean; features: Features }): string | null {
  if (!o.sub) return null
  if (!o.phone || !systemGroup(o.sub, o)) return '/admin/system'
  return null
}
