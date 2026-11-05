// Checking the slots the AI filled for a promo video (docs/DECISIONS.md "V"), before any frame is built. Every problem
// is listed at once, in words the AI can act on, so one rewrite can fix them all:
// - lengths: every line must fit its box in the chosen style (measured with the bundled font, layout.ts fitScene);
// - numbers: every number on screen must be written in the material (the files named in `sources`), and the proof
//   number exactly as written there, unit included (whitespace aside); a number that only the AI's arithmetic made is
//   refused;
// - pictures and the logo: team files the person can read, inside a brand folder (groups/<team>/브랜드/… or
//   shared/브랜드/…, the folder name in any language), PNG, JPEG or WebP by their bytes, big enough for the frame, each
//   picture once;
// - colours: "#rrggbb" only (the schema), the website: written in the material or the saved company profile.
import path from 'node:path'
import { PACK_FOLDERS, PROMO_STYLES, type Locale, type PromoVideoInput } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { extractText } from '../files/extract'
import { readRegular } from '../files/store'
import { authorize } from '../policy/authorize'
import { imageSize } from '../uploads/image'
import { readCompanyProfile } from '../onboarding/profile'
import { fitScene, SCENE_KINDS, type PromoDoc, type PromoPicture, type PromoScene, type SceneKind } from './layout'

/** a content picture's short side, at least (a smaller one would be blown up on a 1080 px frame) */
export const PICTURE_MIN_PX = 600
export const LOGO_MIN_PX = 64
const PICTURE_MAX_BYTES = 20 * 1024 * 1024
const SOURCE_MAX_BYTES = 60 * 1024 * 1024
/** of each source's text, at most (a long deck's text is plenty for finding a number) */
const SOURCE_TEXT_MAX = 400_000

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

export interface CheckedSpec { doc: PromoDoc; sources: string[]; pictures: string[] }
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

/** A picture or the logo: readable, in a brand folder, a real PNG / JPEG / WebP of at least `min` px. */
function picture(ctx: AppContext, t: ToolCtx, raw: string, focus: string | undefined, min: number, what: string, problems: string[]): (PromoPicture & { rel: string }) | null {
  const p = raw.replace(/^\/+/, '')
  let rel: string
  let bytes: Uint8Array
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), t.user, p, 'read', { mustExist: true })
    if (!r.st?.isFile()) throw new Error('not a file')
    rel = r.rel
    bytes = readRegular(r.abs, PICTURE_MAX_BYTES).bytes
  } catch {
    problems.push(`${what}: "${raw}" is not a picture this person can open; use a file from the brand images folder or leave it out`)
    return null
  }
  if (!inBrandFolder(rel)) { problems.push(`${what}: "${raw}" is not in a brand folder; only pictures from the team's brand images folder (…/브랜드/이미지/) can go into the video`); return null }
  const kind = kindOf(bytes)
  const size = kind ? imageSize(bytes) : null
  if (!kind || !size) { problems.push(`${what}: "${raw}" is not a PNG, JPEG or WebP picture`); return null }
  if (Math.min(size.width, size.height) < min) { problems.push(`${what}: "${raw}" is too small (${size.width}×${size.height}; at least ${min} px on the short side); leave it out${what === 'logo' ? '' : ' and make this scene type-only'}`); return null }
  const pos = { center: 'center', top: 'center 20%', bottom: 'center 80%', left: '20% center', right: '80% center' }[focus ?? 'center'] ?? 'center'
  return { rel, src: '/' + rel, width: size.width, height: size.height, focus: pos }
}

const host = (s: string) => {
  const t = s.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').toLowerCase()
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(t) ? t : null
}

/** Check the slots; with no problem, the document to build. */
export async function checkPromoInput(ctx: AppContext, t: ToolCtx, a: PromoVideoInput, lang: Locale): Promise<CheckResult> {
  const problems: string[] = []
  if (!PROMO_STYLES.includes(a.style)) problems.push(`style must be one of ${PROMO_STYLES.join(', ')}`)
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
  const used = new Set<string>()
  const scenes: PromoScene[] = []
  for (const kind of SCENE_KINDS) {
    const s = a[kind]
    const pic = s.picture ? picture(ctx, t, s.picture, s.focus, PICTURE_MIN_PX, `${kind}.picture`, problems) : null
    if (pic) {
      if (used.has(pic.rel)) problems.push(`${kind}.picture: "${s.picture}" is already used by another scene; use another photo or none`)
      used.add(pic.rel)
    }
    const scene: PromoScene = { kind, eyebrow: s.eyebrow.trim(), headline: s.headline.map((l) => l.trim()).filter(Boolean), sub: s.sub.trim(), picture: pic ? { src: pic.src, width: pic.width, height: pic.height, focus: pic.focus } : null }
    if (kind === 'proof') {
      const p = a.proof
      if (p.number?.trim()) {
        scene.number = p.number.trim()
        scene.label = p.label?.trim() ?? ''
        if (!scene.label) problems.push('proof.label: say in a few words what the number is')
        if (!/\d/.test(scene.number)) problems.push(`proof.number "${p.number}" has no digit; give one number written in the material`)
        else if (!src.tight.includes(squash(scene.number))) problems.push(`proof.number "${p.number}" is not written in the sources exactly like that; copy one number with its unit as the material writes it (never counted, computed or rounded)`)
        else if (scene.number.length > 12) problems.push(`proof.number "${p.number}" is too long to show large; give only the number and its unit (put the rest in the label)`)
      }
    }
    if (scene.headline.some((l) => /[.。]$/.test(l) && !/\.\.\.$|…$/.test(l))) problems.push(`${kind}.headline: no full stop at the end of a headline line`)
    // every number on screen, written in the material
    const texts = [scene.eyebrow, ...scene.headline, scene.sub, scene.label ?? '', scene.number ?? '']
    for (const n of new Set(texts.flatMap(numbersIn))) {
      if (!hasNumber(src.text, n)) problems.push(`${kind}: the number "${n}" is not in the sources; use only numbers written in the material, as written`)
    }
    scenes.push(scene)
  }
  const logo = a.logo ? picture(ctx, t, a.logo, 'center', LOGO_MIN_PX, 'logo', problems) : null
  const doc: PromoDoc = {
    style: a.style, lang, company: a.company.trim(), website, brand: a.brand_color ? a.brand_color.toLowerCase() : null,
    logo: logo ? { src: logo.src, width: logo.width, height: logo.height, focus: 'center' } : null, scenes,
  }
  // the lines must fit the chosen style's boxes
  for (const s of scenes) problems.push(...fitScene(doc, s, !!s.picture).problems)
  if (problems.length) return { ok: false, problems: [...new Set(problems)] }
  return { ok: true, spec: { doc, sources: src.paths, pictures: [...used, ...(logo ? [logo.rel] : [])] } }
}

/** The team path behind a picture's `src` ("/groups/…" → "groups/…"). */
export const teamPathOf = (src: string) => src.replace(/^\/+/, '')
export const pictureExt = (rel: string) => path.extname(rel).toLowerCase().replace(/^\./, '') || 'jpg'
export type { SceneKind }
