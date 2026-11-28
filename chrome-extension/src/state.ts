// What the worker knows about its link and what the popup shows. The link (token included) lives only in
// chrome.storage.local (never sync); the rest is memory of this worker's life.
import { PRODUCT } from '../../shared/src/product'

export interface LinkInfo {
  /** the team's origin (https://team.example.com) */
  origin: string
  token: string
  linkId: string
  user: { name: string; username: string }
  team: { name: string }
  /** what the person called this browser profile ("Work mail"): the redeem label */
  label?: string
  /** every host name of the team: never opened or sent to from a driven tab */
  teamHosts: string[]
}

const KEY = 'link'

export async function loadLink(): Promise<LinkInfo | null> {
  const v = (await chrome.storage.local.get(KEY))[KEY]
  if (!v || typeof v !== 'object' || typeof v.origin !== 'string' || typeof v.token !== 'string') return null
  return v as LinkInfo
}

export async function saveLink(l: LinkInfo): Promise<void> {
  await chrome.storage.local.set({ [KEY]: l })
}

export async function forgetLink(): Promise<void> {
  await chrome.storage.local.remove(KEY)
}

export const live = {
  link: null as LinkInfo | null,
  /** the socket is open and the server said hello */
  online: false,
  /** browser calls running now */
  running: 0,
  /** server clock minus this computer's (a call's deadline is server time) */
  clockOffset: 0,
  /** the person pressed Stop (popup line until the next call) */
  stoppedAt: 0,
}

/** The icon's badge: "AI" while it works, "!" when linked but offline, nothing otherwise. */
export function refreshBadge(): void {
  const text = live.running > 0 ? 'AI' : live.link && !live.online ? '!' : ''
  void chrome.action.setBadgeText({ text }).catch(() => {})
  if (text) void chrome.action.setBadgeBackgroundColor({ color: live.running > 0 ? '#D93025' : '#80868B' }).catch(() => {})
  void chrome.action.setTitle({ title: PRODUCT.displayName }).catch(() => {})
}
