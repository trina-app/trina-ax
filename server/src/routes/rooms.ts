// Route module "rooms" — owner: component B. Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1").
// Implements: ROOMS (shared/src/api/rooms.ts). Logic: server/src/rooms/*. Every handler takes the person from the
// session; the request never names an author or another member's read position.
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { assertStorageRoom } from '../system/storage'
import { streamFile } from '../team-files/download'
import { SAFE_OPS_TEXT } from '../safe-ops/strings'
import { hashFile, writeTemp } from '../team-files/place'
import { roomsOf } from '../rooms/service'
import { roomFilesOf } from '../rooms/files'
import { roomAiOf } from '../rooms/ai'
import { getChatRuntime } from '../chat/runtime'
import { windowOf } from './chats'

export const roomsRoutes: RouteModule = {
  name: 'rooms',
  owner: 'B',
  init(ctx) {
    const rooms = roomsOf(ctx)
    // existing groups get their team rooms and everyone gets the everyone room at the first start with rooms; after
    // that groups and accounts are followed at once (admin/folders.ts afterAccessChange) and on this tick
    try { rooms.sync() } catch (e) { ctx.log.error('room sync failed', { err: e }) }
    // after a restore the database and the team folder can be from different moments: rows and files are matched
    try { roomFilesOf(ctx).reconcile() } catch (e) { ctx.log.error('room file reconcile failed', { err: e }) }
    // the AI in rooms (rooms/ai.ts): the chat runtime's room hooks, and the questions that ended while it was down
    try {
      getChatRuntime(ctx).rooms = roomAiOf(ctx)
      roomAiOf(ctx).reconcile()
    } catch (e) { ctx.log.error('room AI start failed', { err: e }) }
    const tick = setInterval(() => { rooms.syncSoon(); try { roomFilesOf(ctx).sweep() } catch (e) { ctx.log.warn('room file sweep failed', { err: e }) } }, 60_000)
    ;(tick as { unref?: () => void }).unref?.()
    ctx.onClose(() => clearInterval(tick))
  },
  register(kit, ctx) {
    const rooms = roomsOf(ctx)
    const files = roomFilesOf(ctx)
    const tmpDir = path.join(ctx.config.dataDir, 'uploads', 'tmp')

    kit.handle(API.listRooms, ({ c, auth }) => { c.header('Cache-Control', 'no-store'); return { items: rooms.list(auth.user.id), alerts: rooms.alerts(auth.user.id) } })
    kit.handle(API.createRoom, ({ c, auth, body }) => (body.kind === 'dm' ? rooms.openDm(auth.user.id, body.userId) : rooms.createGroup(auth.user.id, body.userIds, body.name, c.get('locale'))))
    kit.handle(API.getRoom, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return rooms.get(auth.user.id, params.id) })
    kit.handle(API.updateRoom, ({ auth, params, body }) => rooms.update(auth.user.id, params.id, body))
    kit.handle(API.listRoomMessages, ({ c, auth, params, query }) => { c.header('Cache-Control', 'no-store'); return rooms.messages(auth.user.id, params.id, query) })
    // ⌘K: the messages I can see in my rooms (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기", rooms/search.ts)
    kit.handle(API.searchRoomMessages, ({ c, auth, query }) => { c.header('Cache-Control', 'no-store'); return rooms.search(auth.user.id, query) })
    // "@트리나 …" asks the AI as the sender (rooms/ai.ts): the window for the desktop browser, the screen's language
    kit.handle(API.sendRoomMessage, ({ c, auth, params, body }) => rooms.send(auth.user.id, params.id, body, { windowId: windowOf(c), clientKind: auth.session.client, locale: c.get('locale') }))
    // threads and reactions (docs/DECISIONS.md "스레드와 반응"): a reply is a send with threadRootId
    kit.handle(API.listRoomThread, ({ c, auth, params, query }) => { c.header('Cache-Control', 'no-store'); return rooms.thread(auth.user.id, params.id, params.messageId, query) })
    kit.handle(API.markRoomThreadRead, ({ auth, params, body }) => rooms.markThreadRead(auth.user.id, params.id, params.messageId, body.seq))
    kit.handle(API.reactRoomMessage, ({ auth, params, body }) => rooms.react(auth.user.id, params.id, params.messageId, body.emoji, body.on))
    kit.handle(API.editRoomMessage, ({ c, auth, params, body }) => rooms.edit(auth.user.id, params.id, params.messageId, body, c.get('locale')))
    kit.handle(API.deleteRoomMessage, ({ auth, params }) => rooms.remove(auth.user.id, params.id, params.messageId))
    kit.handle(API.markRoomRead, ({ auth, params, body }) => rooms.markRead(auth.user.id, params.id, body.seq))
    kit.handle(API.listRoomMembers, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return { items: rooms.members(auth.user.id, params.id) } })
    // group chats (docs/DECISIONS.md "그룹 대화와 방 이름"): any member invites or leaves; the manager, or an owner or
    // admin in it, takes someone out
    kit.handle(API.inviteRoomMembers, ({ auth, params, body }) => rooms.invite(auth.user.id, params.id, body.userIds))
    kit.handle(API.removeRoomMember, ({ auth, params }) => rooms.removeMember(auth.user.id, params.id, params.userId))
    kit.handle(API.leaveRoom, ({ auth, params }) => rooms.leave(auth.user.id, params.id))
    // hiding a DM, a team room or the everyone room from my own lists (docs/DECISIONS.md "대화 숨기기"): mine only
    kit.handle(API.setRoomHidden, ({ auth, params, body }) => rooms.setHidden(auth.user.id, params.id, body.hidden))

    kit.handle(API.uploadRoomFile, async ({ auth, params, body }) => {
      // the same checks as a chat attachment: the whole part arrived, there is room on the disk
      if (body.fields.size !== undefined && body.fields.size !== body.file.size) fail('validation', undefined, { fields: { 'body.file': `expected ${body.fields.size} bytes, got ${body.file.size}` } })
      assertStorageRoom(body.file.size)
      rooms.get(auth.user.id, params.id)
      const p = await writeTemp(tmpDir, body.file)
      try { return await files.create(auth.user.id, params.id, body.fields.name ?? (body.file.name || 'file'), p, await hashFile(p)) } finally { fs.rmSync(p, { force: true }) }
    })
    const ai = roomAiOf(ctx)
    kit.handle(API.getRoomAi, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return ai.state(auth.user.id, params.id) })
    kit.handle(API.stopRoomAi, ({ auth, params }) => ai.stop(auth.user.id, params.id, params.turnId))
    kit.handle(API.shareRoomMessage, ({ auth, params }) => ai.share(auth.user.id, params.id, params.messageId))
    kit.handle(API.roomMessageSources, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return ai.sources(auth.user.id, params.id, params.messageId) })
    kit.handle(API.roomFile, ({ c, auth, params, query }) => {
      const f = files.open(auth.user.id, params.id, params.fileId, !!query.thumb)
      // a file on the safety check's download-only list (docs/SAFE-OPS-1A.md) goes only as a download (download=1): no
      // thumbnail and no inline read, which is what the preview panel reads, and never into a picture, a frame, a player
      // or a script of a page (Fetch Metadata's destination). Unlike a team file's download, a fetch (destination empty)
      // is not refused: the phone app saves a download through fetch (lib/mobile.ts downloadToApp)
      const dest = c.req.raw.headers.get('sec-fetch-dest')
      if (f.quarantined && (query.thumb || !query.download || (dest && dest !== 'document' && dest !== 'empty'))) fail('unavailable', SAFE_OPS_TEXT.quarantined[c.get('locale')], { params: { reason: 'quarantined' } })
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: query.download ? 'attachment' : 'inline' })
    })
  },
}
