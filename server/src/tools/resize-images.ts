// resize_images (QA TC-4539, docs/decisions/20261117-resize-photos.md): smaller copies of photos the person may read,
// saved as NEW files next to the originals. The pixels are decoded and encoded only by the Go helper that already
// normalizes images for AI reads (`mycel-safeops resize`, native/internal/safeops/resize.go), in the converter isolation
// (tools/isolate.ts) with time, memory and output limits and the image conversion slots (files/vision.ts). This process
// reads the files, checks access and places the results, as the PDF tools do (tools/pdf-tools.ts):
// - read access to every photo a call names (the same answer for a file that does not exist and one the person cannot
//   open), write access where each copy goes (checked again when placed, make-file.ts placeProduced);
// - by default a free name "<name>-<word>.<ext>" next to the original (the word in the team's language), so nothing is
//   overwritten; the originals are replaced only with replace: true, after a read of each in this turn (a new version,
//   the old one in its history); an `output` that names an existing file the AI did not read gets a conflict copy;
// - every copy carries the bytes of its photo: the wider-audience check of make_file (confirmSources);
// - never into a skill folder.
// JPEG, PNG and WebP only: HEIC and the rest are refused in plain words naming the file.
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { ResizeImagesInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale } from '../admin/settings'
import { ext } from '../files/extract'
import { isHeic } from '../files/heic-preview'
import type { ToolCtx } from '../files/service'
import { readRegular } from '../files/store'
import { imageSlot } from '../files/vision'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { skillRootOf } from '../skills/guard'
import { checkRegular, freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { displaySize } from '../uploads/image'
import { makeWorkDir, runIsolated } from './isolate'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type ResizeIn = z.output<typeof ResizeImagesInput>

/** the word in a copy's default name, "IMG_2041-작게.jpg", in the team's language */
export const RESIZE_WORD: Record<Locale, string> = { ko: '작게', en: 'small', id: 'kecil', ja: '縮小', es: 'reducida', zh: '缩小' }

/** the presets in numbers: side = longest side in pixels, maxBytes = the most a copy may weigh */
export const RESIZE_PRESETS: Record<'smaller' | 'email' | 'web', { side?: number; permille?: number; maxBytes?: number }> = {
  smaller: { permille: 500 },
  email: { side: 1600, maxBytes: 1_000_000 },
  web: { side: 1920, maxBytes: 500_000 },
}

/** the largest photo file worked on (the helper's own limit, safeops.ResizeInputMax: a 48 MP phone JPEG is ~20 MB) */
export const RESIZE_INPUT_MAX = 32 * 1024 * 1024
/** all photos of one call together, checked by size before anything is read */
export const RESIZE_TOTAL_MAX = 200 * 1024 * 1024
/** the largest copy the helper writes (safeops.ResizeOutputMax) */
const RESIZE_OUTPUT_MAX = 48 * 1024 * 1024
const RESIZE_TIMEOUT_MS = 60_000
const RESIZE_RSS_MIB = 1536
const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])

export const RESIZE_IMAGES_DESCRIPTION = 'Make smaller copies of photos (JPEG, PNG, WebP) in the team folder, 1-20 at a time: by the longest side in pixels ' +
  '(longest_side), by the width (width, for "1200 px wide"), by the most each copy may weigh (max_mb, for "under 2MB"; may be combined with a size), ' +
  'or by a preset (preset: "smaller" = half, "email", "web"). The aspect ratio is kept, a photo is never made larger, a phone photo stays upright, ' +
  'and location and other photo details are removed from the copies. Each copy is a new file "<name>-<word>.<ext>" next to its original (or in output_folder; ' +
  'output names the copy of a single photo); the originals stay as they are. A WebP copy is saved as JPEG (PNG when it has see-through parts). ' +
  'HEIC (iPhone) photos cannot be read here: say so plainly and suggest saving them as JPEG first. ' +
  'Replace the originals (replace: true) only when the user explicitly asks for that, after reading each of them.'

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const dims = (s: { width: number; height: number } | null) => (s ? `${s.width}×${s.height}` : 'size unknown')

interface Photo { rel: string; segs: string[]; abs: string; st: fs.Stats; name: string }
interface Made { src: string; made: MadeFile; before: string; after: string; fromWebp: boolean }
export interface ResizeResult { made: Made[]; skipped: string[]; replaced: boolean }

/** The helper's fixed refusal lines (stderr) -> what the AI is told about that photo (never converter text). */
function refusal(line: string, name: string, before: string, size: number, maxBytes: number): string {
  switch (line) {
    case 'resize: unchanged': return `'${name}' is already ${before} (${human(size)}), within what was asked, so no copy was made (a photo is never made larger)`
    case 'resize: unsupported format': return `'${name}' could not be read as a JPEG, PNG or WebP photo`
    case 'resize: pixel limit': return `'${name}' is too large to work on here (over 50 megapixels or a side over 65,535 pixels)`
    case 'resize: byte limit': return `'${name}' is larger than ${RESIZE_INPUT_MAX / 1048576} MB, too large to work on here`
    case 'resize: animated': return `'${name}' is an animated picture; only still photos can be made smaller here`
    case 'resize: size target': return `'${name}' could not be brought under ${human(maxBytes)} without becoming tiny; nothing was saved for it, so suggest a larger size`
    case 'resize: output limit': return `the copy of '${name}' would be over ${RESIZE_OUTPUT_MAX / 1048576} MB; give a smaller size`
    default: return `'${name}' is damaged and could not be read`
  }
}

export async function resizeImages(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: ResizeIn): Promise<ResizeResult> {
  const fx = files.fx
  const rules = files.rules()
  const preset = a.preset ? RESIZE_PRESETS[a.preset] : undefined
  const side = preset?.side ?? a.longest_side ?? 0
  const width = a.width ?? 0
  const permille = preset?.permille ?? 0
  // "2MB" as people mean it: 2,000,000 bytes, so the copy fits either reading of a megabyte
  const maxBytes = preset?.maxBytes ?? (a.max_mb !== undefined ? Math.round(a.max_mb * 1_000_000) : 0)
  if (maxBytes !== 0 && maxBytes < 10_240) throw new ToolError('max_mb must be at least 0.01 (10 KB)')

  // every photo authorized first: a path the person cannot open stops the call before any work
  const photos: Photo[] = []
  const skipped: string[] = []
  let total = 0
  for (const p of a.paths) {
    const r = authorize(fx, rules, c.user, p, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; name the photos in it`, 'is_folder')
    if (photos.some((x) => x.rel === r.rel)) continue
    const name = r.segs[r.segs.length - 1]!
    if (isHeic(name)) { skipped.push(`'${r.rel}' is an HEIC photo (the iPhone's format), which cannot be read here; it can be saved as JPEG first (on the iPhone: share it with "Save as JPEG", or set Settings > Camera > Formats > Most Compatible)`); continue }
    if (!PHOTO_EXT.has(ext(name))) { skipped.push(`'${r.rel}' is not a JPEG, PNG or WebP photo; only those can be made smaller here`); continue }
    const st = checkRegular(r.abs)
    if (st.size > RESIZE_INPUT_MAX) { skipped.push(`'${r.rel}' is larger than ${RESIZE_INPUT_MAX / 1048576} MB, too large to work on here`); continue }
    total += st.size
    if (total > RESIZE_TOTAL_MAX) throw new ToolError(`these photos are more than ${RESIZE_TOTAL_MAX / 1048576} MB together; work on fewer at a time`)
    photos.push({ rel: r.rel, segs: r.segs, abs: r.abs, st, name })
  }
  if (!photos.length) throw new ToolError(`nothing was made smaller: ${skipped.join('; ')}`)

  const replace = a.replace === true
  const word = RESIZE_WORD[teamDefaultLocale(ctx.db)] ?? RESIZE_WORD.en
  const folder = a.output_folder?.trim() ? a.output_folder.trim().replace(/\/+$/, '') : null
  if (replace) {
    for (const ph of photos) {
      if (!c.files.readHashes.has(ph.rel)) throw new ToolError(`to replace '${ph.rel}' (its old version stays in its history), read it in this turn first. Replace it only when the user asked for that; otherwise leave replace out to save a copy next to it`)
      if (ext(ph.name) === 'webp') throw new ToolError(`'${ph.rel}' is a WebP, and its copy is a JPEG or PNG, so it cannot replace the original; leave replace out to save the copy next to it`)
    }
  }
  // where each copy goes, with write access checked now (before any conversion): a read-only place stops the call
  const where = (ph: Photo, e: string) => {
    if (replace) return ph.rel
    if (a.output?.trim()) return a.output.trim().replace(/\/+$/, '')
    const dir = folder ?? ph.segs.slice(0, -1).join('/')
    return `${dir ? dir + '/' : ''}${ph.name.replace(/\.[^.]+$/, '')}-${word}.${e}`
  }
  const allowed = (rel: string, ph: Photo) => {
    const out = authorize(fx, rules, c.user, rel, 'write', { mustExist: replace, createDirs: !replace })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder; give a file name ending in .jpg or .png`, 'is_folder')
    if (skillRootOf(out.rel)) throw new ToolError('a photo copy is not saved in a skill folder; save it in a project or the person\'s own folder')
    if (!replace && out.rel === ph.rel) throw new ToolError(`output is the original '${ph.rel}'; to replace it use replace: true, only when the user asked for that`)
    return out
  }
  for (const ph of photos) allowed(where(ph, ext(ph.name)), ph)

  const tools = ctx.files.visionTools()
  if (!tools.normalizer) throw new ToolError('photos cannot be resized on this server right now (its image helper is missing); nothing was saved')
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    // 1. every copy made (in the work folder, never in memory all at once)
    const done: { ph: Photo; produced: string; e: string; before: string; after: string; fromWebp: boolean }[] = []
    for (const [i, ph] of photos.entries()) {
      c.signal?.throwIfAborted()
      const bytes = readRegular(ph.abs, RESIZE_INPUT_MAX, ph.st).bytes
      ctx.files.quarantine.assertBytes(bytes)
      const before = dims(displaySize(bytes))
      const r = await imageSlot(() => runIsolated({
        cmd: tools.normalizer!, args: ['resize', String(side), String(width), String(permille), String(maxBytes)], stdin: bytes,
        timeoutMs: RESIZE_TIMEOUT_MS, maxRssMiB: RESIZE_RSS_MIB, maxStdout: RESIZE_OUTPUT_MAX + 1, signal: c.signal, env: { GOMAXPROCS: '2' },
      }), c.signal)
      if (r.killed === 'aborted') c.signal?.throwIfAborted()
      if (r.killed) { skipped.push(r.killed === 'workdir' ? `'${ph.rel}' is damaged and could not be read` : `'${ph.rel}' took too long or needed too much memory to make smaller`); continue }
      if (r.code !== 0) { skipped.push(refusal(r.stderr.trim().split('\n')[0] ?? '', ph.rel, before, bytes.length, maxBytes)); continue }
      const out = r.stdout
      const jpeg = out.length > 3 && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff
      const png = out.length > 8 && out.readUInt32BE(0) === 0x89504e47
      if (!jpeg && !png) { skipped.push(`'${ph.rel}' is damaged and could not be read`); continue }
      const e = png ? 'png' : ext(ph.name) === 'jpeg' ? 'jpeg' : 'jpg'
      const produced = path.join(work, `${i}.${e}`)
      fs.writeFileSync(produced, out, { flag: 'wx', mode: 0o600 })
      done.push({ ph, produced, e, before, after: `${dims(displaySize(out))}, ${human(out.length)}; was ${before}, ${human(bytes.length)}`, fromWebp: ext(ph.name) === 'webp' })
    }
    if (!done.length) throw new ToolError(`nothing was made smaller: ${skipped.join('; ')}`)

    // 2. the final names (free ones, also among the copies of this call) and each copy's wider-audience check before
    // any copy is placed, so a "no" leaves nothing behind
    const taken = new Set<string>()
    const key = (n: string) => n.normalize('NFC').toLowerCase()
    const targets = done.map((d) => {
      let rel = where(d.ph, d.e)
      if (!replace) {
        // the copy's own format decides its extension (a WebP becomes .jpg; an output named .webp gets .jpg)
        const wanted = /\.(jpe?g|png)$/i.test(rel) && (d.e === 'png') === /\.png$/i.test(rel) ? rel : `${rel.replace(/\.(jpe?g|png|webp|heic|heif)$/i, '')}.${d.e}`
        const segs = wanted.split('/')
        const dirAbs = path.join(fx.root, ...segs.slice(0, -1))
        const name = a.output?.trim() ? segs.at(-1)! : fs.existsSync(dirAbs) ? freeName(dirAbs, segs.at(-1)!, false, undefined, (n) => taken.has(key(n))) : segs.at(-1)!
        let free = name
        for (let k = 2; taken.has(key(free)); k++) free = name.replace(/(\.[^.]+)$/, ` (${k})$1`)
        taken.add(key(free))
        rel = [...segs.slice(0, -1), free].join('/')
      }
      return allowed(rel, d.ph)
    })
    for (const [i, d] of done.entries()) await confirmSources(ctx, files, c, targets[i]!.rel, targets[i]!.segs, [d.ph.rel])

    // 3. placed one by one; a later one refused (a limit, a rule changed): say which copies are already saved
    const made: Made[] = []
    for (const [i, d] of done.entries()) {
      try {
        made.push({ src: d.ph.rel, made: await placeProduced(ctx, files, c, targets[i]!.segs, d.produced, 'resize_images'), before: d.before, after: d.after, fromWebp: d.fromWebp })
      } catch (e) {
        if (!made.length || !(e instanceof Error)) throw e
        const T = e instanceof Denied ? Denied : ToolError
        throw new T(`${e.message}. Copies already saved: ${made.map((m) => m.made.path).join(', ')}; the others were not saved`)
      }
    }
    return { made, skipped, replaced: replace }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The tool result for the AI: each copy with its new size and link, what was not done, and what to tell the user. */
export function resizeResultText(r: ResizeResult, link: (p: string) => string): string {
  const lines = r.made.map((m) => m.made.conflictCopyOf
    ? `'${m.made.conflictCopyOf}' already exists and was not read in this turn (or changed after the read), so the copy of ${m.src} was saved as '${m.made.path}' (${m.after}). Link for the user: ${link(m.made.path)}. Tell the user about both.`
    : `Saved ${m.made.path} (${m.after}). Link for the user: ${link(m.made.path)}`)
  const replacedAny = r.replaced && r.made.some((m) => m.made.path === m.src && !m.made.conflictCopyOf)
  lines.push(replacedAny
    ? 'These are new versions of the originals; the previous versions are in their file history.'
    : `The original${r.made.length === 1 ? ' is' : 's are'} unchanged.`)
  for (const s of r.skipped) lines.push(`Not done: ${s}.`)
  const webp = r.made.filter((m) => m.fromWebp)
  if (webp.length) lines.push(`${webp.map((m) => `'${m.src}'`).join(', ')} ${webp.length === 1 ? 'is a WebP; its copy is' : 'are WebP; their copies are'} ${webp.every((m) => /\.png$/i.test(m.made.path)) ? 'PNG' : 'JPEG'} (WebP copies cannot be written here); tell the user.`)
  lines.push('Location and other photo details (camera, time taken) were removed from the copies; say in a few words that the location was removed. ' +
    'Tell the user each copy\'s new pixel size and file size, link each copy by its name, and say the originals are untouched' + (replacedAny ? ' (here: replaced, with the old versions in their history)' : '') + '.')
  return lines.join('\n')
}
