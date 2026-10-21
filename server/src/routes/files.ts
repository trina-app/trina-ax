// Route module "files" — owner: component C (docs/WORKPLAN.md).
// Implements: FILES (tree, content, save, download, upload, mkdir, move, delete, history, restore, trash, attachments,
// upload sessions). Contract: shared/src/api/files.ts. Logic: server/src/team-files/*, server/src/uploads/*.
import fs from 'node:fs'
import path from 'node:path'
import { API, CONTENT_SHA_HEADER } from '@mycel/shared/api'
import { mapErrors } from '../team-files/errors'
import { componentC } from '../team-files/component'
import { streamFile } from '../team-files/download'
import { hashFile, writeTemp } from '../team-files/place'
import { registerCTools } from '../tools'
import type { RouteModule } from './module'

export const filesRoutes: RouteModule = {
  name: 'files',
  owner: 'C',
  init(ctx) {
    componentC(ctx)
    registerCTools(ctx)
  },
  register(kit, ctx) {
    const C = componentC(ctx)
    const svc = C.files
    const tmpDir = path.join(ctx.config.dataDir, 'uploads', 'tmp')
    /** a small upload (multipart, ≤ 50 MB, already in memory) -> server temp file + sha256 */
    const spool = async (file: File) => {
      const p = await writeTemp(tmpDir, file)
      return { p, sha: await hashFile(p) }
    }

    kit.handle(API.tree, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.tree(auth.user.id, query.path, query.cursor, query.limit)))

    kit.handle(API.content, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => {
      const r = await svc.content(auth.user.id, query.path, query.maxBytes)
      c.header(CONTENT_SHA_HEADER, r.sha256)
      return r
    }))

    kit.handle(API.saveContent, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.save(auth.user.id, body.path, body.content, body.baseSha256)), { jsonLimit: 25 * 1024 * 1024 })

    kit.handle(API.download, ({ c, query, auth }) => mapErrors(c.get('locale'), () => {
      const f = svc.fileForDownload(auth.user.id, query.path)
      return streamFile({ abs: f.abs, name: f.name, req: c.req.raw, disposition: query.disposition })
    }))

    kit.handle(API.upload, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      const { p, sha } = await spool(body.file)
      try {
        return await svc.placeUpload(auth.user.id, body.fields.folder, body.fields.name ?? (body.file.name || 'file'), p, body.fields.onExists, sha)
      } finally { fs.rmSync(p, { force: true }) }
    }, 'name'))

    kit.handle(API.mkdir, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.mkdir(auth.user.id, body.path)))
    kit.handle(API.move, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.move(auth.user.id, body.from, body.to, body.onExists, { confirm: body.confirm }), 'to'))
    kit.handle(API.copy, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.copy(auth.user.id, body.from, body.to, { baseSha256: body.baseSha256, dryRun: body.dryRun, onExists: body.onExists }), 'to'))
    kit.handle(API.remove, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.remove(auth.user.id, query.path)))
    kit.handle(API.history, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.history(auth.user.id, query.path)))
    kit.handle(API.versionDownload, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      const v = svc.versionFile(auth.user.id, params.versionId)
      return streamFile({ abs: v.abs, name: v.name, req: c.req.raw, disposition: 'attachment' })
    }))
    kit.handle(API.restoreVersion, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.restoreVersion(auth.user.id, body.path, body.versionId)))
    kit.handle(API.trash, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.trash(auth.user.id, { mine: query.mine, cursor: query.cursor, limit: query.limit })))
    kit.handle(API.restoreTrash, ({ c, params, auth }) => mapErrors(c.get('locale'), () => svc.restoreTrash(auth.user.id, params.id)))
    kit.handle(API.purgeTrash, ({ c, params, auth }) => mapErrors(c.get('locale'), () => { svc.purgeTrash(params.id, auth.user.id) }))

    // ---------------- attachments ----------------
    kit.handle(API.uploadAttachment, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      const { p, sha } = await spool(body.file)
      try { return await C.attachments.create(auth.user.id, body.fields.chatId, body.fields.name ?? (body.file.name || 'file'), p, sha) } finally { fs.rmSync(p, { force: true }) }
    }, 'name'))
    kit.handle(API.attachmentThumbnail, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      const t = C.attachments.thumbnail(auth.user.id, params.id)
      return streamFile({ abs: t.abs, name: t.name, req: c.req.raw, disposition: 'inline' })
    }))

    // ---------------- chunked uploads ----------------
    kit.handle(API.createUploadSession, ({ c, body, auth }) => mapErrors(c.get('locale'), () => C.uploads.create(auth.user.id, body.target, body.size, body.sha256), 'target'))
    kit.handle(API.uploadChunk, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => C.uploads.putChunk(auth.user.id, params.id, Number(params.n), body)))
    kit.handle(API.getUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), () => C.uploads.get(auth.user.id, params.id)))
    kit.handle(API.completeUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), () => C.uploads.complete(auth.user.id, params.id)))
    kit.handle(API.cancelUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), () => { C.uploads.cancel(auth.user.id, params.id) }))
  },
}
