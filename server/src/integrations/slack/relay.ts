// The Slack channel relay (docs/SLACK.md "Channel relay", plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md,
// docs/decisions/20261127-slack-channel-relay.md): one Slack channel and one team conversation or project, both ways.
//
//   connect     a team owner or admin who is in the conversation, has their own Slack account linked and is in the
//               channel, with the app in it too (users.conversations / conversations.info with the bot token), in a team
//               conversation or a project without guests. One sentence says who will see; Connect is the admin's
//               explicit authorization for the customer (owner decision 3: everyone in the conversation sees it, with or
//               without Slack, no per-member check, no pausing). The link is a room app (preset 'slack') and a row of
//               slack_relay_links; an event line says who connected it. The hosting service is told the linked channels
//               (relay/channels: it verifies each with this install's own bot and forwards only those).
//   in          a linked channel's message (message.channels / message.groups, the subtypes message_changed,
//               message_deleted, file_share, thread_broadcast, other apps' bot_message) becomes the Slack app's message
//               in the conversation with the sender's Slack name and picture (slackAuthor), never as a team member.
//               Slack threads are threads; a Slack @mention of a linked person is a mention here. Our own bot's posts
//               and every (channel, ts) seen before are dropped, so nothing echoes. Every other channel's message is
//               dropped before anything is kept.
//   out         a person's own message in a linked conversation goes to the channel (chat.postMessage, as
//               "Name (Trina)" with chat:write.customize, else as the app with "Name:" first), its thread, edits and
//               deletes too, 1 a second per channel. Never sent: a message that carries an AI answer, files (the text
//               goes), event lines, other apps' messages. A message that came from Slack is never sent back.
//   states      the app removed from the channel, the channel archived, shared with another organization, the post
//               refused: an event line and the link's state (a refused post's not_in_channel / is_archived decide as
//               much as an event: private channels' own events are RTM only). conversations.info rechecks every link
//               at start and every 6 hours.
//   catch-up    after a gap (start, the connection back, the hosting service's queue let go of envelopes): one
//               conversations.history per linked channel from the last relayed ts (15 messages for the official app
//               while it is not listed); more than that: "Some Slack messages may be missing" once.
// Slack's text is outside data: kept and shown as plain text (rooms/apps/card.ts), never Markdown with live links. The
// AI reads it as someone else's words (rooms/reader.ts).
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import {
  SLACK_RELAY_DAILY_CAP, SLACK_RELAY_TEXT_MAX, type Locale, type SlackLineWhat, type SlackRelayChannels, type SlackRelayLink, type SlackRelayStatus,
} from '@mycel/shared/api'
import { SLACK_BROKER_RELAY_BOT_SCOPES, SLACK_BROKER_RELAY_MAX_CHANNELS, SLACK_BROKER_RELAY_RECHECK_MS } from '@mycel/shared/cloud-protocol'
import { newId, nowIso } from '../../db'
import { audit } from '../../admin/audit'
import { fail, HttpError } from '../../http/errors'
import { roomsOf } from '../../rooms/service'
import { isOwnerOrAdmin, messageRow, roomAuditRef, threadable, type MessageRow, type RoomRow } from '../../rooms/store'
import { isProjectRoom, NOT_HELD_SQL, systemLine } from '../../rooms/project-room'
import { roomAppsOf, teamDay, type AppRow } from '../../rooms/apps/service'
import { lines, relayBodyOf, safeLink } from '../../rooms/apps/card'
import { SlackApiError } from './api'
import { linkOfApp, linkOfChannel, linkOfRoom, storedSlackOf, type RelayLinkRow, type StoredSlack } from './relay-store'
import type { SlackConnector } from './service'

const CHANNEL = /^[CG][A-Z0-9]{2,40}$/
const USER = /^[UWB][A-Z0-9]{2,40}$/
const TS = /^\d{1,12}\.\d{1,9}$/
const PEOPLE_MS = 10 * 60_000
const CHANNELS_MS = 60_000
/** the subtypes a linked channel's message may have (contract SLACK_BROKER_RELAY_SUBTYPES); anything else is dropped */
const KEPT_SUBTYPES = new Set(['message_changed', 'message_deleted', 'file_share', 'thread_broadcast', 'bot_message', 'me_message'])
const CHANNEL_EVENTS = new Set(['channel_left', 'group_left', 'channel_deleted', 'group_deleted', 'channel_archive', 'group_archive', 'channel_rename', 'group_rename', 'channel_shared', 'channel_unshared', 'channel_id_changed'])
/** where a relayed sender's picture may be fetched from (Slack's own image hosts) */
const AVATAR_HOSTS = new Set(['avatars.slack-edge.com', 'a.slack-edge.com', 'ca.slack-edge.com', 'secure.gravatar.com'])
const AVATAR_MAX = 256 * 1024
/** what Slack's post answers mean for the link */
const GONE_CODES = new Set(['not_in_channel', 'channel_not_found'])
const ARCHIVED_CODES = new Set(['is_archived'])

type Msg = Record<string, unknown>
const str = (v: unknown, re?: RegExp): string | null => (typeof v === 'string' && (!re || re.test(v)) ? v : null)
const plainObj = (v: unknown): Msg | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Msg : null)
const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80) || null : null)

interface Person { name: string; avatar?: string; team: string | null; bot?: boolean }
interface Draft { link: RelayLinkRow; ts: string; threadTs: string | null; user: string | null; name: string; avatar?: string; external: boolean; bot: boolean; text: string; mentions: string[]; files: string[]; broadcast: boolean }

export class SlackRelay {
  private people = new Map<string, { p: Person; at: number }>()
  private chains = new Map<string, Promise<void>>()
  private lastSent = new Map<string, number>()
  private avatars = new Map<string, { bytes: Uint8Array; type: string; at: number }>()
  private channelLists = new Map<string, { at: number; items: SlackRelayChannels['items'] }>()
  private capNoted = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  /** tests: the gap between two posts to one channel (Slack: 1 a second) */
  postGapMs = 1100
  /** tests: the wait between two history reads for the official app while unlisted (Slack: 1 a minute) */
  historyGapMs = 61_000

  constructor(readonly slack: SlackConnector) {
    const rooms = roomsOf(slack.ctx)
    rooms.slackOut = {
      sent: (row, answer) => this.sent(row, answer),
      edited: (row) => this.edited(row),
      removed: (row) => this.removed(row),
    }
    roomAppsOf(slack.ctx).slackHooks = {
      removing: (userId, room) => this.unlink(userId, room),
      view: (row) => { const l = linkOfApp(this.db, row.id); return l ? { channelId: l.channel_id, channelName: l.channel_name, state: l.state, extShared: !!l.ext_shared } : undefined },
    }
  }

  private get db() { return this.slack.ctx.db }
  private get log() { return this.slack.log }
  private now() { return this.slack.now() }

  /** Started with the connector (refresh): the links rechecked, the hosting service told, a catch-up. */
  start() {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => { void this.recheck(); void this.syncBroker() }, SLACK_BROKER_RELAY_RECHECK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
    this.slack.ctx.onClose(() => this.stop())
    // posts that were on their way when the server stopped: sent now (in order)
    for (const r of this.db.query("SELECT o.room_message_id, o.link_id, l.channel_id FROM slack_relay_outbox o JOIN slack_relay_links l ON l.id = o.link_id WHERE o.state = 'pending' ORDER BY o.created_at").all() as { room_message_id: string; link_id: string; channel_id: string }[]) {
      void this.serial(`out:${r.channel_id}`, () => this.post(r.link_id, r.room_message_id))
    }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.started = false }

  private links(): RelayLinkRow[] {
    const cfg = this.slack.config()
    if (!cfg?.team_id) return []
    return this.db.query("SELECT l.* FROM slack_relay_links l JOIN rooms r ON r.id = l.room_id WHERE r.archived_at IS NULL AND l.team_id = ? ORDER BY l.created_at").all(cfg.team_id) as RelayLinkRow[]
  }
  private active(l: RelayLinkRow | null): l is RelayLinkRow {
    const cfg = this.slack.config()
    if (!l || l.state !== 'active' || !cfg || !this.slack.available(cfg) || l.team_id !== cfg.team_id) return false
    // an archived conversation, or a project's room while the project is in the trash: nothing comes or goes
    return !!this.db.query(`SELECT 1 FROM rooms r WHERE r.id = ? AND r.archived_at IS NULL AND ${NOT_HELD_SQL('r')}`).get(l.room_id)
  }

  /** The bot can post as "Name (Trina)" (chat:write.customize, as Slack last listed the bot token's scopes). */
  customName(): boolean {
    const have = (this.slack.config()?.bot_scopes ?? '').split(',')
    return SLACK_BROKER_RELAY_BOT_SCOPES.every((s) => have.includes(s))
  }

  // ---------------------------------------------------------------- the dialog
  private roomOf(userId: string, roomId: string): RoomRow { return roomsOf(this.slack.ctx).mine(userId, roomId).room }
  private kindOk(room: RoomRow): boolean { return room.kind === 'team' || (room.kind === 'group' && isProjectRoom(this.db, room.id)) }
  private hasGuest(roomId: string): boolean { return !!this.db.query('SELECT 1 FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND u.guest = 1 LIMIT 1').get(roomId) }
  private blocked(userId: string, room: RoomRow): SlackRelayStatus['blocked'] {
    const cfg = this.slack.config()
    if (!isOwnerOrAdmin(this.db, userId)) return 'not_manager'
    if (!cfg || !this.slack.available(cfg)) return 'not_added'
    if (!this.kindOk(room)) return 'room_kind'
    if (this.hasGuest(room.id)) return 'guests'
    return undefined
  }

  linkOut(l: RelayLinkRow): SlackRelayLink {
    const by = l.created_by ? this.db.query('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(l.created_by) as { id: string; name: string } | null : null
    return {
      appId: l.app_id, channelId: l.channel_id, channelName: l.channel_name, private: !!l.private, extShared: !!l.ext_shared, state: l.state,
      createdBy: by ? { id: by.id, name: by.name } : null, createdAt: l.created_at, customName: this.customName(),
    }
  }

  status(userId: string, roomId: string): SlackRelayStatus {
    const room = this.roomOf(userId, roomId)
    const cfg = this.slack.config()
    if (cfg?.team_id) this.dropDeadLinks()
    const link = linkOfRoom(this.db, room.id)
    const blocked = this.blocked(userId, room)
    const mine = this.slack.mine(userId)
    const admin = isOwnerOrAdmin(this.db, userId)
    return {
      link: link && cfg?.team_id === link.team_id ? this.linkOut(link) : null,
      ...(blocked ? { blocked } : {}),
      meLinked: !!this.slack.linkOf(userId, cfg),
      signIn: mine.signIn,
      botName: cfg?.bot_name ?? null,
      needsReAdd: admin && cfg?.mode === 'official' && !!cfg.bot_scopes && !this.customName(),
    }
  }

  private mayConnect(userId: string, roomId: string): RoomRow {
    const room = this.roomOf(userId, roomId)
    const b = this.blocked(userId, room)
    if (b === 'not_manager') fail('forbidden')
    if (b === 'not_added') fail('conflict', 'Slack is not added to the team.', { params: { reason: 'slack_off' } })
    if (b === 'room_kind') fail('conflict', 'Only a team conversation or a project can be connected to Slack.', { params: { reason: 'room_kind' } })
    if (b === 'guests') fail('conflict', "Conversations with guests can't be linked yet.", { params: { reason: 'guests' } })
    return room
  }

  private mySlackUser(userId: string): string {
    const l = this.slack.linkOf(userId)
    if (!l) fail('conflict', 'Sign in with Slack first.', { params: { reason: 'slack_not_linked' } })
    return l!.slack_user_id
  }

  private bot(): string {
    const b = this.slack.botToken()
    if (!b) fail('conflict', 'Slack is not added to the team.', { params: { reason: 'slack_off' } })
    return b!
  }

  /** The channels (public and private) the bot is in, from users.conversations with the bot token, and those the person
   * is in (users.conversations with user=): both, by id. */
  private async channelsOf(bot: string, user: string | null): Promise<Map<string, { name: string; private: boolean; extShared: boolean }>> {
    const out = new Map<string, { name: string; private: boolean; extShared: boolean }>()
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const r = await this.slack.api.call('users.conversations', bot, { ...(user ? { user } : {}), types: 'public_channel,private_channel', exclude_archived: true, limit: 999, ...(cursor ? { cursor } : {}) })
      for (const c of Array.isArray(r.channels) ? r.channels as Msg[] : []) {
        const id = str(c.id, CHANNEL)
        if (id) out.set(id, { name: cleanName(c.name) ?? id, private: c.is_private === true, extShared: c.is_ext_shared === true })
      }
      const next = str(plainObj(r.response_metadata)?.next_cursor)
      if (!next) break
      cursor = next
    }
    return out
  }

  async channels(userId: string, roomId: string): Promise<SlackRelayChannels> {
    this.mayConnect(userId, roomId)
    const me = this.mySlackUser(userId), bot = this.bot()
    const hit = this.channelLists.get(userId)
    if (hit && hit.at > this.now() - CHANNELS_MS) return { items: hit.items }
    try {
      const [botIn, meIn] = await Promise.all([this.channelsOf(bot, null), this.channelsOf(bot, me)])
      const taken = new Set((this.db.query('SELECT channel_id FROM slack_relay_links').all() as { channel_id: string }[]).map((r) => r.channel_id))
      const items = [...botIn].filter(([id]) => meIn.has(id)).map(([id, c]) => ({ id, name: c.name, private: c.private, extShared: c.extShared, taken: taken.has(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)
      this.channelLists.set(userId, { at: this.now(), items })
      return { items }
    } catch (e) { this.slack.tokenRefused(e, bot); return fail('unavailable', 'Slack did not answer. Try again in a moment.', { params: { reason: 'slack_unreachable' } }) }
  }

  async connect(userId: string, roomId: string, channelId: string, locale: Locale): Promise<SlackRelayStatus> {
    const room = this.mayConnect(userId, roomId)
    const me = this.mySlackUser(userId), bot = this.bot()
    if (linkOfRoom(this.db, room.id)) fail('conflict', 'This conversation is already connected to a Slack channel.', { params: { reason: 'linked' } })
    this.dropDeadLinks()
    if (linkOfChannel(this.db, channelId)) fail('conflict', 'That Slack channel is already connected to another conversation.', { params: { reason: 'linked' } })
    const cfg = this.slack.config()!
    // the app in the channel (conversations.info is_member: a private channel it is not in is not found), and the
    // person too: nobody pipes in a channel they cannot see
    let info: Msg
    try { info = plainObj((await this.slack.api.call('conversations.info', bot, { channel: channelId })).channel) ?? {} } catch (e) {
      this.slack.tokenRefused(e, bot)
      if (e instanceof SlackApiError && e.code === 'channel_not_found') fail('conflict', 'Invite the app to the channel first.', { params: { reason: 'bot_not_in_channel' } })
      return fail('unavailable', 'Slack did not answer. Try again in a moment.', { params: { reason: 'slack_unreachable' } })
    }
    if (info.is_member !== true) fail('conflict', 'Invite the app to the channel first.', { params: { reason: 'bot_not_in_channel' } })
    if (info.is_archived === true || info.is_im === true || info.is_mpim === true) fail('conflict', 'That channel cannot be connected.', { params: { reason: 'bot_not_in_channel' } })
    let mine: Map<string, unknown>
    try { mine = await this.channelsOf(bot, me) } catch { return fail('unavailable', 'Slack did not answer. Try again in a moment.', { params: { reason: 'slack_unreachable' } }) }
    if (!mine.has(channelId)) fail('conflict', 'You are not in that Slack channel.', { params: { reason: 'not_in_channel' } })
    const name = cleanName(info.name) ?? channelId
    const ext = info.is_ext_shared === true
    // the hosting service (official app) forwards only the channels its bot is in: told first, refused when it does
    // not take this one (it was built before the relay, or the bot is not in it there)
    if (cfg.mode === 'official') {
      const want = [...this.links().map((l) => l.channel_id), channelId].slice(0, SLACK_BROKER_RELAY_MAX_CHANNELS)
      try {
        const a = await this.slack.broker!.relayChannels(want)
        if (!a.channels.includes(channelId)) fail('conflict', 'Invite the app to the channel first.', { params: { reason: 'bot_not_in_channel' } })
      } catch (e) {
        if (e instanceof HttpError) throw e
        return fail('unavailable', 'The hosting service did not answer. Try again in a moment.', { params: { reason: 'broker_unreachable' } })
      }
    }
    const now = nowIso(), linkId = newId()
    const apps = roomAppsOf(this.slack.ctx)
    let line = ''
    this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM slack_relay_links WHERE room_id = ? OR channel_id = ?').get(room.id, channelId)) fail('conflict', 'Already connected.', { params: { reason: 'linked' } })
      const appId = newId()
      // a room app with no address (preset slack: refused at /in/, by an older build too)
      const token = crypto.randomBytes(32).toString('base64url')
      const sealed = apps.sealToken(appId, token)
      this.db.query(`INSERT INTO room_apps (id, room_id, kind, preset, name, token_hash, token_enc, secret_enc, key_version, events, created_by, created_at, updated_at)
        VALUES (?, ?, 'other', 'slack', 'Slack', ?, ?, NULL, ?, '{"message":true}', ?, ?, ?)`).run(appId, room.id, sealed.token_hash, sealed.token_enc, sealed.key_version, userId, now, now)
      this.db.query(`INSERT INTO slack_relay_links (id, room_id, app_id, team_id, channel_id, channel_name, private, ext_shared, state, created_by, created_at, updated_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(linkId, room.id, appId, cfg.team_id, channelId, name, info.is_private === true ? 1 : 0, ext ? 1 : 0, userId, now, now, now)
      line = systemLine(this.db, room.id, { type: 'slack', what: 'connected', channel: name }, now, userId)
      audit(this.db, { actor: userId, action: 'slack.relay_linked', target: linkId, detail: { ...roomAuditRef(room), channel: channelId, private: info.is_private === true, extShared: ext } })
    })()
    this.channelLists.clear()
    this.announce(room.id, line)
    // from now on: the newest message is where a catch-up starts
    this.db.query('UPDATE slack_relay_links SET last_ts = ? WHERE id = ? AND last_ts IS NULL').run((this.now() / 1000).toFixed(6), linkId)
    void locale
    return this.status(userId, roomId)
  }

  /** Links whose conversation was archived (a project deleted for good) or of another workspace than the one added now
   * free their channel and room (audited slack.relay_ended). */
  dropDeadLinks() {
    const cfg = this.slack.config()
    const dead = this.db.query('SELECT l.* FROM slack_relay_links l JOIN rooms r ON r.id = l.room_id WHERE r.archived_at IS NOT NULL OR (? IS NOT NULL AND l.team_id <> ?)').all(cfg?.team_id ?? null, cfg?.team_id ?? null) as RelayLinkRow[]
    for (const l of dead) {
      this.db.transaction(() => {
        this.db.query('DELETE FROM slack_relay_links WHERE id = ?').run(l.id)
        this.db.query('DELETE FROM room_apps WHERE id = ?').run(l.app_id)
        audit(this.db, { actor: null, action: 'slack.relay_ended', target: l.id, detail: { reason: l.team_id !== cfg?.team_id ? 'workspace_changed' : 'room_archived', channel: l.channel_id } })
      })()
    }
    if (dead.length) void this.syncBroker()
  }

  /** Disconnect (also Remove on its app in Apps posting here): the line, the audit, the hosting service told. */
  disconnect(userId: string, roomId: string) {
    const room = this.roomOf(userId, roomId)
    if (!isOwnerOrAdmin(this.db, userId)) fail('forbidden')
    const l = linkOfRoom(this.db, room.id)
    if (!l) return
    this.unlink(userId, room)
  }

  private unlink(userId: string, room: RoomRow) {
    if (!isOwnerOrAdmin(this.db, userId)) fail('forbidden')
    const l = linkOfRoom(this.db, room.id)
    if (!l) return
    const now = nowIso()
    let line = ''
    this.db.transaction(() => {
      this.db.query('DELETE FROM slack_relay_outbox WHERE link_id = ?').run(l.id)
      this.db.query('DELETE FROM slack_relay_links WHERE id = ?').run(l.id)
      this.db.query('DELETE FROM room_apps WHERE id = ?').run(l.app_id)
      line = systemLine(this.db, room.id, { type: 'slack', what: 'disconnected', channel: l.channel_name }, now, userId)
      audit(this.db, { actor: userId, action: 'slack.relay_unlinked', target: l.id, detail: { ...roomAuditRef(room), channel: l.channel_id } })
    })()
    this.channelLists.clear()
    this.announce(room.id, line)
    void this.syncBroker()
  }

  private announce(roomId: string, line: string) {
    const rooms = roomsOf(this.slack.ctx)
    const m = messageRow(this.db, roomId, line)
    if (m) rooms.messageEvent('room.message', m)
    rooms.roomEvent(roomId, 'updated')
  }

  /** A server line in the linked conversation, and its state. */
  private setState(l: RelayLinkRow, state: RelayLinkRow['state'] | null, what: SlackLineWhat, reason: string) {
    const now = nowIso()
    let line = ''
    this.db.transaction(() => {
      if (state) this.db.query('UPDATE slack_relay_links SET state = ?, updated_at = ? WHERE id = ?').run(state, now, l.id)
      line = systemLine(this.db, l.room_id, { type: 'slack', what, channel: l.channel_name }, now, null)
      if (state && state !== 'active') audit(this.db, { actor: null, action: 'slack.relay_ended', target: l.id, detail: { reason, channel: l.channel_id } })
    })()
    this.announce(l.room_id, line)
  }

  /** Slack was removed from the team (the app removed in Slack, its token refused, Admin › Remove): one line in each
   * linked conversation; the links stay (the same workspace when it is added again). */
  teamRemoved() {
    for (const l of this.links()) if (l.state === 'active') this.setState(l, null, 'team_removed', 'team_removed')
  }

  // ---------------------------------------------------------------- the hosting service and rechecks
  /** The official app: the hosting service gets the linked channels (it forwards only those its bot is in). Those it
   * refuses: the app is not in the channel there. */
  async syncBroker(): Promise<void> {
    const cfg = this.slack.config()
    if (cfg?.mode !== 'official' || !this.slack.broker || !this.slack.available(cfg)) return
    const links = this.links().filter((l) => l.state !== 'archived')
    try {
      const a = await this.slack.broker.relayChannels(links.map((l) => l.channel_id).slice(0, SLACK_BROKER_RELAY_MAX_CHANNELS))
      for (const l of links) {
        if (a.notMember.includes(l.channel_id) && l.state === 'active') this.setState(l, 'bot_removed', 'bot_removed', 'not_member')
        else if (a.channels.includes(l.channel_id) && l.state === 'bot_removed') this.setState(l, 'active', 'back', 'back')
      }
    } catch (e) { this.log.info('slack relay channels not sent to the hosting service', { reason: (e as { code?: string })?.code ?? 'unknown' }) }
  }

  /** Each link checked with Slack (conversations.info): the app still in the channel, not archived, its name. */
  async recheck(): Promise<void> {
    const bot = this.slack.botToken()
    if (!bot) return
    this.dropDeadLinks()
    for (const l of this.links()) {
      if (l.state === 'archived') continue
      try {
        const c = plainObj((await this.slack.api.call('conversations.info', bot, { channel: l.channel_id }, { noWait: true })).channel) ?? {}
        const name = cleanName(c.name)
        if (name && name !== l.channel_name) this.db.query('UPDATE slack_relay_links SET channel_name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), l.id)
        this.db.query('UPDATE slack_relay_links SET checked_at = ?, ext_shared = ? WHERE id = ?').run(nowIso(), c.is_ext_shared === true ? 1 : 0, l.id)
        const fresh = linkOfRoom(this.db, l.room_id)!
        if (c.is_archived === true) this.setState(fresh, 'archived', 'archived', 'archived')
        else if (c.is_member !== true && fresh.state === 'active') this.setState(fresh, 'bot_removed', 'bot_removed', 'not_member')
        else if (c.is_member === true && fresh.state === 'bot_removed') this.setState(fresh, 'active', 'back', 'back')
      } catch (e) {
        this.slack.tokenRefused(e, bot)
        if (e instanceof SlackApiError && GONE_CODES.has(e.code) && l.state === 'active') this.setState(l, 'bot_removed', 'bot_removed', e.code)
      }
    }
  }

  // ---------------------------------------------------------------- in: Slack → the conversation
  /** Is this events_api event the relay's (a linked channel's message or channel event)? Then the relay takes it
   * (whatever the outer team_id says: in a Slack Connect channel it names whichever install Slack picked) and the
   * mention / DM rules do not apply to it. */
  takes(ev: Msg): boolean {
    const type = str(ev.type)
    if (type === 'message') {
      if (ev.channel_type === 'im' || ev.channel_type === 'mpim') return false
      const ch = str(ev.channel, CHANNEL)
      return !!ch && !!linkOfChannel(this.db, ch)
    }
    if (type && CHANNEL_EVENTS.has(type)) return !!this.channelOfEvent(ev)
    return false
  }

  private channelOfEvent(ev: Msg): RelayLinkRow | null {
    const c = str(ev.channel, CHANNEL) ?? str(plainObj(ev.channel)?.id, CHANNEL) ?? str(ev.old_channel_id, CHANNEL)
    return c ? linkOfChannel(this.db, c) : null
  }

  /** One linked channel's event, in order per channel (one poll answer's events run side by side). */
  onEvent(ev: Msg, appId: string): Promise<void> {
    const l = ev.type === 'message' ? linkOfChannel(this.db, str(ev.channel) ?? '') : this.channelOfEvent(ev)
    if (!l) return Promise.resolve()
    return this.serial(`in:${l.channel_id}`, () => this.handle(ev, appId))
  }

  private serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn).catch((e) => this.log.warn('slack relay step failed', { err: e instanceof Error ? e.name : 'unknown', reason: e instanceof SlackApiError ? e.code : undefined }))
    this.chains.set(key, next)
    void next.then(() => { if (this.chains.get(key) === next) this.chains.delete(key) })
    return next
  }

  /** Our own bot's post (never relayed back). Live check 2026-11-27 (test workspace): a post made with `username`
   * comes back as subtype bot_message with `bot_id` and `app_id` and NO `user`, `bot_profile` or `team`; a plain post
   * has `user` (the bot user) and `bot_profile`. So: the bot user, our bot id (auth.test's bot_id), or our app with a
   * bot_profile of this workspace. The team's own app is ours alone: its app id is enough. Another Trina team's install
   * of the official app has the same app id but another bot id, and is relayed as an outside app. */
  private ownBot(m: Msg, appId: string): boolean {
    const cfg = this.slack.config()
    if (!cfg) return true
    if (m.user && m.user === cfg.bot_user_id) return true
    if (this.botId && m.bot_id === this.botId) return true
    if (cfg.mode === 'own' && m.app_id === appId) return true
    const bp = plainObj(m.bot_profile)
    if (bp && bp.app_id === appId && (bp.team_id === cfg.team_id || bp.user_id === cfg.bot_user_id)) return true
    // our app's post whose bot id is not known yet (auth.test did not answer): its ts decides (recorded at the post)
    return !this.botId && m.app_id === appId && !!str(m.ts) && !!this.db.query("SELECT 1 FROM slack_relay_messages WHERE channel_id = ? AND ts = ? AND direction = 'out'").get(str(m.channel) ?? '', str(m.ts))
  }
  /** our bot's id (B…), from auth.test */
  private botId: string | null = null
  private async learnBotId() {
    const bot = this.slack.botToken()
    if (!bot || this.botId) return
    try { const r = await this.slack.api.call('auth.test', bot); this.botId = str(r.bot_id, /^B[A-Z0-9]{2,40}$/) } catch { /* asked again at the next post */ }
  }

  private async handle(ev: Msg, appId: string): Promise<void> {
    const type = str(ev.type)!
    await this.learnBotId()
    if (type !== 'message') return this.channelEvent(type, ev)
    const l = linkOfChannel(this.db, str(ev.channel)!)
    if (!this.active(l)) return
    const sub = str(ev.subtype)
    if (sub && !KEPT_SUBTYPES.has(sub)) return
    if (sub === 'message_deleted') return this.deletedInSlack(l, str(ev.deleted_ts, TS))
    if (sub === 'message_changed') {
      const m = plainObj(ev.message)
      const prev = plainObj(ev.previous_message)
      if (!m || this.ownBot({ ...m, channel: ev.channel }, appId) || (prev && this.ownBot({ ...prev, channel: ev.channel }, appId))) return
      return this.changedInSlack(l, m)
    }
    if (this.ownBot(ev, appId)) return
    await this.relayIn(l, ev)
  }

  private async channelEvent(type: string, ev: Msg) {
    const l = this.channelOfEvent(ev)
    if (!l) return
    // the app left, or the channel was archived: confirmed with our own bot (conversations.info), since in a Slack
    // Connect channel another install's bot leaving reaches us too
    if (type === 'channel_left' || type === 'group_left' || type === 'channel_archive' || type === 'group_archive' || type === 'channel_deleted' || type === 'group_deleted') {
      await this.confirmState(l, type)
      void this.syncBroker()
      return
    }
    if (type === 'channel_rename' || type === 'group_rename') {
      const name = cleanName(plainObj(ev.channel)?.name)
      if (name) { this.db.query('UPDATE slack_relay_links SET channel_name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), l.id); roomsOf(this.slack.ctx).roomEvent(l.room_id, 'updated') }
      return
    }
    if (type === 'channel_shared') { this.db.query('UPDATE slack_relay_links SET ext_shared = 1, updated_at = ? WHERE id = ?').run(nowIso(), l.id); this.setState(linkOfRoom(this.db, l.room_id)!, null, 'shared', 'shared'); return }
    if (type === 'channel_unshared') { this.db.query('UPDATE slack_relay_links SET ext_shared = 0, updated_at = ? WHERE id = ?').run(nowIso(), l.id); return }
    if (type === 'channel_id_changed') {
      const to = str(ev.new_channel_id, CHANNEL)
      if (to && !linkOfChannel(this.db, to)) { this.db.query('UPDATE slack_relay_links SET channel_id = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), l.id); void this.syncBroker() }
    }
  }

  private async confirmState(l: RelayLinkRow, reason: string) {
    const bot = this.slack.botToken()
    if (!bot) return
    let c: Msg
    try { c = plainObj((await this.slack.api.call('conversations.info', bot, { channel: l.channel_id }, { noWait: true })).channel) ?? {} } catch (e) {
      this.slack.tokenRefused(e, bot)
      if (e instanceof SlackApiError && GONE_CODES.has(e.code)) c = { is_member: false }
      else return
    }
    const fresh = linkOfRoom(this.db, l.room_id)
    if (!fresh || fresh.id !== l.id) return
    if (c.is_archived === true) { if (fresh.state !== 'archived') this.setState(fresh, 'archived', 'archived', reason) }
    else if (c.is_member !== true && fresh.state === 'active') this.setState(fresh, 'bot_removed', 'bot_removed', reason)
  }

  /** A Slack user's (or app's) name and picture: the event's own profile, else users.info (10 minutes in memory). */
  private async person(user: string, ev: Msg): Promise<Person> {
    const hit = this.people.get(user)
    if (hit && hit.at > this.now() - PEOPLE_MS) return hit.p
    const up = plainObj(ev.user_profile)
    let p: Person | null = null
    if (up) {
      const name = cleanName(up.display_name) ?? cleanName(up.real_name) ?? cleanName(up.name)
      if (name) p = { name, ...(str(up.image_72) ? { avatar: str(up.image_72)! } : {}), team: str(up.team) ?? str(ev.user_team) }
    }
    const bot = this.slack.botToken()
    if (!p && bot) {
      try {
        const u = plainObj((await this.slack.api.call('users.info', bot, { user })).user)
        const prof = plainObj(u?.profile)
        const name = cleanName(prof?.display_name) ?? cleanName(prof?.real_name) ?? cleanName(u?.real_name) ?? cleanName(u?.name)
        if (name) p = { name, ...(str(prof?.image_72) ? { avatar: str(prof?.image_72)! } : {}), team: str(u?.team_id), ...(u?.is_bot === true ? { bot: true } : {}) }
      } catch (e) { this.slack.tokenRefused(e, bot) }
    }
    p ??= { name: 'Slack', team: str(ev.user_team) }
    if (this.people.size > 2000) this.people.clear()
    this.people.set(user, { p, at: this.now() })
    return p
  }

  /** Slack's message text as plain text: mentions by name (a linked person's is a mention here), channels by name,
   * links as "label (address)", Slack's escapes undone. @channel / @here stay words (never everyone here). */
  private async plainText(text: string, ev: Msg): Promise<{ text: string; mentions: string[] }> {
    const cfg = this.slack.config()
    const mentions = new Set<string>()
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]{2,40})(?:\|[^>]*)?>/g)].map((m) => m[1]!))].slice(0, 20)
    const names = new Map<string, string>()
    for (const id of ids) {
      const linked = cfg?.team_id ? this.db.query('SELECT u.id, u.name FROM slack_links l JOIN users u ON u.id = l.user_id AND u.deleted_at IS NULL AND u.guest = 0 WHERE l.team_id = ? AND l.slack_user_id = ?').get(cfg.team_id, id) as { id: string; name: string } | null : null
      if (linked) { mentions.add(linked.id); names.set(id, linked.name) } else names.set(id, (await this.person(id, ev)).name)
    }
    const out = text
      .replace(/<@([UW][A-Z0-9]{2,40})(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? 'someone'}`)
      .replace(/<#[CG][A-Z0-9]{2,40}\|([^>]*)>/g, (_m, n: string) => `#${n}`)
      .replace(/<#[CG][A-Z0-9]{2,40}>/g, '#channel')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, w: string) => `@${w}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, n?: string) => n ?? '@group')
      .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_m, f: string) => f)
      .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (_m, u: string, label: string) => (label === u ? u : `${label} (${u})`))
      .replace(/<(https?:\/\/[^|>\s]+|mailto:[^|>\s]+)>/g, (_m, u: string) => u)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    return { text: lines(out, SLACK_RELAY_TEXT_MAX), mentions: [...mentions] }
  }

  private permalink(channel: string, ts: string, threadTs?: string | null): string | undefined {
    const base = this.slack.config()?.team_url
    if (!base) return undefined
    const u = safeLink(`${base.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ''}`)
    return u?.url
  }

  private async draft(l: RelayLinkRow, m: Msg): Promise<Draft | null> {
    const ts = str(m.ts, TS)
    if (!ts) return null
    const cfg = this.slack.config()
    const user = str(m.user, USER)
    const botMsg = !user || m.subtype === 'bot_message' || !!m.bot_id
    let p: Person
    if (user && !botMsg) p = await this.person(user, m)
    else {
      const bp = plainObj(m.bot_profile)
      const icons = plainObj(bp?.icons) ?? plainObj(m.icons)
      p = { name: cleanName(m.username) ?? cleanName(bp?.name) ?? 'App', ...(str(icons?.image_72) ? { avatar: str(icons?.image_72)! } : {}), team: str(bp?.team_id), bot: true }
    }
    const files = (Array.isArray(m.files) ? m.files as Msg[] : []).map((f) => cleanName(f.name) ?? cleanName(f.title) ?? 'file').slice(0, 10)
    const raw = typeof m.text === 'string' ? m.text : ''
    const { text, mentions } = await this.plainText(raw, m)
    if (!text && !files.length) return null
    const threadTs = str(m.thread_ts, TS)
    return {
      link: l, ts, threadTs: threadTs && threadTs !== ts ? threadTs : null, user: user ?? str(m.bot_id), name: p.name, ...(p.avatar ? { avatar: p.avatar } : {}),
      external: !!p.team && !!cfg?.team_id && p.team !== cfg.team_id, bot: botMsg || !!p.bot, text: text || files.map((f) => `📎 ${f}`).join('\n'), mentions, files,
      broadcast: m.subtype === 'thread_broadcast',
    }
  }

  private storedOf(d: Draft): StoredSlack {
    return {
      name: d.name, ts: d.ts, channel: d.link.channel_id, ...(d.user ? { user: d.user } : {}), ...(d.avatar ? { avatar: d.avatar } : {}),
      ...(d.external ? { external: true as const } : {}), ...(d.bot ? { bot: true as const } : {}),
      ...(this.permalink(d.link.channel_id, d.ts, d.threadTs) ? { permalink: this.permalink(d.link.channel_id, d.ts, d.threadTs)! } : {}),
      ...(d.files.length ? { files: d.files } : {}),
    }
  }

  /** One Slack message into the conversation (once per (channel, ts)). */
  async relayIn(l: RelayLinkRow, m: Msg): Promise<boolean> {
    const ts = str(m.ts, TS)
    if (!ts || this.db.query('SELECT 1 FROM slack_relay_messages WHERE channel_id = ? AND ts = ?').get(l.channel_id, ts)) return false
    const d = await this.draft(l, m)
    if (!d) return false
    const apps = roomAppsOf(this.slack.ctx)
    const row = apps.row(l.app_id)
    if (!row) return false
    const { day } = teamDay(this.db, this.now())
    // its own cap (the room apps' 500 a day and the team's 5,000 do not apply: counted as `received`, which only the
    // /in/ address of an app reads, and a Slack link has none): past it, one line a day and nothing more today
    const n = (this.db.query('SELECT received n FROM room_app_days WHERE app_id = ? AND day = ?').get(row.id, day) as { n: number } | null)?.n ?? 0
    if (n >= SLACK_RELAY_DAILY_CAP) {
      if (this.capNoted.get(l.id) !== day) { this.capNoted.set(l.id, day); this.setState(l, null, 'capped', 'capped') }
      return false
    }
    // the thread: the Slack thread's first message relayed (or sent) here, else a normal message that says so
    let root: MessageRow | null = null
    let elsewhere = false
    if (d.threadTs) {
      const r = this.db.query('SELECT room_message_id FROM slack_relay_messages WHERE channel_id = ? AND ts = ?').get(l.channel_id, d.threadTs) as { room_message_id: string } | null
      const rm = r ? messageRow(this.db, l.room_id, r.room_message_id) : null
      if (rm && !rm.deleted_at && threadable(rm)) root = rm
      else elsewhere = true
    }
    const stored = { ...this.storedOf(d), ...(elsewhere ? { threadElsewhere: true as const } : {}) }
    const at = new Date(Math.min(this.now(), Math.floor(Number(d.ts) * 1000) || this.now())).toISOString()
    // the mentioned people who are in the conversation (a mention never brings anyone in)
    const inRoom = new Set((this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(l.room_id) as { user_id: string }[]).map((x) => x.user_id))
    let id = ''
    const ok = this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM slack_relay_messages WHERE channel_id = ? AND ts = ?').get(l.channel_id, d.ts)) return false
      apps.count(row as Pick<AppRow, 'id' | 'room_id' | 'kind'>, 'received', day)
      id = apps.insertRelayed(row, { name: d.name, text: d.text, slack: stored as unknown as Record<string, unknown>, link: stored.permalink, root, alsoInRoom: d.broadcast, mentions: d.mentions.filter((u) => inRoom.has(u)), at })
      this.db.query("INSERT INTO slack_relay_messages (channel_id, ts, room_message_id, thread_ts, direction, created_at) VALUES (?, ?, ?, ?, 'in', ?)").run(l.channel_id, d.ts, id, d.threadTs, nowIso())
      this.db.query('UPDATE slack_relay_links SET last_ts = ? WHERE id = ? AND (last_ts IS NULL OR CAST(last_ts AS REAL) < CAST(? AS REAL))').run(d.ts, l.id, d.ts)
      return true
    })()
    if (ok) apps.relayedOut(l.room_id, id, root)
    return ok
  }

  private async changedInSlack(l: RelayLinkRow, m: Msg) {
    const ts = str(m.ts, TS)
    if (!ts) return
    const r = this.db.query("SELECT room_message_id FROM slack_relay_messages WHERE channel_id = ? AND ts = ? AND direction = 'in'").get(l.channel_id, ts) as { room_message_id: string } | null
    if (!r) return
    const d = await this.draft(l, m)
    if (!d) return
    const prev = messageRow(this.db, l.room_id, r.room_message_id)
    const old = storedSlackOf(prev?.app_card)
    // Slack also sends message_changed when only a thread's reply count changed, or a broadcast gained its root (live
    // check 2026-11-27): the text is the same, nothing to change here
    if (!prev || prev.deleted_at || prev.body === relayBodyOf(d.name, d.text)) return
    const apps = roomAppsOf(this.slack.ctx)
    if (!apps.editRelayed(r.room_message_id, { name: d.name, text: d.text, slack: { ...this.storedOf(d), ...(old?.threadElsewhere ? { threadElsewhere: true } : {}) } as unknown as Record<string, unknown>, link: this.permalink(l.channel_id, ts, d.threadTs), at: nowIso(), mentions: d.mentions.filter((u) => !!this.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(l.room_id, u)) })) return
    const row = messageRow(this.db, l.room_id, r.room_message_id)
    if (row) roomsOf(this.slack.ctx).messageEvent('room.message.updated', row)
  }

  private deletedInSlack(l: RelayLinkRow, ts: string | null) {
    if (!ts) return
    const r = this.db.query("SELECT room_message_id FROM slack_relay_messages WHERE channel_id = ? AND ts = ? AND direction = 'in'").get(l.channel_id, ts) as { room_message_id: string } | null
    if (!r) return
    const now = nowIso()
    this.db.transaction(() => {
      this.db.query("UPDATE room_messages SET body = '', mentions = '[]', deleted_at = ?, app_card = json_object('title', '', 'details', json('[]'), 'app', json_extract(app_card, '$.app')) WHERE id = ? AND deleted_at IS NULL").run(now, r.room_message_id)
      this.db.query('DELETE FROM room_reactions WHERE message_id = ?').run(r.room_message_id)
      this.db.query('DELETE FROM room_notices WHERE source_id = ? AND room_id = ?').run(r.room_message_id, l.room_id)
    })()
    const rooms = roomsOf(this.slack.ctx)
    const row = messageRow(this.db, l.room_id, r.room_message_id)
    if (row) {
      rooms.messageEvent('room.message.updated', row)
      const root = row.thread_root_id ? messageRow(this.db, l.room_id, row.thread_root_id) : null
      if (root) rooms.afterReply(root)
    }
  }

  // ---------------------------------------------------------------- catch-up
  private catching = false
  /** After a gap: each active link's messages since the last relayed ts (conversations.history with the bot token; 15
   * for the official app while unlisted, Slack's limit). More than that: the "may be missing" line, once per gap. */
  async catchUp(reason: string): Promise<void> {
    const bot = this.slack.botToken()
    if (!bot || this.catching) return
    this.catching = true
    try {
      const limited = this.slack.readLimited()
      let first = true
      for (const l of this.links()) {
        if (!this.active(l) || !l.last_ts) continue
        if (limited && !first) await Bun.sleep(this.historyGapMs)
        first = false
        await this.serial(`in:${l.channel_id}`, async () => {
          const fresh = linkOfRoom(this.db, l.room_id)
          if (!this.active(fresh)) return
          let r
          try { r = await this.slack.api.call('conversations.history', bot, { channel: l.channel_id, oldest: fresh.last_ts!, inclusive: false, limit: limited ? 15 : 100 }, { noWait: true }) } catch (e) {
            this.slack.tokenRefused(e, bot)
            if (e instanceof SlackApiError && GONE_CODES.has(e.code)) this.setState(fresh, 'bot_removed', 'bot_removed', e.code)
            return
          }
          const msgs = (Array.isArray(r.messages) ? r.messages as Msg[] : []).filter((m) => str(m.ts, TS)).sort((a, b) => Number(a.ts) - Number(b.ts))
          const appId = this.slack.config()?.app_id ?? ''
          for (const m of msgs) {
            const sub = str(m.subtype)
            if ((sub && !KEPT_SUBTYPES.has(sub)) || sub === 'message_changed' || sub === 'message_deleted' || this.ownBot({ ...m, channel: l.channel_id }, appId)) continue
            await this.relayIn(fresh, m)
          }
          if (r.has_more === true) this.missing(fresh)
        })
      }
      this.log.info('slack relay caught up', { reason })
    } finally { this.catching = false }
  }

  /** "Some Slack messages may be missing. Open in Slack": at most once an hour per link. */
  missing(l: RelayLinkRow) {
    if (l.gap_noted_at && Date.parse(l.gap_noted_at) > this.now() - 3_600_000) return
    this.db.query('UPDATE slack_relay_links SET gap_noted_at = ? WHERE id = ?').run(nowIso(), l.id)
    this.setState(l, null, 'missing', 'missing')
  }

  /** The hosting service let go of envelopes: catch up. */
  dropped(n: number) { this.log.info('slack relay: the hosting service dropped events', { n }); void this.catchUp('dropped') }

  // ---------------------------------------------------------------- out: the conversation → Slack
  private sent(row: MessageRow, answer: boolean) {
    const l = linkOfRoom(this.db, row.room_id)
    if (!this.active(l) || row.author_kind !== 'user' || !row.author_id || row.event || row.app_card) return
    const files = (this.db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(row.id) as { n: number }).n
    // never sent: a message that carries an AI answer; a message with only files
    // (an AI app posting as the person through its connection carries what it read: AI-written, not relayed either)
    if ((this.db.query('SELECT source_scope FROM room_messages WHERE id = ?').get(row.id) as { source_scope: string | null } | null)?.source_scope) answer = true
    if (answer || (!row.body.trim() && files)) {
      this.db.query("INSERT OR REPLACE INTO slack_relay_outbox (room_message_id, link_id, state, reason, attempts, created_at) VALUES (?, ?, 'not_relayed', ?, 0, ?)").run(row.id, l.id, answer ? 'answer' : 'files', nowIso())
      this.changed(row)
      return
    }
    if (!row.body.trim()) return
    this.db.query("INSERT OR REPLACE INTO slack_relay_outbox (room_message_id, link_id, state, reason, attempts, created_at) VALUES (?, ?, 'pending', NULL, 0, ?)").run(row.id, l.id, nowIso())
    void this.serial(`out:${l.channel_id}`, () => this.post(l.id, row.id))
  }

  /** The message's slackSent changed: the room hears of it. */
  private changed(row: MessageRow) {
    const r = messageRow(this.db, row.room_id, row.id)
    if (r) roomsOf(this.slack.ctx).messageEvent('room.message.updated', r)
  }

  private async gap(channel: string) {
    const last = this.lastSent.get(channel) ?? 0
    const wait = last + this.postGapMs - this.now()
    if (wait > 0) await Bun.sleep(wait)
    this.lastSent.set(channel, this.now())
  }

  /** The text for Slack: Slack's escapes, a linked person's mention as <@U…>, never a channel-wide mention. */
  toSlack(row: Pick<MessageRow, 'body' | 'mentions'>): string {
    const cfg = this.slack.config()
    let text = row.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const ids = (() => { try { return JSON.parse(row.mentions || '[]') as string[] } catch { return [] } })()
    for (const id of ids.slice(0, 20)) {
      const u = cfg?.team_id ? this.db.query('SELECT u.name, l.slack_user_id FROM users u JOIN slack_links l ON l.user_id = u.id AND l.team_id = ? WHERE u.id = ?').get(cfg.team_id, id) as { name: string; slack_user_id: string } | null : null
      if (!u || !USER.test(u.slack_user_id)) continue
      const esc = `@${u.name}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      text = text.replace(new RegExp(`${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu'), `<@${u.slack_user_id}>`)
    }
    return text.slice(0, 39_000)
  }

  private async post(linkId: string, messageId: string, retry = 0): Promise<void> {
    const l = this.db.query('SELECT * FROM slack_relay_links WHERE id = ?').get(linkId) as RelayLinkRow | null
    const row = l ? messageRow(this.db, l.room_id, messageId) : null
    const bot = this.slack.botToken()
    if (!row || row.deleted_at || !this.active(l) || !bot) { this.db.query('DELETE FROM slack_relay_outbox WHERE room_message_id = ? AND state = ?').run(messageId, 'pending'); return }
    const author = this.db.query('SELECT name FROM users WHERE id = ?').get(row.author_id) as { name: string } | null
    const name = (author?.name ?? 'Someone').slice(0, 60)
    let threadTs: string | null = null
    let text = this.toSlack(row)
    if (row.thread_root_id) {
      const r = this.db.query('SELECT ts, thread_ts FROM slack_relay_messages WHERE room_message_id = ? AND channel_id = ?').get(row.thread_root_id, l.channel_id) as { ts: string; thread_ts: string | null } | null
      if (r) threadTs = r.thread_ts ?? r.ts
      else {
        // a reply to a message that never went to Slack: a normal message quoting the first line of its parent
        const parent = messageRow(this.db, l.room_id, row.thread_root_id)
        // only a person's own words (never an AI answer, a shared answer, another app's card or an event line)
        const own = !!parent && parent.author_kind === 'user' && !!parent.author_id && !parent.app_card && !parent.event && parent.answer_at === null && !parent.deleted_at
          && !this.db.query("SELECT 1 FROM slack_relay_outbox WHERE room_message_id = ? AND state = 'not_relayed'").get(parent.id)
        const first = own ? parent!.body.split('\n').find((x) => x.trim())?.slice(0, 200) : undefined
        if (first) text = `> ${first.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n${text}`
      }
    }
    const custom = this.customName()
    const body: Record<string, unknown> = {
      channel: l.channel_id, text: custom ? text : `*${name.replace(/[*_~`<>&]/g, '')}:* ${text}`, link_names: false, unfurl_links: false, unfurl_media: false,
      ...(custom ? { username: `${name} (${PRODUCT.displayName})`.slice(0, 80) } : {}),
      ...(threadTs ? { thread_ts: threadTs, ...(row.also_in_room ? { reply_broadcast: true } : {}) } : {}),
    }
    await this.learnBotId()
    // our own post's echo is told apart by our bot id (relay.ts ownBot): without it (auth.test did not answer) the
    // official app could take its echo for another team's post, so the message waits and is tried again
    if (!this.botId && this.slack.config()?.mode === 'official') {
      if (retry < 5) { const t = setTimeout(() => void this.serial(`out:${l.channel_id}`, () => this.post(linkId, messageId, retry + 1)), 10_000); (t as { unref?: () => void }).unref?.(); return }
      this.db.query("UPDATE slack_relay_outbox SET state = 'failed', reason = 'no_bot_id', attempts = attempts + 1 WHERE room_message_id = ?").run(row.id)
      this.changed(row)
      return
    }
    await this.gap(l.channel_id)
    try {
      const r = await this.slack.api.call('chat.postMessage', bot, body, { noWait: true })
      const ts = str(r.ts, TS)
      if (!ts) throw new SlackApiError('invalid_response')
      this.db.transaction(() => {
        this.db.query("INSERT OR IGNORE INTO slack_relay_messages (channel_id, ts, room_message_id, thread_ts, direction, created_at) VALUES (?, ?, ?, ?, 'out', ?)").run(l.channel_id, ts, row.id, threadTs, nowIso())
        this.db.query('DELETE FROM slack_relay_outbox WHERE room_message_id = ?').run(row.id)
      })()
    } catch (e) {
      this.slack.tokenRefused(e, bot)
      const code = e instanceof SlackApiError ? e.code : 'unknown'
      // a rate limit retries by itself and shows nothing
      if (code === 'ratelimited' && retry < 5) {
        const wait = Math.max(1, (e as SlackApiError).retryAfter ?? 5) * 1000
        const t = setTimeout(() => void this.serial(`out:${l.channel_id}`, () => this.post(linkId, messageId, retry + 1)), wait)
        ;(t as { unref?: () => void }).unref?.()
        return
      }
      this.db.query("UPDATE slack_relay_outbox SET state = 'failed', reason = ?, attempts = attempts + 1 WHERE room_message_id = ?").run(code.slice(0, 40), row.id)
      if (GONE_CODES.has(code)) this.setState(l, 'bot_removed', 'bot_removed', code)
      else if (ARCHIVED_CODES.has(code)) this.setState(l, 'archived', 'archived', code)
    }
    this.changed(row)
  }

  private edited(row: MessageRow) {
    const l = linkOfRoom(this.db, row.room_id)
    if (!this.active(l)) return
    const r = this.db.query("SELECT channel_id, ts FROM slack_relay_messages WHERE room_message_id = ? AND direction = 'out' AND channel_id = ?").get(row.id, l.channel_id) as { channel_id: string; ts: string } | null
    if (!r) return
    void this.serial(`out:${l.channel_id}`, async () => {
      const bot = this.slack.botToken()
      const fresh = messageRow(this.db, row.room_id, row.id)
      if (!bot || !fresh || fresh.deleted_at) return
      const author = this.db.query('SELECT name FROM users WHERE id = ?').get(fresh.author_id) as { name: string } | null
      const text = this.toSlack(fresh)
      await this.gap(l.channel_id)
      try { await this.slack.api.call('chat.update', bot, { channel: r.channel_id, ts: r.ts, text: this.customName() ? text : `*${(author?.name ?? '').replace(/[*_~`<>&]/g, '')}:* ${text}`, link_names: false }) } catch (e) { this.slack.tokenRefused(e, bot) }
    })
  }

  private removed(row: MessageRow) {
    const l = linkOfRoom(this.db, row.room_id)
    if (!l) return
    // a relayed Slack message deleted here by a manager: stays in Slack (only its own writer or Slack's admins delete it)
    const r = this.db.query("SELECT channel_id, ts FROM slack_relay_messages WHERE room_message_id = ? AND direction = 'out' AND channel_id = ?").get(row.id, l.channel_id) as { channel_id: string; ts: string } | null
    this.db.query('DELETE FROM slack_relay_outbox WHERE room_message_id = ?').run(row.id)
    if (!r || !this.active(l)) return
    void this.serial(`out:${l.channel_id}`, async () => {
      const bot = this.slack.botToken()
      if (!bot) return
      await this.gap(l.channel_id)
      try { await this.slack.api.call('chat.delete', bot, { channel: r.channel_id, ts: r.ts }) } catch (e) { this.slack.tokenRefused(e, bot) }
    })
  }

  /** "Retry" on my own message Slack refused. */
  retry(userId: string, roomId: string, messageId: string) {
    const room = this.roomOf(userId, roomId)
    const row = messageRow(this.db, room.id, messageId)
    const box = this.db.query("SELECT link_id FROM slack_relay_outbox WHERE room_message_id = ? AND state = 'failed'").get(messageId) as { link_id: string } | null
    if (!row || row.author_id !== userId || !box) fail('not_found')
    const l = linkOfRoom(this.db, room.id)
    if (!this.active(l) || l.id !== box!.link_id) fail('conflict', 'This conversation is not connected to Slack now.', { params: { reason: 'slack_off' } })
    this.db.query("UPDATE slack_relay_outbox SET state = 'pending' WHERE room_message_id = ?").run(messageId)
    this.changed(row!)
    void this.serial(`out:${l!.channel_id}`, () => this.post(l!.id, messageId))
  }

  /** The Slack picture of someone whose message was relayed here (Slack's own image hosts only, in memory a day). */
  async avatar(userId: string, roomId: string, slackUser: string): Promise<{ bytes: Uint8Array; type: string }> {
    const room = this.roomOf(userId, roomId)
    if (!USER.test(slackUser)) return fail('not_found')
    const key = `${room.id}:${slackUser}`
    const hit = this.avatars.get(key)
    if (hit && hit.at > this.now() - 86_400_000) return hit
    const r = this.db.query("SELECT json_extract(app_card, '$.slack.avatar') a FROM room_messages WHERE room_id = ? AND app_card IS NOT NULL AND json_extract(app_card, '$.slack.user') = ? ORDER BY seq DESC LIMIT 1").get(room.id, slackUser) as { a: string | null } | null
    const url = r?.a ? safeLink(r.a)?.url : undefined
    if (!url || !AVATAR_HOSTS.has(new URL(url).hostname) || this.slack.api.testing) return fail('not_found')
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) })
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
      if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type) || Number(res.headers.get('content-length') ?? 0) > AVATAR_MAX) { try { await res.body?.cancel() } catch {} return fail('not_found') }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > AVATAR_MAX) return fail('not_found')
      if (this.avatars.size > 500) this.avatars.clear()
      const v = { bytes: buf, type, at: this.now() }
      this.avatars.set(key, v)
      return v
    } catch (e) { if (e instanceof HttpError) throw e; return fail('not_found') }
  }
}

const relays = new WeakMap<SlackConnector, SlackRelay>()
export function relayOf(slack: SlackConnector): SlackRelay {
  let r = relays.get(slack)
  if (!r) { r = new SlackRelay(slack); relays.set(slack, r) }
  return r
}
