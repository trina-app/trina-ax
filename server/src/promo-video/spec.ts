// Checking the slots the AI filled for a promo video (docs/DECISIONS.md "V"), before any frame is built. Every problem
// is listed at once, in words the AI can act on, so one rewrite can fix them all:
// - lengths: every line must fit its place (measured with the bundled font, layout.ts fitDoc);
// - numbers: every number on screen must be written in the material (the files named in `sources`), and each proof
//   number exactly as written there, sign and unit included (whitespace aside); a number only the AI's arithmetic
//   made is refused;
// - pictures and the logo: team files the person can read, inside a brand folder (groups/<team>/브랜드/… or
//   shared/브랜드/…, the folder name in any language), PNG, JPEG or WebP by their bytes, big enough, each picture once;
// - the style: one that fits the brand colour (palette.ts); another one is replaced, not refused;
// - colours: "#rrggbb" only (the schema), the website: written in the material or the saved company profile.
import path from 'node:path'
import { PACK_FOLDERS, type Locale, type PromoVideoInput } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { extractText } from '../files/extract'
import { readRegular } from '../files/store'
import { authorize } from '../policy/authorize'
import { imageSize } from '../uploads/image'
import { readCompanyProfile } from '../onboarding/profile'
import { fitDoc, plain, type LogoPic, type Pic, type VideoDoc } from './layout'
import { fittingFamilies, paletteFor, type Family } from './palette'
import { logoTreat } from './logo'

/** a picture's short side, at least (a smaller one would be blown up in a 1080 px frame) */
export const PICTURE_MIN_PX = 600
export const LOGO_MIN_PX = 64
const PICTURE_MAX_BYTES = 20 * 1024 * 1024
const SOURCE_MAX_BYTES = 60 * 1024 * 1024
/** of each source's text, at most (a long deck's text is plenty for finding a number) */
const SOURCE_TEXT_MAX = 400_000
/** the music that goes with each style when the AI names none */
const STYLE_MUSIC: Record<Family, VideoDoc['music']> = { ink: 'bright', deep: 'calm', mono: 'pulse' }

const BRAND_NAMES = new Set(Object.values(PACK_FOLDERS.brand).map((n) => n.normalize('NFC')))
/** Is this team path inside a brand folder: groups/<group>/<브랜드>/… or shared/<브랜드>/… (any language's name)? */
export function inBrandFolder(rel: string): boolean {
  const seg = rel.normalize('NFC').split('/').filter(Boolean)
  if (seg[0] === 'groups' && seg.length > 3 && BRAND_NAMES.has(seg[2]!)) return true
  return seg[0] === 'shared' && seg.length > 2 && BRAND_NAMES.has(seg[1]!)
}

function kindOf(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp'
  return null
}

/** NFKC, no whitespace: "18 %" and "18%" read the same (the proof number's exact check) */
export const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')
/** NFKC, whitespace as single spaces (the check of every other number: "bills. 87" must not read as ".87") */
export const spaced = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ')
const DIGITS = /\d+(?:[.,]\d+)*/g
/** The numbers of a text as written ("1,200", "3.5", "2025"). */
export const numbersIn = (s: string) => [...s.normalize('NFKC').matchAll(DIGITS)].map((m) => m[0])
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `token` stands in `text` as a whole number (not part of a longer one: "87" is not in "1,870" nor in "3.87"). */
export function hasNumber(text: string, token: string): boolean {
  return new RegExp(`(?<!\\d)(?<!\\d[.,])${escRe(token)}(?!\\d)(?![.,]\\d)`).test(text)
}
/** A stat as written, its sign read loosely: "×5" is also "x5" or "5배" is not (the unit must be written). */
const signVariants = (n: string) => {
  const s = squash(n)
  const out = new Set([s])
  if (/^[×xX]/.test(s)) for (const p of ['×', 'x', 'X']) out.add(p + s.slice(1))
  return [...out]
}

export interface CheckedSpec { doc: VideoDoc; sources: string[]; pictures: string[] }
export type CheckResult = { ok: true; spec: CheckedSpec } | { ok: false; problems: string[] }

/** The text of the source files (each as the read tool sees it), squashed for the number check. */
async function sourceText(ctx: AppContext, t: ToolCtx, list: string[], problems: string[]): Promise<{ text: string; tight: string; paths: string[] }> {
  const parts: string[] = []
  const paths: string[] = []
  for (const raw of list) {
    const p = raw.replace(/^\/+/, '')
    try {
      const r = authorize(ctx.files.fx, ctx.files.rules(), t.user, p, 'read', { mustExist: true })
      if (!r.st?.isFile()) { problems.push(`source "${raw}" is not a file`); continue }
      const { bytes } = readRegular(r.abs, SOURCE_MAX_BYTES)
      const text = await extractText(r.rel, bytes, { pandoc: ctx.engineConfig.pandoc, pdftotext: ctx.engineConfig.pdftotext, ocr: ctx.engineConfig.ocr, quarantine: ctx.files.quarantine }, t.signal)
      parts.push(text.slice(0, SOURCE_TEXT_MAX))
      paths.push(r.rel)
    } catch (e) {
      problems.push(`source "${raw}" could not be read (${e instanceof Error ? e.message : 'error'}); name the team files the words came from`)
    }
  }
  const all = parts.join('\n')
  return { text: spaced(all), tight: squash(all), paths }
}

interface Read { rel: string; bytes: Buffer; kind: 'png' | 'jpg' | 'webp'; width: number; height: number }
/** A picture or the logo: readable, in a brand folder, a real PNG / JPEG / WebP of at least `min` px. */
function readPicture(ctx: AppContext, t: ToolCtx, raw: string, min: number, what: string, problems: string[]): Read | null {
  const p = raw.replace(/^\/+/, '')
  let rel: string
  let bytes: Buffer
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), t.user, p, 'read', { mustExist: true })
    if (!r.st?.isFile()) throw new Error('not a file')
    rel = r.rel
    bytes = Buffer.from(readRegular(r.abs, PICTURE_MAX_BYTES).bytes)
  } catch {
    problems.push(`${what}: "${raw}" is not a picture this person can open; use a file from the brand images folder or leave it out`)
    return null
  }
  if (!inBrandFolder(rel)) { problems.push(`${what}: "${raw}" is not in a brand folder; only pictures from the team's brand images folder (…/브랜드/이미지/) can go into the video`); return null }
  const kind = kindOf(bytes)
  const size = kind ? imageSize(bytes) : null
  if (!kind || !size) { problems.push(`${what}: "${raw}" is not a PNG, JPEG or WebP picture`); return null }
  if (Math.min(size.width, size.height) < min) { problems.push(`${what}: "${raw}" is too small (${size.width}×${size.height}; at least ${min} px on the short side); leave it out${what === 'logo' ? '' : ' and that beat is made with type and light'}`); return null }
  return { rel, bytes, kind, ...size }
}
const FOCUS: Record<string, string> = { center: 'center', top: 'center 20%', bottom: 'center 80%', left: '20% center', right: '80% center' }

const host = (s: string) => {
  const t = s.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').toLowerCase()
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(t) ? t : null
}

/** Check the slots; with no problem, the document to build. */
export async function checkPromoInput(ctx: AppContext, t: ToolCtx, a: PromoVideoInput, lang: Locale): Promise<CheckResult> {
  const problems: string[] = []
  const src = await sourceText(ctx, t, a.sources, problems)
  // the website: from the material or the saved company profile (shown as its host only)
  let website: string | null = null
  if (a.website) {
    const h = host(a.website)
    const profile = (() => { try { return readCompanyProfile(ctx.files, t.user) } catch { return null } })()
    const known = (profile?.website && host(profile.website) === h) || (h && src.text.toLowerCase().includes(h))
    if (!h) problems.push(`website "${a.website}" is not a web address; give the host, e.g. acme.co.kr, or leave it out`)
    else if (!known) problems.push(`website "${a.website}" is not written in the sources or the company profile; leave it out`)
    else website = h
  }
  // the style: among those that fit the brand colour
  const brand = a.brand_color ? a.brand_color.toLowerCase() : null
  const fits = fittingFamilies(brand)
  const family: Family = a.style && fits.includes(a.style) ? a.style : fits[0]!
  // pictures: each once
  const used = new Set<string>()
  const pic = (raw: string | undefined, focus: string | undefined, what: string): Pic | null => {
    if (!raw) return null
    const r = readPicture(ctx, t, raw, PICTURE_MIN_PX, what, problems)
    if (!r) return null
    if (used.has(r.rel)) { problems.push(`${what}: "${raw}" is already used by another beat; use another picture or none`); return null }
    used.add(r.rel)
    return { src: '/' + r.rel, width: r.width, height: r.height, focus: FOCUS[focus ?? 'center'] ?? 'center' }
  }
  let logo: LogoPic | null = null
  if (a.logo) {
    const r = readPicture(ctx, t, a.logo, LOGO_MIN_PX, 'logo', problems)
    if (r) logo = { src: '/' + r.rel, width: r.width, height: r.height, focus: 'center', treat: await logoTreat(r.bytes, r.kind, paletteFor(family, brand).ground) }
  }
  const h = a.hook
  const before = h.before.trim(), after = h.after.trim()
  if (squash(before) === squash(after)) problems.push('hook: "before" and "after" must say different things (the old state and the new one)')
  const stats = (a.proof.stats ?? []).map((s) => ({ number: s.number.trim(), label: s.label.trim() }))
  for (const [i, s] of stats.entries()) {
    if (!/\d/.test(s.number)) problems.push(`proof.stats[${i}].number "${s.number}" has no digit; give a number written in the material`)
    else if (!signVariants(s.number).some((v) => src.tight.includes(v))) problems.push(`proof.stats[${i}].number "${s.number}" is not written in the sources exactly like that; copy the number with its sign and unit as the material writes it (never counted, computed or rounded)`)
  }
  const accentProblem = (where: string, lines: string[]) => {
    for (const l of lines) {
      const stars = (l.match(/\*/g) ?? []).length
      if (stars % 2 || stars > 2) problems.push(`${where}: mark at most one key phrase per line with a pair of *stars*`)
      if (/[.。]$/.test(plain(l)) && !/\.\.\.$|…$/.test(plain(l))) problems.push(`${where}: no full stop at the end of a headline line`)
    }
  }
  accentProblem('promise.headline', a.promise.headline)
  accentProblem('work.headline', a.work.headline)
  accentProblem('proof.headline', a.proof.headline ?? [])
  if (!stats.length && !(a.proof.headline ?? []).length) problems.push('proof: give one or two numbers from the material, or (without any) the most concrete fact as proof.headline')
  const doc: VideoDoc = {
    family, lang, company: a.company.trim(), website, brand, logo, music: a.music ?? STYLE_MUSIC[family],
    hook: { label: h.label.trim(), before, after, line: h.line?.trim() ?? '', mode: h.mode ?? (/\d/.test(after) ? 'strike' : 'swap') },
    promise: { headline: a.promise.headline.map((l) => l.trim()), sub: a.promise.sub?.trim() ?? '', picture: pic(a.promise.picture, a.promise.focus, 'promise.picture') },
    work: { kicker: a.work.kicker.trim(), headline: a.work.headline.map((l) => l.trim()), points: (a.work.points ?? []).map((p) => p.trim()).filter(Boolean), picture: pic(a.work.picture, a.work.focus, 'work.picture') },
    proof: { stats, headline: (a.proof.headline ?? []).map((l) => l.trim()).filter(Boolean), sub: a.proof.sub?.trim() ?? '', picture: pic(a.proof.picture, a.proof.focus, 'proof.picture') },
    cta: { line: a.cta.line.trim(), offer: a.cta.offer?.trim() ?? '' },
  }
  // every number on screen, written in the material
  const onScreen: [string, string][] = [
    ['hook', doc.hook.label], ['hook', doc.hook.before], ['hook', doc.hook.after], ['hook', doc.hook.line],
    ...doc.promise.headline.map((l) => ['promise', plain(l)] as [string, string]), ['promise', doc.promise.sub],
    ['work', doc.work.kicker], ...doc.work.headline.map((l) => ['work', plain(l)] as [string, string]), ...doc.work.points.map((p) => ['work', p] as [string, string]),
    ...stats.flatMap((s) => [['proof', s.number], ['proof', s.label]] as [string, string][]), ...doc.proof.headline.map((l) => ['proof', plain(l)] as [string, string]), ['proof', doc.proof.sub],
    ['cta', doc.cta.line], ['cta', doc.cta.offer], ['company', doc.company],
  ]
  for (const [where, text] of onScreen) {
    for (const n of new Set(numbersIn(text))) if (!hasNumber(src.text, n)) problems.push(`${where}: the number "${n}" is not in the sources; use only numbers written in the material, as written`)
  }
  problems.push(...fitDoc(doc).problems)
  if (problems.length) return { ok: false, problems: [...new Set(problems)] }
  return { ok: true, spec: { doc, sources: src.paths, pictures: [...used, ...(logo ? [logo.src.slice(1)] : [])] } }
}

/** The team path behind a picture's `src` ("/groups/…" → "groups/…"). */
export const teamPathOf = (src: string) => src.replace(/^\/+/, '')
export const pictureExt = (rel: string) => path.extname(rel).toLowerCase().replace(/^\./, '') || 'jpg'
