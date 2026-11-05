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
import { hashFile, writeTemp } from '../team-files/place'
import { roomsOf } from '../rooms/service'
import { roomFilesOf } from '../rooms/files'

export const roomsRoutes: RouteModule = {
  name: 'rooms',
  owner: 'B',
  init(ctx) {
    const rooms = roomsOf(ctx)
    // existing groups get their team rooms and everyone gets the everyone room at the first start with rooms; after
    // that groups and accounts are followed at once (admin/folders.ts afterAccessChange) and on this tick
    try { rooms.sync() } catch (e) { ctx.log.error('room sync failed', { err: e }) }
    const tick = setInterval(() => { rooms.syncSoon(); try { roomFilesOf(ctx).sweep() } catch (e) { ctx.log.warn('room file sweep failed', { err: e }) } }, 60_000)
    ;(tick as { unref?: () => void }).unref?.()
    ctx.onClose(() => clearInterval(tick))
  },
  register(kit, ctx) {
    const rooms = roomsOf(ctx)
    const files = roomFilesOf(ctx)
    const tmpDir = path.join(ctx.config.dataDir, 'uploads', 'tmp')

    kit.handle(API.listRooms, ({ c, auth }) => { c.header('Cache-Control', 'no-store'); return { items: rooms.list(auth.user.id) } })
    kit.handle(API.createRoom, ({ auth, body }) => rooms.openDm(auth.user.id, body.userId))
    kit.handle(API.getRoom, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return rooms.get(auth.user.id, params.id) })
    kit.handle(API.updateRoom, ({ auth, params, body }) => rooms.setMuted(auth.user.id, params.id, body.muted))
    kit.handle(API.listRoomMessages, ({ c, auth, params, query }) => { c.header('Cache-Control', 'no-store'); return rooms.messages(auth.user.id, params.id, query) })
    kit.handle(API.sendRoomMessage, ({ auth, params, body }) => rooms.send(auth.user.id, params.id, body))
    kit.handle(API.editRoomMessage, ({ auth, params, body }) => rooms.edit(auth.user.id, params.id, params.messageId, body))
    kit.handle(API.deleteRoomMessage, ({ auth, params }) => rooms.remove(auth.user.id, params.id, params.messageId))
    kit.handle(API.markRoomRead, ({ auth, params, body }) => rooms.markRead(auth.user.id, params.id, body.seq))
    kit.handle(API.listRoomMembers, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return { items: rooms.members(auth.user.id, params.id) } })

    kit.handle(API.uploadRoomFile, async ({ auth, params, body }) => {
      // the same checks as a chat attachment: the whole part arrived, there is room on the disk
      if (body.fields.size !== undefined && body.fields.size !== body.file.size) fail('validation', undefined, { fields: { 'body.file': `expected ${body.fields.size} bytes, got ${body.file.size}` } })
      assertStorageRoom(body.file.size)
      rooms.get(auth.user.id, params.id)
      const p = await writeTemp(tmpDir, body.file)
      try { return await files.create(auth.user.id, params.id, body.fields.name ?? (body.file.name || 'file'), p, await hashFile(p)) } finally { fs.rmSync(p, { force: true }) }
    })
    kit.handle(API.roomFile, ({ c, auth, params, query }) => {
      const f = files.open(auth.user.id, params.id, params.fileId, !!query.thumb)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: query.download ? 'attachment' : 'inline' })
    })
  },
}
