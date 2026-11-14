// Message links in the web app (docs/DECISIONS.md "Message links and their previews"): which addresses are links to a
// message of this team (a chip and a card, drawn from what the server gave this viewer: RoomMessage.linkPreviews), where
// they open in the app, how a place reads in a chip, and the address "Copy link" gives. Pure: test/unit/message-links.test.ts.
import { parseMessageLink, type MessageLinkRef, type RoomLinkPreview } from '@mycel/shared/api'
import { teamAddressHost } from './team-address'
import { messageLink } from './fileMenu'

/** The hosts whose message links are this team's: this page's own, and the team address (GET /api/me team.address: a
 * link copied in the desktop app on the office network names the team address, not this page's LAN address). */
export function linkHosts(pageHost: string | null | undefined, teamAddress: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (pageHost) out.add(pageHost.toLowerCase())
  const team = teamAddressHost(teamAddress)
  if (team) out.add(team.toLowerCase())
  return out
}

/** `href` as a link to a message of this team, or null (another site, an old relay name, a look-alike host: an ordinary
 * link, as before). A path ("/rooms/…": the renderer makes this page's own addresses paths) is on `origin`. */
export function ownMessageLink(href: string, hosts: ReadonlySet<string>, origin?: string): MessageLinkRef | null {
  const l = parseMessageLink(origin && href.startsWith('/') && !href.startsWith('//') ? origin + href : href)
  return l && hosts.has(l.host) ? l : null
}

/** Where a message link opens inside the app: the room at the message, a reply in its thread (pages/Room.tsx ?m=). */
export const messagePath = (l: Pick<MessageLinkRef, 'roomId' | 'messageId' | 'rootId'>): string => messageLink(l.roomId, l.messageId, l.rootId, '')

/** "Copy link": the message's address on the team address when there is one (others can open it), else this page's. */
export function copyLinkOf(roomId: string, messageId: string, rootId: string | null | undefined, teamAddress: string | null | undefined, pageOrigin: string): string {
  const host = teamAddressHost(teamAddress)
  const origin = host ? new URL(teamAddress!).origin : pageOrigin
  return messageLink(roomId, messageId, rootId, origin)
}

/** How a preview's place reads, before "Thread in …": a team room or the everyone room as "#name"; a DM or a group chat as
 * the viewer names it (live) or by its kind only (a snapshot: who is in it is not shown). */
export function placeLabel(p: Pick<RoomLinkPreview, 'place' | 'sharedBy'>, o: { title: (place: RoomLinkPreview['place']) => string; dm: string; group: string }): string {
  const snapshot = p.sharedBy !== undefined
  if (p.place.kind === 'team' || p.place.kind === 'all') return `#${o.title(p.place)}`
  if (snapshot) return p.place.kind === 'dm' ? o.dm : o.group
  return o.title(p.place)
}
