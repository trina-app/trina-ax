// Route module "files" — owner: component C (docs/WORKPLAN.md).
// Implements: FILES (tree, content, save, download, upload, mkdir, move, delete, history, restore, trash, attachments,
// team-file references and the picker's find / recent, upload sessions). Contract: shared/src/api/files.ts. Logic: server/src/team-files/*, server/src/uploads/*.
import { registerConnectionsAccountCleanup } from '../integrations/account-cleanup'
import path from 'node:path'
import { API, CONTENT_SHA_HEADER } from '@mycel/shared/api'
import { fileError, mapErrors } from '../team-files/errors'
import { HeicPreviews, isHeic, noPreviewError } from '../files/heic-preview'
import { componentC } from '../team-files/component'
import { fileSharesOf, registerFileShareCleanup } from '../files/shares'
import { folderSharesOf } from '../files/folder-shares'
import { undoShares } from '../files/share-undo'
import { streamChecked } from '../team-files/stream-checked'
import { shareFixesOf } from '../files/share-fixes'
import { contentDisposition, streamFile } from '../team-files/download'
import { embedNarrower } from '../team-files/embed'
import { htmlPdfDownload, saveHtmlPdf } from '../team-files/html-pdf-save'
import { authorize } from '../policy/authorize'
import { searchFileContents } from '../team-files/content-search'
import { findFiles, recentFiles } from '../team-files/find'
import { dismissMoveSuggestion, moveSuggestions } from '../team-files/move-suggest'
import type { SpooledFile } from '../http/multipart'
import { assertGuestUploadSize } from '../uploads/guest-limit'
import { registerCTools } from '../tools'
import { HwpError } from '../files/hwp-engine'
import { ToolError } from '../policy/errors'
import type { RouteModule } from './module'
import { assertStorageRoom } from '../system/storage'
import { registerDriveRoutes } from './drive'
import { registerGoogleAppsRoutes } from './google-apps'
import { googleAppsOf } from '../integrations/google-apps/service'
import { installServiceRequests } from '../integrations/service-requests'
import { registerIntegrationRoutes } from './integrations'
import { requestsOf } from '../integrations/connections/requests'
import { registerIntegrations } from '../integrations/connections/tools'
import { registerPluginRoutes } from './plugins'
import { pluginsOf } from '../plugins/manager'
import { registerFileListRoutes } from './file-list'
import { fileListOf } from '../file-list/service'
import { getChatRuntime } from '../chat/runtime'
import { deleteProjectForGood } from '../chat/project-delete'
import { HttpError } from '../http/errors'
import { openableTurnChats } from '../chat/version-chats'
import { chatFilesOf } from '../chat/chat-files'
import type { HistoryResponse } from '@mycel/shared/api'

export const filesRoutes: RouteModule = {
  name: 'files',
  owner: 'C',
  init(ctx) {
    componentC(ctx)
    // a deleted account's file shares (files/shares.ts)
    registerFileShareCleanup(ctx)
    // a deleted account's Drive sign-in, sign-in flows and Slack link go with it (auth/account-removal.ts)
    registerConnectionsAccountCleanup(ctx)
    // plugins before the tools: hwp_render asks it whether the HWP plugin is usable; it also installs the team-folder
    // write guard for skill-pack files. A broken plugin store never stops the server here.
    try { pluginsOf(ctx) } catch (e) { ctx.log.error('plugin manager failed to start; plugins stay off', { err: e }) }
    registerCTools(ctx)
    // external-service connections: each person's tools are made at the start of their turn
    registerIntegrations(ctx)
    // Gmail, Calendar, Docs and Sheets: the library runs while one of them is set up (integrations/google-apps/)
    try { googleAppsOf(ctx) } catch (e) { ctx.log.error('Google apps failed to start; they stay off', { err: e }) }
    // a member's ask to add an app: closed once it is set up somewhere else too (integrations/service-requests.ts)
    installServiceRequests(ctx)
    // requests to connect sent to guests before they were refused end once, at start (connections/requests.ts)
    try { requestsOf(ctx).endGuestRequests() } catch (e) { ctx.log.warn('ending connection requests to guests failed', { err: e }) }
    // the file list: its nightly check and its hooks on moves and access changes (file-list/service.ts); a broken
    // sidecar never stops the server here
    try { fileListOf(ctx) } catch (e) { ctx.log.error('file list failed to start; it stays off', { err: e }) }
  },
  register(kit, ctx) {
    registerDriveRoutes(kit, ctx)
    registerGoogleAppsRoutes(kit, ctx)
    registerIntegrationRoutes(kit, ctx)
    registerPluginRoutes(kit, ctx)
    // Admin › Team settings › File list (file-list/service.ts)
    registerFileListRoutes(kit, ctx)
    const C = componentC(ctx)
    /** The history with the chat of each AI save the caller may open now (FileVersion.savedChatId, current.chatId).
     * No chat runtime (a server without chats), or a check that fails: no links, the history as before (never a 500). */
    const withChatLinks = (userId: string, h: HistoryResponse): HistoryResponse => {
      let chats: Map<string, string>
      try {
        chats = openableTurnChats(getChatRuntime(ctx), userId, [...h.items.map((v) => (v.savedBy ? v.savedTurnId : null)), h.current?.turnId])
      } catch (e) {
        ctx.log.warn('file history: the chats of AI saves could not be checked; no links', { err: e })
        return h
      }
      if (!chats.size) return h
      const chatOf = (turnId: string | null | undefined) => (turnId ? chats.get(turnId) : undefined)
      return {
        ...h,
        items: h.items.map((v) => { const id = v.savedBy ? chatOf(v.savedTurnId) : undefined; return id ? { ...v, savedChatId: id } : v }),
        current: h.current && chatOf(h.current.turnId) ? { ...h.current, chatId: chatOf(h.current.turnId)! } : h.current,
      }
    }
    const svc = C.files
    /** A part of another size than the sender read lost bytes on the way (WebKit bug 319985 sends none at all): it stops
     * here, before it takes a name or replaces a file. An empty file that says so is an upload like any other. */
    const assertWhole = (file: SpooledFile, size: number | undefined) => {
      if (size !== undefined && size !== file.size) fileError('validation', 'incompleteUpload', { 'body.file': `expected ${size} bytes, got ${file.size}` })
    }

    kit.handle(API.tree, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.tree(auth.user.id, query.path, query.cursor, query.limit)))
    // who can see a folder (a count only where the caller can write; team-files/service.ts audience)
    kit.handle(API.folderAudience, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.audience(auth.user.id, query.path)))

    kit.handle(API.content, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => {
      const r = await svc.content(auth.user.id, query.path, query.maxBytes)
      c.header(CONTENT_SHA_HEADER, r.sha256)
      return r
    }))

    // the team disk near full (system/storage.ts; Linux / a plan): 507 storage_full before anything is written
    kit.handle(API.saveContent, ({ c, body, auth }) => mapErrors(c.get('locale'), () => { assertStorageRoom(Buffer.byteLength(body.content)); return svc.save(auth.user.id, body.path, body.content, body.baseSha256) }), { jsonLimit: 25 * 1024 * 1024 })

    kit.handle(API.download, ({ c, query, auth }) => mapErrors(c.get('locale'), () => {
      const f = svc.fileForDownload(auth.user.id, query.path, !query.preview && query.disposition === 'attachment')
      // a file an HTML file's preview puts into the page (team-files/embed.ts): only one that everyone who can read the
      // page can read too; the person must be able to read the page as well (404 like any other file otherwise)
      if (query.embedIn !== undefined) {
        const me = svc.principal(auth.user.id)
        const rules = svc.rules()
        const page = authorize(svc.fx, rules, me, query.embedIn, 'read')
        const file = authorize(svc.fx, rules, me, query.path, 'read')
        if (embedNarrower(ctx.db, rules, page.segs, file.segs)) fileError('forbidden', 'embedNarrower', undefined, { reason: 'embed_narrower' })
      }
      // Browser-owned Fetch Metadata also blocks stale clients and img/iframe/fetch
      // consumers that request attachment bytes without the explicit preview flag.
      // Headerless API/native clients may still perform an authorized download.
      ctx.files.quarantine.assertDownload(f.abs, c.req.raw.headers)
      return streamFile({ abs: f.abs, seen: f.st, name: f.name, req: c.req.raw, disposition: query.disposition, via: c.get('info')?.via })
    }))

    // HEIC / HEIF photos (QA R2-FMT-10): browsers cannot draw them, so the file panel shows a JPEG made on the server
    // (files/heic-preview.ts). Other formats, machines without a converter and failed conversions: 503 unavailable
    // with reason no_preview (the "cannot preview" panel). Full queues and waits over the wait limit: 503 with reason
    // busy (the panel says "busy, try again"). Only the input limit is 413. The same response headers as the
    // attachment thumbnail. A request that the browser cancels leaves the conversion queue.
    const previews = new HeicPreviews(path.join(ctx.config.dataDir, 'previewcache'))
    kit.handle(API.preview, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => {
      const f = svc.fileForDownload(auth.user.id, query.path, false)
      const noPreview = (reason: 'no_preview' | 'busy' = 'no_preview') => fileError('unavailable', reason === 'busy' ? 'previewBusy' : 'noPreview', undefined, { reason })
      if (!isHeic(f.name)) return noPreview()
      let r: Awaited<ReturnType<typeof previews.jpeg>>
      try { r = await previews.jpeg(f.abs, { user: auth.user.id, signal: c.req.raw.signal, seen: f.st }) } catch (e) {
        if (noPreviewError(e)) {
          ctx.log.debug('HEIC preview failed', { err: e })
          return noPreview((e as ToolError).code === 'busy' ? 'busy' : 'no_preview')
        }
        throw e
      }
      if (!r) return noPreview()
      const etag = `"${r.etag}"`
      const headers = new Headers({ 'Content-Type': 'image/jpeg', 'ETag': etag, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': String(r.bytes.length), 'Content-Disposition': contentDisposition('inline', f.name.replace(/\.[^.]+$/, '') + '.jpg') })
      if (c.req.header('if-none-match')?.split(',').map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers })
      return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(r.bytes), { status: 200, headers })
    }))

    // "PDF로 저장" in an .html file's preview (team-files/html-pdf-save.ts): the server's headless browser prints the page
    // with the preview's rule for its files; saved next to it, or given as a download. A request the browser cancels
    // stops the print.
    kit.handle(API.saveHtmlPdf, ({ c, body, auth }) => mapErrors(c.get('locale'), () => saveHtmlPdf(ctx, svc, auth.user.id, body.path, c.req.raw.signal)))
    kit.handle(API.downloadHtmlPdf, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => {
      // a print is a minute of a browser: only this app starts one. A browser says where a request comes from
      // (Fetch Metadata); another site's <img> or link, another team's page on a sibling address included, is refused
      // before anything runs. A client that sends no such header (the phone app's own download) is not a page.
      const site = c.req.header('sec-fetch-site')
      if (site !== undefined && site !== 'same-origin') fileError('forbidden', 'htmlPdfCrossSite', undefined, { reason: 'cross_site' })
      const r = await htmlPdfDownload(ctx, svc, auth.user.id, query.path, c.req.raw.signal)
      return new Response(new Uint8Array(r.pdf), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(r.pdf.length), 'Content-Disposition': contentDisposition('attachment', r.name),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
    }))

    kit.handle(API.hwpPreview, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => {
      c.header('Cache-Control', 'private, no-store')
      c.header('X-Content-Type-Options', 'nosniff')
      try {
        const r = await C.hwp.page(auth.user.id, query.path, query.page, c.req.raw.signal, query.cacheId)
        return { ...r.meta, id: r.id, png: r.bytes.toString('base64') }
      } catch (e) {
        if (e instanceof HwpError) return fileError('unavailable', 'noPreview', undefined, { reason: e.reason })
        throw e
      }
    }))

    kit.handle(API.upload, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      assertWhole(body.file, body.fields.size)
      // a guest's own limit (one request carries at most 50 MB, under the smallest guest limit; kept in step with it)
      assertGuestUploadSize(ctx.db, auth.user.id, body.file.size)
      assertStorageRoom(body.file.size)
      // the body is on disk already, hashed on the way (http/multipart.ts); the kit removes what is left of the temp file
      // the same file at that name already (a retry whose answer was lost, photos picked again): kept, no "(2)"
      return await svc.placeUpload(auth.user.id, body.fields.folder, body.fields.name ?? (body.file.name || 'file'), body.file.path, body.fields.onExists, body.file.sha256, undefined, { keepSame: true })
    }, 'name'))

    kit.handle(API.mkdir, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.mkdir(auth.user.id, body.path)))
    kit.handle(API.move, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.move(auth.user.id, body.from, body.to, body.onExists, { confirm: body.confirm, skillsOk: body.skillsOk, askWiden: body.askWiden }), 'to'))
    kit.handle(API.copy, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.copy(auth.user.id, body.from, body.to, { baseSha256: body.baseSha256, dryRun: body.dryRun, onExists: body.onExists, confirm: body.confirm === true }), 'to'))
    kit.handle(API.remove, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.remove(auth.user.id, query.path)))
    // an AI-saved version names its chat only when the caller may open that chat now (chat/version-chats.ts)
    kit.handle(API.history, ({ c, query, auth }) => mapErrors(c.get('locale'), async () => withChatLinks(auth.user.id, await svc.history(auth.user.id, query.path))))
    kit.handle(API.versionDownload, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      const v = svc.versionFile(auth.user.id, params.versionId)
      ctx.files.quarantine.assertDownload(v.abs, c.req.raw.headers)
      return streamFile({ abs: v.abs, seen: v.st, name: v.name, req: c.req.raw, disposition: 'attachment', via: c.get('info')?.via })
    }))
    // a file shared one by one (files/shares.ts; docs/DECISIONS.md "A member shares their own files"): the link, the
    // dialog, the link page and its bytes, the request and its answer; Admin's counts and the team owner's Remove all
    const shares = fileSharesOf(ctx)
    const folders = folderSharesOf(ctx)
    kit.handle(API.fileLink, ({ c, body, auth }) => mapErrors(c.get('locale'), () => shares.linkFor(auth.user.id, body.path)))
    kit.handle(API.fileShares, ({ c, query, auth }) => mapErrors(c.get('locale'), () => shares.view(auth.user.id, query.path, c.get('locale'))))
    kit.handle(API.putFileShares, ({ c, body, auth }) => mapErrors(c.get('locale'), () => shares.put(auth.user.id, body.path, body.add, body.remove, c.get('locale'), 'dialog', { stop: body.stop, resume: body.resume }).view))
    kit.handle(API.undoFileShares, ({ c, body, auth }) => mapErrors(c.get('locale'), () => undoShares(ctx, auth.user.id, body.id, c.get('locale'))))
    kit.handle(API.shareCards, ({ c, body, auth }) => mapErrors(c.get('locale'), () => ({ items: shares.cards(auth.user.id, body.ids, c.get('locale')) })))
    kit.handle(API.shareFilesBatch, ({ c, body, auth }) => mapErrors(c.get('locale'), () => shares.shareMany(auth.user.id, body.paths, body.add, c.get('locale'))))
    kit.handle(API.sharedBatch, ({ c, params, auth }) => mapErrors(c.get('locale'), () => shares.batchPage(auth.user.id, params.id)))
    kit.handle(API.sharedWithMe, ({ c, query, auth }) => mapErrors(c.get('locale'), () => shares.sharedWithMe(auth.user.id, query.cursor, query.limit)))
    kit.handle(API.sharedFile, ({ c, params, auth }) => mapErrors(c.get('locale'), () => shares.page(auth.user.id, params.id)))
    kit.handle(API.sharedFileDownload, ({ c, params, query, auth }) => mapErrors(c.get('locale'), () => {
      // the current bytes only, checked on every request (a removed person loses it at once); nothing else by id
      if (query.sub !== undefined) {
        // a file inside a shared folder (files/folder-shares.ts): `sub` on a file link is refused there (404). The
        // bytes come from the one descriptor that is proven to be the file just checked (team-files/stream-checked.ts)
        const f = folders.file(auth.user.id, params.id, query.sub, c.get('locale'))
        ctx.files.quarantine.assertDownload(f.abs, c.req.raw.headers)
        return streamChecked({ abs: f.abs, expect: f.expect, name: f.name, req: c.req.raw, disposition: query.disposition })
      }
      const o = shares.open(auth.user.id, params.id)
      if (o.kind !== 'open') throw new HttpError('not_found')
      ctx.files.quarantine.assertDownload(o.abs, c.req.raw.headers)
      return streamFile({ abs: o.abs, seen: o.st, name: o.name, req: c.req.raw, disposition: query.disposition, via: c.get('info')?.via })
    }))
    kit.handle(API.sharedFolderList, ({ c, params, query, auth }) => mapErrors(c.get('locale'), () => folders.list(auth.user.id, params.id, query.sub, query.cursor, query.limit, c.get('locale'))))
    kit.handle(API.sharedFolderEntry, ({ c, params, query, auth }) => mapErrors(c.get('locale'), () => folders.entry(auth.user.id, params.id, query.sub, c.get('locale'))))
    kit.handle(API.requestFileAccess, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => shares.request(auth.user.id, params.id, body.message, c.get('locale'))))
    kit.handle(API.askFileShareFor, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => {
      const r = shares.requestFor(auth.user.id, params.id, body.people, c.get('locale'), 'dialog')
      return { asked: r.asked.length, already: r.already.length }
    }))
    kit.handle(API.answerFileRequest, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => shares.answer(auth.user.id, params.id, body.answer, c.get('locale'))))
    // one-tap next steps under an AI step (files/share-fixes.ts), and a path link opened through a share
    kit.handle(API.runShareFix, ({ c, params, auth }) => mapErrors(c.get('locale'), () => shareFixesOf(ctx).run(auth.user.id, params.id, c.get('locale'))))
    kit.handle(API.grantedFileLink, ({ c, query, auth }) => mapErrors(c.get('locale'), () => ({ id: shares.grantedLinkId(auth.user.id, query.path) })))
    kit.handle(API.fileSharesCount, ({ c }) => mapErrors(c.get('locale'), () => shares.counts()))
    kit.handle(API.removeAllFileShares, ({ c, auth }) => mapErrors(c.get('locale'), () => shares.removeAll(auth.user.id, c.get('locale'))))
    kit.handle(API.restoreVersion, ({ c, body, auth }) => mapErrors(c.get('locale'), () => svc.restoreVersion(auth.user.id, body.path, body.versionId, { confirm: body.confirm === true })))
    kit.handle(API.trash, ({ c, query, auth }) => mapErrors(c.get('locale'), () => svc.trash(auth.user.id, { mine: query.mine, cursor: query.cursor, limit: query.limit })))
    kit.handle(API.restoreTrash, ({ c, params, query, auth }) => mapErrors(c.get('locale'), () => svc.restoreTrash(auth.user.id, params.id, { confirm: query.confirm === true })))
    kit.handle(API.purgeTrash, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      // a team project's own folder: deleted for good as the project is (DELETE /api/projects/:id), its shared chats to
      // their creators' trash and its row gone, never only its folder (docs/DECISIONS.md "A team project in the trash")
      const project = svc.trashedProjectOf(params.id)
      if (project) {
        if (!svc.mayRestoreTrash(auth.user.id, params.id)) throw new HttpError('not_found')
        const rt = getChatRuntime(ctx)
        const r = rt.store.projectRow(project.id)
        if (r) return deleteProjectForGood(ctx, rt, r, auth.user.id, c.get('locale'))
      }
      svc.purgeTrash(params.id, auth.user.id)
    }))

    // ---------------- attachments ----------------
    kit.handle(API.uploadAttachment, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      assertWhole(body.file, body.fields.size)
      assertGuestUploadSize(ctx.db, auth.user.id, body.file.size)
      assertStorageRoom(body.file.size)
      const a = await C.attachments.create(auth.user.id, body.fields.chatId, body.fields.name ?? (body.file.name || 'file'), body.file.path, body.file.sha256)
      // the request was dropped while the file was put in place (its chip taken out): the box never learns its id, so a
      // file a shared chat put in its project folder goes to the trash again
      if (c.req.raw.signal.aborted) C.attachments.discardSaved(auth.user.id, a)
      return a
    }, 'name'))
    kit.handle(API.attachmentThumbnail, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      const t = C.attachments.thumbnail(auth.user.id, params.id)
      if ('abs' in t) return streamFile({ abs: t.abs, seen: t.st, name: t.name, req: c.req.raw, disposition: 'inline', via: c.get('info')?.via })
      // a team-file reference: the bytes were read through the descriptor that was checked (no second open by path)
      const etag = `"${t.etag}"`
      const headers = new Headers({ 'Content-Type': t.mime, 'ETag': etag, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': String(t.bytes.length), 'Content-Disposition': contentDisposition('inline', t.name) })
      if (c.req.header('if-none-match')?.split(',').map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers })
      return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(t.bytes), { status: 200, headers })
    }))

    // ---------------- team files in chats (picker + reference attachments) ----------------
    kit.handle(API.findFiles, ({ c, query, auth }) => mapErrors(c.get('locale'), () => findFiles(svc, auth.user.id, query.q, query.path, query.limit, { folders: query.folders === '1' })))
    kit.handle(API.searchFileContents, ({ c, query, auth }) => mapErrors(c.get('locale'), () => searchFileContents(svc, auth.user.id, query.q, query.path, query.limit, c.req.raw.signal)))
    // the Move picker's "추천" and "최근" (team-files/move-suggest.ts): no AI call, only folders the caller can write
    kit.handle(API.moveSuggestions, ({ c, body, auth }) => mapErrors(c.get('locale'), () => moveSuggestions(svc, auth.user.id, body.paths)))
    kit.handle(API.dismissMoveSuggestion, ({ c, body, auth }) => mapErrors(c.get('locale'), () => dismissMoveSuggestion(svc, auth.user.id, body.paths, body.folder)))
    kit.handle(API.recentFiles, ({ c, query, auth }) => mapErrors(c.get('locale'), () => recentFiles(svc, auth.user.id, query.limit)))
    kit.handle(API.attachTeamFile, ({ c, body, auth }) => mapErrors(c.get('locale'), () => C.teamRefs.create(auth.user.id, body.chatId, body.path)))
    // a chip taken out before sending: a computer upload into a shared chat goes to the trash (uploads/team-refs.ts discard)
    // (a file of a chat shared with people, chat/chat-files.ts: the caller's own unsent one goes, row and bytes)
    kit.handle(API.discardAttachment, ({ c, params, auth }) => mapErrors(c.get('locale'), () => {
      const files = chatFilesOf(ctx)
      const own = files.row(params.id)
      if (own) {
        if (own.user_id !== auth.user.id) throw new HttpError('not_found')
        files.discard(auth.user.id, params.id)
        return { trashed: false }
      }
      return C.teamRefs.discard(auth.user.id, params.id)
    }))

    // ---------------- chunked uploads ----------------
    kit.handle(API.createUploadSession, ({ c, body, auth }) => mapErrors(c.get('locale'), () => C.uploads.create(auth.user.id, body.target, body.size, body.sha256), 'target'))
    kit.handle(API.uploadChunk, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => C.uploads.putChunk(auth.user.id, params.id, Number(params.n), body)))
    kit.handle(API.getUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), () => C.uploads.get(auth.user.id, params.id)))
    kit.handle(API.completeUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), () => C.uploads.complete(auth.user.id, params.id)))
    kit.handle(API.cancelUploadSession, ({ c, params, auth }) => mapErrors(c.get('locale'), async () => { await C.uploads.cancel(auth.user.id, params.id) }))
  },
}
