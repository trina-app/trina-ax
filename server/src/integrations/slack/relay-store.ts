// The Slack channel relay's rows (migration 704, relay.ts): read by the rooms' own readers without the connector, so
// this module needs nothing but the database (rooms/store.ts imports it).
import type { Database } from 'bun:sqlite'
import { SlackAuthor, type RoomMessage, type SlackRelayState } from '@mycel/shared/api'

export interface RelayLinkRow {
  id: string; room_id: string; app_id: string; team_id: string; channel_id: string; channel_name: string; private: number; ext_shared: number
  state: SlackRelayState; created_by: string | null; created_at: string; updated_at: string; last_ts: string | null; checked_at: string | null
  gap_noted_at: string | null
}
export interface RelayMessageRow { channel_id: string; ts: string; room_message_id: string; thread_ts: string | null; direction: 'in' | 'out'; created_at: string }

export const linkOfRoom = (db: Database, roomId: string) => db.query('SELECT * FROM slack_relay_links WHERE room_id = ?').get(roomId) as RelayLinkRow | null
export const linkOfChannel = (db: Database, channelId: string) => db.query('SELECT * FROM slack_relay_links WHERE channel_id = ?').get(channelId) as RelayLinkRow | null
export const linkOfApp = (db: Database, appId: string) => db.query('SELECT * FROM slack_relay_links WHERE app_id = ?').get(appId) as RelayLinkRow | null

/** What a relayed message keeps of its Slack sender in room_messages.app_card (next to the card): `user` the Slack
 * user (U…/W…) or bot (B…), `avatar` the Slack picture's own address (served through slackRelayAvatar only). */
export interface StoredSlack { name: string; user?: string; avatar?: string; external?: true; bot?: true; ts: string; channel: string; permalink?: string; threadElsewhere?: true; files?: string[] }

export function storedSlackOf(appCard: string | null | undefined): StoredSlack | null {
  if (!appCard || !appCard.includes('"slack"')) return null
  try {
    const s = (JSON.parse(appCard) as { slack?: unknown }).slack as Record<string, unknown> | undefined
    if (!s || typeof s.name !== 'string' || typeof s.ts !== 'string' || typeof s.channel !== 'string') return null
    return s as unknown as StoredSlack
  } catch { return null }
}

/** RoomMessage.slackAuthor and .slackSent for these rows (one viewer, one page): the sender of a relayed message, and
 * for a person's message in a linked conversation whether it went to Slack. Bounded by the page: two lookups. */
export function slackFieldsOf(db: Database, rows: readonly { id: string; room_id: string; author_id: string | null; author_kind: string; event?: string | null; app_card?: string | null; deleted_at: string | null; created_at: string }[]): Map<string, Pick<RoomMessage, 'slackAuthor' | 'slackSent'>> {
  const out = new Map<string, Pick<RoomMessage, 'slackAuthor' | 'slackSent'>>()
  if (!rows.length) return out
  for (const r of rows) {
    const s = storedSlackOf(r.app_card)
    if (!s) continue
    const a = SlackAuthor.safeParse({
      name: s.name,
      ...(s.avatar && s.user ? { avatarUrl: `/api/rooms/${encodeURIComponent(r.room_id)}/slack/avatar/${encodeURIComponent(s.user)}` } : {}),
      ...(s.external ? { external: true } : {}), ...(s.bot ? { bot: true } : {}),
      ...(s.permalink ? { permalink: s.permalink } : {}), ...(s.threadElsewhere ? { threadElsewhere: true } : {}),
      ...(s.files?.length && !r.deleted_at ? { files: s.files.slice(0, 10) } : {}),
    })
    if (a.success) out.set(r.id, { slackAuthor: a.data })
  }
  // people's own messages in a linked conversation, sent since it was linked
  const rooms = [...new Set(rows.map((r) => r.room_id))]
  const links = new Map<string, RelayLinkRow>()
  for (const id of rooms) { const l = linkOfRoom(db, id); if (l) links.set(id, l) }
  if (!links.size) return out
  const people = rows.filter((r) => r.author_kind === 'user' && r.author_id && !r.event && !r.app_card && !r.deleted_at && links.has(r.room_id) && r.created_at >= links.get(r.room_id)!.created_at)
  if (!people.length) return out
  const ids = people.map((r) => r.id), marks = ids.map(() => '?').join(',')
  const sent = new Set((db.query(`SELECT room_message_id FROM slack_relay_messages WHERE direction = 'out' AND room_message_id IN (${marks})`).all(...ids) as { room_message_id: string }[]).map((x) => x.room_message_id))
  const box = new Map((db.query(`SELECT room_message_id, state FROM slack_relay_outbox WHERE room_message_id IN (${marks})`).all(...ids) as { room_message_id: string; state: 'pending' | 'failed' | 'not_relayed' }[]).map((x) => [x.room_message_id, x.state]))
  for (const r of people) {
    const st = sent.has(r.id) ? 'ok' : box.get(r.id)
    if (st) out.set(r.id, { slackSent: st })
  }
  return out
}

/** A guest may not be given a place in a conversation linked to Slack (owner decision 3: the admin's Connect speaks
 * for the customer, not for outsiders): the linked project room at or above `folderPath`, or null. */
export function relayLinkedProjectAt(db: Database, folderPath: string): RelayLinkRow | null {
  return db.query(`SELECT l.* FROM slack_relay_links l JOIN room_project_links p ON p.room_id = l.room_id AND p.mode = 'room' JOIN projects pr ON pr.id = p.project_id
    WHERE ? = pr.folder_path OR substr(?, 1, length(pr.folder_path) + 1) = pr.folder_path || '/' LIMIT 1`).get(folderPath, folderPath) as RelayLinkRow | null
}
