// Route module "rooms" — owner: component B. Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1").
// Implements: ROOMS (shared/src/api/rooms.ts) and AI_ALLOWANCES (shared/src/api/ai-allowances.ts: what I allowed @트리나
// in advance, rooms/ai-grants.ts). Logic: server/src/rooms/*. Every handler takes the person from the session; the
// request never names an author or another member's read position.
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { assertStorageRoom } from '../system/storage'
import { streamFile } from '../team-files/download'
import { SAFE_OPS_TEXT } from '../safe-ops/strings'
import { hashFile, writeTemp } from '../team-files/place'
import { HwpError } from '../files/hwp-engine'
import { componentC } from '../team-files/component'
import { httpError } from '../team-files/errors'
import { fileOpener, roomsOf } from '../rooms/service'
import { roomFilesOf } from '../rooms/files'
import { deleteGrant, listGrants } from '../rooms/ai-grants'

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
    // once, a minute after start: the JPEG thumbnails of transparent pictures sent before become PNG ones (rooms/files.ts
    // refreshThumbs)
    if (process.env.NODE_ENV !== 'test') {
      const stop = new AbortController()
      const later = setTimeout(() => { void roomFilesOf(ctx).refreshThumbs(stop.signal).catch((e) => ctx.log.warn('room thumbnail refresh failed', { err: e })) }, 60_000)
      ;(later as { unref?: () => void }).unref?.()
      ctx.onClose(() => { clearTimeout(later); stop.abort() })
    }
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
    // and the files sent with those messages, by name (the same rule: rooms/search.ts searchRoomFiles)
    kit.handle(API.searchRoomFiles, ({ c, auth, query }) => { c.header('Cache-Control', 'no-store'); return rooms.searchFiles(auth.user.id, query) })
    // the screen's language for a refusal ("@트리나" asks nothing: docs/DECISIONS.md "Room @트리나 code removed")
    kit.handle(API.sendRoomMessage, ({ c, auth, params, body }) => rooms.send(auth.user.id, params.id, body, { locale: c.get('locale') }))
    // threads and reactions (docs/DECISIONS.md "스레드와 반응"): a reply is a send with threadRootId
    kit.handle(API.listRoomThread, ({ c, auth, params, query }) => { c.header('Cache-Control', 'no-store'); return rooms.thread(auth.user.id, params.id, params.messageId, query) })
    kit.handle(API.markRoomThreadRead, ({ auth, params, body }) => rooms.markThreadRead(auth.user.id, params.id, params.messageId, body.seq))
    kit.handle(API.reactRoomMessage, ({ c, auth, params, body }) => rooms.react(auth.user.id, params.id, params.messageId, body.emoji, body.on, c.get('locale')))
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
    // "상단에 고정" / "고정 해제" (docs/DECISIONS.md "Pinned conversations"): mine only; only my own windows hear it
    kit.handle(API.pinRoom, ({ c, auth, params }) => rooms.pin(auth.user.id, params.id, c.get('locale')))
    kit.handle(API.unpinRoom, ({ auth, params }) => rooms.unpin(auth.user.id, params.id))
    // "이 방에서는 항상 허용" (rooms/ai-grants.ts): my own only; another person's id answers like one that is not there
    kit.handle(API.listAiAllowances, ({ c, auth }) => { c.header('Cache-Control', 'no-store'); return { items: listGrants(ctx.db, auth.user.id) } })
    kit.handle(API.deleteAiAllowance, ({ auth, params }) => { if (!deleteGrant(ctx.db, auth.user.id, params.id)) fail('not_found') })

    kit.handle(API.uploadRoomFile, async ({ auth, params, body }) => {
      // the same checks as a chat attachment: the whole part arrived, there is room on the disk
      if (body.fields.size !== undefined && body.fields.size !== body.file.size) fail('validation', undefined, { fields: { 'body.file': `expected ${body.fields.size} bytes, got ${body.file.size}` } })
      assertStorageRoom(body.file.size)
      rooms.get(auth.user.id, params.id)
      const p = await writeTemp(tmpDir, body.file)
      try { return await files.create(auth.user.id, params.id, body.fields.name ?? (body.file.name || 'file'), p, await hashFile(p)) } finally { fs.rmSync(p, { force: true }) }
    })
    // "팀 파일" in a room's box (a phone's attach sheet): the copy "대화방에 보내기" makes of a linked file (rooms/files.ts
    // teamCopy over fromTeamFile: in the room, my read access now, a regular file of at most 50 MB, the storage check,
    // photo metadata cut out; anything else 404 like a missing file), kept as my unsent upload and sent by id like one.
    // The same unchanged file again: that copy again; my unsent copies are capped (409 team_copies_full). With it, how
    // many other members cannot open the team file now (the rooms' own link check, fileOpener; a disabled account counts):
    // the box tells me before I send, as the share step does. Audited when it is sent (rooms/service.ts send)
    kit.handle(API.attachRoomTeamFile, async ({ c, auth, params, body }) => {
      rooms.get(auth.user.id, params.id)
      const file = await files.teamCopy(auth.user.id, params.id, body.path, c.get('locale'))
      const others = ctx.db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ?').all(params.id, auth.user.id) as { user_id: string }[]
      const unable = others.filter((m) => !fileOpener(ctx, m.user_id)(body.path)).length
      return { file, unable }
    })
    kit.handle(API.roomFile, ({ c, auth, params, query }) => {
      const f = files.open(auth.user.id, params.id, params.fileId, !!query.thumb)
      // a file on the safety check's download-only list (docs/SAFE-OPS-1A.md) goes only as a download (download=1): no
      // thumbnail and no inline read, which is what the preview panel reads, and never into a picture, a frame, a player
      // or a script of a page (Fetch Metadata's destination). Unlike a team file's download, a fetch (destination empty)
      // is not refused: the phone app saves a download through fetch (lib/mobile.ts downloadToApp)
      const dest = c.req.raw.headers.get('sec-fetch-dest')
      if (f.quarantined && (query.thumb || !query.download || (dest && dest !== 'document' && dest !== 'empty'))) fail('unavailable', SAFE_OPS_TEXT.quarantined[c.get('locale')], { params: { reason: 'quarantined' } })
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: query.download ? 'attachment' : 'inline', via: c.get('info')?.via })
    })
    // a Hangul file's pages from the HWP Preview plugin (files/hwp-preview.ts: the team file preview's renderer, limits,
    // isolation and cache). The inline read's checks run on every request, before the cache and the render and again
    // after it (rooms/files.ts hwpSource); the plugin off or not usable here answers as for a team file (disabled)
    kit.handle(API.roomFileHwpPreview, async ({ c, auth, params, query }) => {
      c.header('Cache-Control', 'private, no-store')
      c.header('X-Content-Type-Options', 'nosniff')
      const locale = c.get('locale')
      try {
        const r = await componentC(ctx).hwp.pageOf(auth.user.id, (admission) => files.hwpSource(auth.user.id, params.id, params.fileId, admission, locale), query.page, c.req.raw.signal, query.cacheId)
        return { ...r.meta, id: r.id, png: r.bytes.toString('base64') }
      } catch (e) {
        if (e instanceof HwpError) throw httpError('unavailable', 'noPreview', locale, undefined, { reason: e.reason })
        throw e
      }
    })
  },
}
