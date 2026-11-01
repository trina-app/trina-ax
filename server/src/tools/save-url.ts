// save_url: a file from the web (or one a connected service returned inline) into the team folder, like Claude Code's
// `curl -o` (docs/DECISIONS.md "save_url"). The way an image an AI service generated gets into a page: saved next to
// the HTML, referenced by a relative path (previews show team files only, web/src/lib/frame-files.ts).
//   - Addresses: web_fetch's rules (tools/url-gate.ts): no DNS lookup before the card; typed, allowed and learned
//     addresses open without asking (learned within the link budget), and so do addresses that came back from a
//     connection the person can use in this chat (①c, tools/connection-urls.ts), unless they echo what the AI sent;
//     any other address, a long query or an unknown exit address asks on the server's card.
//   - The download (tools/download.ts): every hop checked and pinned, at most 5 redirects, streamed to a work file. A
//     redirect to an address that echoes what the AI sent in this chat (tools/connection-urls.ts isEcho: a link
//     shortener a connection made, a service's "/out?to=<the AI's address>") asks the person first, whatever opened
//     the first address; in a scheduled run it is not followed.
//     Up to 1 GB it just downloads; over 1 GB (from Content-Length, or reached while streaming: nothing past 1 GB is
//     written before the answer) the person is asked on a card with the size and the server's free disk; in a
//     scheduled run such a file is skipped. No other size limit. The only hard stop is the disk: a download that would
//     leave less than diskReserve() free on the data disk or the team folder's disk is refused, up front and while it
//     streams (the partial file is deleted).
//   - The type comes from the first bytes, never from the site (tools/sniff.ts): PNG, JPEG, GIF, WebP, PDF, MP4, MOV,
//     WebM, MP3, WAV, M4A, AAC, FLAC, Ogg (Vorbis, Opus); the extension is corrected to match. Images up to VISION_INPUT_MAX are also decoded by the isolated
//     normalizer (files/vision.ts) as a check; the original bytes are saved.
//   - Saved through placeProduced like make_file: the person's permissions checked again, never under skills/, a
//     version of a file the AI read in this turn or a conflict copy, the per-turn file count, a file event with the
//     source address, the change published. Before that, the wider-audience card (confirmWidening) when more people
//     can see the folder than what this chat read.
//   - Audit: the tool event names the path, size, type, sha256 and the full address; an `external` event is emitted.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Locale } from '@mycel/shared/api'
import type { SaveUrlInput } from '@mycel/shared'
import type { z } from 'zod'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { normalizeForModel, VISION_INPUT_MAX } from '../files/vision'
import { getMedia, MEDIA_PREFIX } from '../integrations/connections/media'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { inSkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import type { StatFs } from '../system/storage'
import { imageSize } from '../uploads/image'
import { downloadToFile, type DownloadOptions } from './download'
import { egressOf, egressSettled } from './egress'
import { placeProduced } from './make-file'
import { ACCEPTED, refusedName, sniffKind, withExtension, type FileKind } from './sniff'
import { redirectGuard } from './connection-urls'
import { gateUrl } from './url-gate'
import { precheckTarget } from './web-fetch'

/** larger downloads ask the person first (save_url's card) */
export const ASK_ABOVE_BYTES = 1024 ** 3
/** free space a download must leave on the data disk: 10% of the disk, at least 5 GiB, at most 20 GiB */
export const DISK_RESERVE_MIN = 5 * 1024 ** 3
export const DISK_RESERVE_MAX = 20 * 1024 ** 3
export const DISK_RESERVE_FRACTION = 0.1
export function diskReserve(totalBytes: number): number {
  return Math.min(DISK_RESERVE_MAX, Math.max(DISK_RESERVE_MIN, Math.floor(totalBytes * DISK_RESERVE_FRACTION)))
}

export const TEXT = {
  large: {
    ko: 'AI가 큰 파일을 받으려고 해요. 이 파일은 {size}예요. 서버 디스크 여유는 {free}예요. 받을까요?\n\n{url}',
    en: 'The AI wants to download a large file. This file is {size}. The server has {free} of free disk space. Download it?\n\n{url}',
    id: 'AI ingin mengunduh berkas besar. Berkas ini berukuran {size}. Ruang disk server yang masih kosong {free}. Unduh?\n\n{url}',
    ja: 'AIが大きなファイルをダウンロードしようとしています。このファイルは{size}です。サーバーのディスクの空きは{free}です。ダウンロードしますか？\n\n{url}',
    es: 'La IA quiere descargar un archivo grande. Este archivo ocupa {size}. El servidor tiene {free} libres en el disco. ¿Descargarlo?\n\n{url}',
  },
  largeUnknown: {
    ko: 'AI가 받는 파일이 1 GB를 넘었어요. 사이트가 크기를 미리 알려 주지 않았어요(지금까지 {size}). 서버 디스크 여유는 {free}예요. 계속 받을까요?\n\n{url}',
    en: 'The file the AI is downloading has passed 1 GB. The site did not say how large it is ({size} so far). The server has {free} of free disk space. Keep downloading?\n\n{url}',
    id: 'Berkas yang diunduh AI sudah melewati 1 GB. Situs tidak memberi tahu ukurannya ({size} sejauh ini). Ruang disk server yang masih kosong {free}. Lanjutkan mengunduh?\n\n{url}',
    ja: 'AIがダウンロード中のファイルが1 GBを超えました。サイトはサイズを事前に知らせていません（ここまで{size}）。サーバーのディスクの空きは{free}です。ダウンロードを続けますか？\n\n{url}',
    es: 'El archivo que la IA está descargando ya pasó de 1 GB. El sitio no indicó su tamaño ({size} hasta ahora). El servidor tiene {free} libres en el disco. ¿Seguir descargando?\n\n{url}',
  },
  allow: { ko: '받기', en: 'Download', id: 'Unduh', ja: 'ダウンロード', es: 'Descargar' },
  deny: { ko: '그만두기', en: 'Stop', id: 'Batalkan', ja: 'やめる', es: 'Cancelar' },
  redirectEcho: {
    ko: 'AI가 저장하려는 주소가 다른 주소로 넘어가요. 그런데 넘어가는 주소(또는 그 일부)가 AI가 앞서 이 대화에서 도구에 보낸 내용과 같아요. 짧은 주소 서비스처럼 서비스가 받은 내용을 되돌려 준 것일 수 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The address the AI is saving from redirects to another one, and that address (or part of it) matches what the AI had sent to a tool earlier in this conversation. A service may have kept what it was sent and given it back (like a link shortener), so check the whole address:\n\n{url}',
    id: 'Alamat yang ingin disimpan AI dialihkan ke alamat lain, dan alamat itu (atau sebagiannya) sama dengan isi yang dikirim AI ke sebuah alat sebelumnya di percakapan ini. Layanan mungkin menyimpan apa yang dikirim kepadanya lalu mengembalikannya (seperti pemendek tautan), jadi periksa seluruh alamatnya:\n\n{url}',
    ja: 'AIが保存しようとしているアドレスは別のアドレスに転送されます。転送先のアドレス（またはその一部）は、この会話でAIが先にツールへ送った内容と一致します。短縮URLサービスのように、サービスが受け取った内容を返した可能性があるため、アドレス全体を確認してください：\n\n{url}',
    es: 'La dirección desde la que la IA quiere guardar redirige a otra, y esa dirección (o parte de ella) coincide con lo que la IA envió antes a una herramienta en esta conversación. Un servicio puede haber guardado lo que recibió y devolverlo (como un acortador de enlaces); revise la dirección completa:\n\n{url}',
  },
  diskFull: {
    ko: '서버 디스크 여유가 {free}밖에 없어요. 이 파일{size}을 받으면 디스크에 꼭 남겨 둬야 하는 {reserve}보다 적게 남아서 받지 않았어요. 파일이나 휴지통을 정리한 뒤 다시 해 주세요.',
    en: 'The server has only {free} of free disk space. Downloading this file{size} would leave less than the {reserve} that must stay free, so it was not downloaded. Free up space (files, trash) and try again.',
    id: 'Ruang disk server yang kosong hanya {free}. Jika berkas ini{size} diunduh, sisa ruang akan kurang dari {reserve} yang harus tetap kosong, jadi berkas tidak diunduh. Kosongkan ruang (berkas, tempat sampah) lalu coba lagi.',
    ja: 'サーバーのディスクの空きは{free}しかありません。このファイル{size}をダウンロードすると、必ず空けておく{reserve}を下回るため、ダウンロードしませんでした。ファイルやゴミ箱を整理してから、もう一度お試しください。',
    es: 'El servidor solo tiene {free} libres en el disco. Descargar este archivo{size} dejaría menos de los {reserve} que deben quedar libres, así que no se descargó. Libere espacio (archivos, papelera) e inténtelo de nuevo.',
  },
  diskFullStreaming: {
    ko: '받는 중에 서버 디스크 여유가 {free}로 줄었어요. 디스크에 꼭 남겨 둬야 하는 {reserve}에 가까워져서 받기를 멈추고, 받던 파일은 지웠어요. 파일이나 휴지통을 정리한 뒤 다시 해 주세요.',
    en: 'While downloading, the server\'s free disk space went down to {free}. That is close to the {reserve} that must stay free, so the download was stopped and the partial file deleted. Free up space (files, trash) and try again.',
    id: 'Saat mengunduh, ruang disk server yang kosong turun menjadi {free}. Itu mendekati {reserve} yang harus tetap kosong, jadi unduhan dihentikan dan berkas yang belum selesai dihapus. Kosongkan ruang (berkas, tempat sampah) lalu coba lagi.',
    ja: 'ダウンロード中にサーバーのディスクの空きが{free}まで減りました。必ず空けておく{reserve}に近づいたため、ダウンロードを止めて途中のファイルを削除しました。ファイルやゴミ箱を整理してから、もう一度お試しください。',
    es: 'Durante la descarga, el espacio libre del servidor bajó a {free}. Eso se acerca a los {reserve} que deben quedar libres, así que se detuvo la descarga y se borró el archivo incompleto. Libere espacio (archivos, papelera) e inténtelo de nuevo.',
  },
} satisfies Record<string, Record<Locale, string>>

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)
export const humanBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`

/** Test hooks (never from the model's input): the download's test allowances, the disk and the image check. */
export interface SaveUrlOptions extends Pick<DownloadOptions, 'lookup' | 'testAllow' | 'insecureTlsForTests' | 'connectTimeoutMs' | 'idleTimeoutMs' | 'roomStep' | 'totalTimeoutMs'> {
  statfs?: (p: string) => StatFs
  normalize?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>
  askAbove?: number
}

type Input = z.output<typeof SaveUrlInput>

const cleanName = (s: string) => {
  let n = s
  try { n = decodeURIComponent(s) } catch { /* as written */ }
  n = n.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 100)
  return n && !badSegment(n) ? n : ''
}
/** A file name from an address: its last path segment, cleaned; '' when it has none. */
export function nameFromUrl(url: string): string {
  try { return cleanName(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') } catch { return '' }
}

/** Free space and the reserve of the file systems a download lands on (the work folder's and the team folder's). */
function disks(dirs: string[], statfs: (p: string) => StatFs): { free: number; reserve: number }[] {
  const seen = new Set<number>()
  const out: { free: number; reserve: number }[] = []
  for (const d of dirs) {
    let dev = -1
    try { dev = fs.statSync(d).dev } catch { /* measured anyway */ }
    if (dev >= 0 && seen.has(dev)) continue
    seen.add(dev)
    let s: StatFs
    try { s = statfs(d) } catch { continue }
    const free = Number(s.bavail) * Number(s.bsize)
    out.push({ free, reserve: diskReserve(Number(s.blocks) * Number(s.bsize)) })
  }
  return out
}

/** Run save_url (the registered tool calls this; tests call it with their hooks). */
export async function saveUrl(ctx: AppContext, a: Input, t: ToolCtx, o: SaveUrlOptions = {}): Promise<{ text: string; summary: string; structured: Record<string, unknown> }> {
  if (!t.turnId) throw new ToolError('save_url only works inside a chat turn')
  const turn = ctx.db.query('SELECT chat_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; user_id: string } | null
  if (!turn) throw new ToolError('unknown turn')
  if (turn.user_id !== t.user.id) throw new Denied('turn belongs to another person')
  const chatId = turn.chat_id
  const files = componentC(ctx).files
  const L: Locale = t.person?.locale ?? 'en'
  const statfs = o.statfs ?? ((p: string) => fs.statfsSync(p))
  const handle = a.url.trim().startsWith(MEDIA_PREFIX)
  const source = a.url.trim()

  // where it goes: an explicit path (a folder when it ends in "/"), or the person's own folder
  const wanted = a.save_as?.trim().replace(/^\/+/, '').normalize('NFC')
  const folderOnly = !wanted || wanted.endsWith('/')
  const explicitFolder = wanted ? (folderOnly ? wanted.replace(/\/+$/, '') : wanted.split('/').slice(0, -1).join('/')) : null
  if (wanted && inSkills(wanted)) throw new ToolError('files cannot be saved under skills/ (team skills and rules); pick another folder')
  const firstName = wanted && !folderOnly ? wanted.split('/').pop()! : (handle ? '' : nameFromUrl(source))
  const provisional = explicitFolder !== null ? [explicitFolder, firstName || 'download'].filter(Boolean).join('/') : null
  if (provisional !== null) {
    // refused before anything is fetched: a path the person cannot write (placeProduced checks again at the end)
    const r = authorize(files.fx, files.rules(), t.user, provisional, 'write', { mustExist: false, createDirs: true })
    if (r.exists && r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; give a file name or end the path with "/"`)
  }
  // the wider-audience card before the download (the person is not asked after a long one), after the address card
  const own = (p: string) => p.startsWith(`users/${t.user.id}/`)
  const widen = async () => {
    if (provisional === null) return
    // without a turn's wider-audience check (nobody to ask) only the person's own folder: like make_file, fail closed
    if (!t.confirmWidening && !own(provisional)) throw new ToolError('outside a chat this can only save into your own folder (users/<you>/)')
    const refusal = await t.confirmWidening?.(provisional, [])
    if (refusal) throw new ToolError(refusal)
  }

  const workRoot = path.join(ctx.engineConfig.dataDir, 'work')
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const work = fs.mkdtempSync(path.join(workRoot, 'save-url-'))
  const tmp = path.join(work, 'body')
  const room = (more: number, streaming: boolean) => {
    for (const d of disks([work, ctx.engineConfig.teamRoot], statfs)) {
      if (d.free - more >= d.reserve) continue
      // the size in brackets when it is known ("this file (3.2 GB)"; no space before the bracket in Korean, full-width in Japanese)
      const sized = more ? (L === 'ja' ? `（${humanBytes(more)}）` : L === 'ko' ? `(${humanBytes(more)})` : ` (${humanBytes(more)})`) : ''
      const words = fill(TEXT[streaming ? 'diskFullStreaming' : 'diskFull'][L], { free: humanBytes(d.free), size: sized, reserve: humanBytes(d.reserve) })
      throw new ToolError(`the server's disk has too little free space for this download (${humanBytes(d.free)} free, ${humanBytes(d.reserve)} must stay free), so nothing was saved. Tell the user: "${words}"`, 'storage_full')
    }
  }
  try {
    let kind: FileKind | null = null
    let first: Buffer
    let size: number
    let sha: string
    let from: string
    let confirmed = ''
    let openEnded = false
    if (handle) {
      const item = getMedia(ctx.engineConfig.dataDir, chatId, t.user.id, source)
      if (!item) throw new ToolError(`no file ${source.slice(0, 60)} in this chat: an mcp-file handle works only in the chat whose connection answer named it, for 24 hours. Call the service again to get the file`)
      await widen()
      room(item.meta.size, false)
      fs.copyFileSync(item.file, tmp, fs.constants.COPYFILE_EXCL)
      const fd = fs.openSync(tmp, 'r')
      try { first = Buffer.alloc(Math.min(64, item.meta.size)); fs.readSync(fd, first, 0, first.length, 0) } finally { fs.closeSync(fd) }
      kind = judge(first, item.meta.declared)
      size = item.meta.size
      sha = item.meta.sha256
      from = source
    } else {
      // the address rules that need no lookup, then where it came from (the card), then the download
      const blockedIps = () => egressOf(ctx).ips
      precheckTarget(source, { testAllow: o.testAllow, blockedIps })
      await egressSettled(ctx)
      const how = await gateUrl(ctx.db, chatId, source, t.person ?? null, { egressKnown: egressOf(ctx).known, turnId: t.turnId, userId: t.user.id, connection: true })
      if (how === 'confirmed') confirmed = ' (address confirmed by the user)'
      else if (how === 'site') confirmed = ' (site allowed in this chat)'
      await widen()
      let largeOk = false
      // a redirect to an address that echoes what the AI sent (a link shortener or a service's "/out?to=" given the
      // AI's address): the person decides, whatever opened the first address (tools/connection-urls.ts redirectGuard,
      // shared with web_fetch)
      const redirects = redirectGuard(ctx.db, chatId, source, t.person ?? null, {
        ask: TEXT.redirectEcho,
        unattended: 'the address redirected to one that matches what the AI had sent to a tool earlier in this chat (a service may have kept it and given it back, like a link shortener), which needs a person to confirm it, and nobody can confirm it here, so nothing was saved',
        declined: 'the user did not allow following the redirect, so nothing was saved. Do not try to get it another way; ask the user what they want',
      })
      const r = await downloadToFile(source, tmp, {
        lookup: o.lookup, testAllow: o.testAllow, insecureTlsForTests: o.insecureTlsForTests, connectTimeoutMs: o.connectTimeoutMs, idleTimeoutMs: o.idleTimeoutMs, roomStep: o.roomStep, totalTimeoutMs: o.totalTimeoutMs,
        blockedIps, signal: t.signal,
        askAbove: o.askAbove ?? ASK_ABOVE_BYTES,
        onLarge: async ({ size: total, received }) => {
          const shown = humanBytes(total ?? received)
          if (!t.person || t.person.unattended) throw new ToolError(`this file is ${total === null ? 'over' : ''} ${shown}, larger than ${humanBytes(o.askAbove ?? ASK_ABOVE_BYTES)}, and a download that large needs the user's OK, which nobody can give here (a scheduled run), so it was skipped and nothing was saved. Say so in the summary; the user can ask for it in a chat`.replace(/ {2,}/g, ' '))
          const free = Math.min(...disks([work, ctx.engineConfig.teamRoot], statfs).map((d) => d.free))
          const question = fill(TEXT[total === null ? 'largeUnknown' : 'large'][L], { size: shown, free: Number.isFinite(free) ? humanBytes(free) : '?' }).replace('{url}', () => source.length > 2000 ? source.slice(0, 2000) + '…' : source)
          if (!(await t.person.confirm(question, TEXT.allow[L], TEXT.deny[L]))) throw new ToolError(`the user chose not to download this ${shown} file, so nothing was saved. Do not try to get it another way; ask the user what they want`)
          largeOk = true
        },
        onRedirect: redirects.check,
        room: (more) => room(more, fs.existsSync(tmp)),
        sniff: (b, ct) => { kind = judge(b, ct) },
      })
      if (redirects.confirmed()) confirmed += ' (redirect confirmed by the user)'
      if (largeOk) confirmed += ' (large file confirmed by the user)'
      ctx.files.events.emit('external', { turnId: t.turnId, userId: t.user.id, source: 'save_url', url: r.url })
      first = r.first
      size = r.size
      sha = r.sha256
      from = r.url
      openEnded = r.openEnded
    }
    const k = kind as FileKind | null
    if (!k) throw new ToolError('internal: no file type')
    const notes: string[] = []
    // images: decoded by the isolated normalizer as a check (a file that only starts like a PNG is refused)
    let dims: { width: number; height: number } | null = null
    if (k.image) {
      const head = Buffer.alloc(Math.min(size, 1024 * 1024))
      const fd = fs.openSync(tmp, 'r')
      try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
      dims = imageSize(head)
      if (size > VISION_INPUT_MAX) notes.push(`The image is larger than ${humanBytes(VISION_INPUT_MAX)}, so it was checked by its first bytes only, not decoded.`)
      else {
        try { await (o.normalize ?? ((b: Uint8Array, s?: AbortSignal) => normalizeForModel(b, ctx.files.visionTools(), s)))(fs.readFileSync(tmp), t.signal) } catch (e) {
          t.signal?.throwIfAborted()
          const code = e instanceof ToolError ? e.code : ''
          if (code === 'vision_too_large' || code === 'vision_heavy') notes.push('The image has too many pixels to be decoded as a check, so it was checked by its first bytes only.')
          else if (code === 'vision_unavailable') throw new ToolError('images cannot be saved on this server: its image check (mycel-safeops) is not installed. Tell the user; an admin can reinstall the server')
          else throw new ToolError(`the file starts like a ${k.label} image but could not be decoded as one (damaged, or not really an image), so it was not saved`)
        }
      }
    }
    // a non-image body the site gave no length for (not chunked either) ends only at the connection close: a cut-off
    // cannot be told from a complete file, and unlike an image it is not decoded as a check, so say completeness is
    // unverified (images above already fail the decode check when truncated)
    if (!k.image && openEnded) notes.push(`The site did not send the file's length (the connection just closed), so there is no way to confirm the ${k.label} file is complete; if it will not open, download it again.`)
    // the name: the one asked for, or the address's, with the extension of what the file really is
    const baseName = firstName || (handle ? `${k.media === 'image' ? 'image' : 'file'}-${crypto.randomBytes(3).toString('hex')}` : 'download')
    const named = withExtension(baseName, k)
    if (named.changed && wanted && !folderOnly) notes.push(`Saved with the extension .${k.ext}: the file is ${k.label} (judged by its bytes), not what "${baseName}" said.`)
    const folder = explicitFolder ?? `users/${t.user.id}/${k.image ? 'images' : 'downloads'}`
    const target = [folder, named.name].filter(Boolean).join('/')
    if (!t.confirmWidening && !own(target)) throw new ToolError('outside a chat this can only save into your own folder (users/<you>/)')
    if (explicitFolder === null) {
      const refusal = await t.confirmWidening?.(target, [])
      if (refusal) throw new ToolError(refusal)
    }
    if (inSkills(target)) throw new ToolError('files cannot be saved under skills/ (team skills and rules); pick another folder')
    const made = await placeProduced(ctx, files, t, target.split('/').filter(Boolean), tmp, 'save_url', undefined, { turnBytes: false, detail: { url: from.slice(0, 4000), type: k.mime } })
    if (made.conflictCopyOf) notes.push(`${made.conflictCopyOf} already existed and was not read in this turn, so this was saved as a copy next to it; the original is unchanged.`)
    const what = [k.label, dims ? `${dims.width}×${dims.height}` : '', humanBytes(size)].filter(Boolean).join(', ')
    const rel = made.path
    const pageHint = k.image || k.media === 'video' || k.media === 'audio'
      ? ` To show it in an HTML page, reference it by a path relative to the page (for a page in ${rel.split('/').slice(0, -2).join('/') || 'the team root'}: "${rel.split('/').slice(-2).join('/')}"); previews show only team files.`
      : ''
    return {
      text: [`Saved ${handle ? source : from} as ${rel} (${what}).${pageHint}`, ...notes].join('\n'),
      summary: `save_url -> ${rel} (${size} B, ${k.mime}, sha256 ${sha}) from ${from}${from !== source ? ` (asked for ${source})` : ''}${confirmed}`.slice(0, 9000),
      structured: { url: from, path: rel, size, sha256: sha, type: k.mime, ...(made.conflictCopyOf ? { conflictCopyOf: made.conflictCopyOf } : {}) },
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The kind of a file from its first bytes, or a refusal that says what it is instead. */
function judge(first: Buffer, declared: string): FileKind {
  const k = sniffKind(first)
  if (k) return k
  const name = refusedName(first)
  const said = declared ? `; the source said ${declared.split(';')[0]!.trim().slice(0, 60)}` : ''
  throw new ToolError(`save_url takes ${ACCEPTED}. This file is ${name ?? 'none of these'} (judged by its first bytes${said}), so it was not saved`)
}

export const SAVE_URL_DESCRIPTION =
  'Download a file into the team folder, like `curl -o`: an image, PDF, video or audio file at an http(s) address, or a file a connected service returned ' +
  'inline (the mcp-file:<id> handle in its answer). Use it right away for what an image or video service generated (its result links expire), and to put ' +
  'images into HTML: save the image next to the page (save_as "landing/images/hero.png") and reference it by a relative path (<img src="images/hero.png"> in ' +
  'landing/index.html). Previews show only team files: web addresses in a page stay blocked. Takes PNG, JPEG, GIF and WebP images, PDF, MP4, MOV and WebM video, MP3, ' +
  'WAV, M4A, AAC, FLAC and Ogg / Opus audio, judged by the file\'s bytes (the extension is corrected); not SVG, HTML, archives or programs. The address rules are web_fetch\'s: ' +
  'addresses from this conversation (typed by the user, search results, links of fetched pages, answers of connected services) open without asking within ' +
  'a budget, others are shown to the user first. Files over 1 GB ask the user first.'
