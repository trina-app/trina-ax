// Checking the slides the AI filled for an intro deck (docs/DECISIONS.md "D2") before anything is drawn. Every problem
// is listed at once, in words the AI can act on, so one rewrite can fix them all (the promo video's way, and its
// helpers: promo-video/spec.ts):
// - the order: cover first, about second, contact last; the rest in the order needs → offer → numbers → products (up
//   to twice) → process → proof → history; one scene between the third slide and contact; cover, about, offer and
//   contact are required;
// - numbers: every number on a slide is written in the sources, a stat exactly as written (sign and unit included);
// - names: customers and partners, certifications, people and titles, as written (NFKC, whitespace aside); a quote word
//   for word; contact details as written in the sources or the saved company profile; "최고", "1위", "유일", "No.1" and
//   the like only when the sources say them;
// - pictures and the logo: brand-folder team files the person can read, PNG / JPEG / WebP by their bytes, each once,
//   big enough for their frame (a full-bleed cover or scene: landscape and ≥ 1,600 px wide; half a slide: ≥ 800 px on
//   the short side; a card: ≥ 400 px), the logo only in its slot;
// - the deck itself is never a source: a source that is one of the files this tool made (by its hash) is refused;
// - every line fits its box with 10 % to spare (layout.ts), and no slide is more than 40 % text.
import crypto from 'node:crypto'
import path from 'node:path'
import { DECK_KINDS, type DeckSlide, type IntroDeckInput, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { readCompanyProfile } from '../onboarding/profile'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { rawRgba } from '../onboarding/brand-assets'
import { logoTreatFromPixels } from '../promo-video/logo'
import { hasNumber, host, LOGO_MIN_PX, numbersIn, readPicture, signVariants, sourceText, spaced, squash } from '../promo-video/spec'
import { layoutDeck, PIC_RULES, type DeckDoc, type DeckLogo, type DeckOut, type LogoTreat, type PicInfo } from './layout'
import { decodePng, isCutout, sampleRgba } from './png'
import { lookFor, themeFor } from './theme'

/** the smallest picture any slide takes (a card) */
export const DECK_PICTURE_MIN_PX = 400
/** words a deck may use only when the sources do */
export const SUPERLATIVES = ['최고', '1위', '유일', '최초', '최대 규모', 'No.1', 'No. 1', '#1', 'number one', 'best-in-class', 'world-class', 'world\'s first', 'industry-leading']

const ORDER: Record<DeckSlide['kind'], number> = Object.fromEntries(DECK_KINDS.map((k, i) => [k, i])) as Record<DeckSlide['kind'], number>

/** Problems with the slides' order and kinds. */
export function orderProblems(slides: DeckSlide[]): string[] {
  const p: string[] = []
  const kinds = slides.map((s) => s.kind)
  if (kinds[0] !== 'cover') p.push('slides[0] must be the cover')
  if (kinds[1] !== 'about') p.push('slides[1] must be the about slide')
  if (kinds[kinds.length - 1] !== 'contact') p.push('the last slide must be the contact slide')
  for (const k of ['cover', 'about', 'offer', 'contact'] as const) if (!kinds.includes(k)) p.push(`the deck needs a ${k} slide`)
  const count = (k: string) => kinds.filter((x) => x === k).length
  for (const k of DECK_KINDS) {
    const n = count(k)
    if (k === 'products' ? n > 2 : n > 1) p.push(`${k}: at most ${k === 'products' ? 'two slides' : 'one slide'}`)
  }
  const si = kinds.indexOf('scene')
  if (si >= 0 && (si < 2 || si === kinds.length - 1)) p.push('the scene must stand between the third slide and the contact slide')
  // the rest in their order (the scene left out of the comparison)
  const rest = kinds.filter((k) => k !== 'scene')
  for (let i = 1; i < rest.length; i++) if (ORDER[rest[i]!] < ORDER[rest[i - 1]!]) { p.push(`slide order: ${rest[i]} must come before ${rest[i - 1]} (cover, about, needs, offer, numbers, products, process, proof, history, contact)`); break }
  return p
}

/** Every text a slide shows, with where it is, for the number and wording checks. */
export function slideTexts(s: DeckSlide): [string, string][] {
  const out: [string, string][] = []
  const add = (where: string, v: string | undefined) => { if (v?.trim()) out.push([where, v.replace(/\*/g, '')]) }
  add('eyebrow', s.eyebrow)
  switch (s.kind) {
    case 'cover': add('headline', s.headline); add('sub', s.sub); break
    case 'about': add('statement', s.statement); s.facts?.forEach((f, i) => { add(`facts[${i}].label`, f.label); add(`facts[${i}].value`, f.value) }); break
    case 'needs': add('title', s.title); s.points.forEach((x, i) => { add(`points[${i}].head`, x.head); add(`points[${i}].body`, x.body) }); break
    case 'offer': add('title', s.title); add('sub', s.sub); s.pillars.forEach((x, i) => { add(`pillars[${i}].head`, x.head); add(`pillars[${i}].body`, x.body) }); break
    case 'numbers': add('title', s.title); s.stats.forEach((x, i) => { add(`stats[${i}].number`, x.number); add(`stats[${i}].label`, x.label) }); add('note', s.note); break
    case 'products': add('title', s.title); s.items.forEach((x, i) => { add(`items[${i}].name`, x.name); add(`items[${i}].body`, x.body) }); break
    case 'process': add('title', s.title); s.steps.forEach((x, i) => { add(`steps[${i}].head`, x.head); add(`steps[${i}].body`, x.body) }); break
    case 'proof': add('title', s.title); s.names?.forEach((x, i) => add(`names[${i}]`, x)); if (s.quote) { add('quote.text', s.quote.text); add('quote.who', s.quote.who) }
      if (s.case) for (const k of ['before', 'action', 'result'] as const) { add(`case.${k}.label`, s.case[k].label); add(`case.${k}.text`, s.case[k].text) }
      break
    case 'history': add('title', s.title); s.items?.forEach((x, i) => { add(`items[${i}].when`, x.when); add(`items[${i}].what`, x.what) }); s.trust?.forEach((x, i) => add(`trust[${i}]`, x)); break
    case 'scene': add('line', s.line); break
    case 'contact': add('line', s.line); add('offer', s.offer); add('person', s.person); add('email', s.email); add('phone', s.phone); add('website', s.website); add('address', s.address); break
  }
  return out
}

/** The names a slide states as facts (each must stand in the sources as written). */
function slideNames(s: DeckSlide): [string, string][] {
  if (s.kind === 'proof') return [...(s.names ?? []).map((n, i) => [`names[${i}]`, n] as [string, string]), ...(s.quote ? [['quote.who', s.quote.who] as [string, string]] : [])]
  if (s.kind === 'history') return (s.trust ?? []).map((n, i) => [`trust[${i}]`, n])
  if (s.kind === 'contact' && s.person) return [['person', s.person]]
  return []
}

/** Pictures a slide uses: [where, team path, frame]. */
function slidePictures(s: DeckSlide): { where: string; path: string; frame: 'cover' | 'half' | 'card' | 'bleed' }[] {
  if (s.kind === 'cover' && s.picture) return [{ where: 'picture', path: s.picture, frame: 'cover' }]
  if (s.kind === 'offer' && s.picture) return [{ where: 'picture', path: s.picture, frame: 'half' }]
  if (s.kind === 'scene') return [{ where: 'picture', path: s.picture, frame: 'bleed' }]
  if (s.kind === 'products') return s.items.flatMap((it, i) => (it.picture ? [{ where: `items[${i}].picture`, path: it.picture, frame: 'card' as const }] : []))
  return []
}

const LABEL: Record<Locale, string> = { ko: '출처', en: 'Source', id: 'Sumber', ja: '出典', es: 'Fuente' }

/** The speaker notes of a slide: where each of its numbers and names stands in the sources, quoted. */
export function notesFor(s: DeckSlide, parts: { path: string; text: string }[], lang: Locale): string[] {
  const tokens = new Set<string>()
  for (const [, t] of slideTexts(s)) for (const n of numbersIn(t)) tokens.add(n)
  for (const [, n] of slideNames(s)) tokens.add(n.trim())
  const out: string[] = []
  for (const tok of tokens) {
    for (const part of parts) {
      const text = spaced(part.text)
      const i = /\d/.test(tok) && /^[\d.,]+$/.test(tok) ? (() => { const m = new RegExp(`(?<!\\d)(?<!\\d[.,])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)(?![.,]\\d)`).exec(text); return m ? m.index : -1 })() : text.indexOf(spaced(tok))
      if (i < 0) continue
      const a = Math.max(0, i - 36), b = Math.min(text.length, i + tok.length + 36)
      out.push(`${LABEL[lang]}: ${path.basename(part.path)} — "${a > 0 ? '…' : ''}${text.slice(a, b).trim()}${b < text.length ? '…' : ''}"`)
      break
    }
  }
  return [...new Set(out)]
}

/** A logo's look on a ground: as it is, in one colour (a transparent PNG), on a card, or a tile of its own. */
async function logoLook(bytes: Buffer, kind: 'png' | 'jpg' | 'webp', ground: string): Promise<LogoTreat> {
  if (kind === 'jpg') return 'tile'
  let raw: Uint8Array | null = null
  if (kind === 'png') { const img = decodePng(bytes); raw = img ? sampleRgba(img, 64) : null }
  else raw = await rawRgba(bytes, kind, 64)
  if (!raw) return kind === 'png' ? 'chip' : 'chip'
  const t = logoTreatFromPixels(raw, ground)
  // one colour needs our own PNG writer: a WebP logo sits on a card instead
  if (t === 'white') return kind === 'png' ? 'mono' : 'chip'
  return t
}

export interface CheckedDeck { doc: DeckDoc; out: DeckOut; sources: string[]; pictures: string[]; replaced: boolean }
export type DeckCheck = { ok: true; deck: CheckedDeck } | { ok: false; problems: string[] }

/** The hashes of the files this tool made (the deck must never become its own source). */
export type OwnOutputs = (sha256: string) => boolean

export async function checkDeckInput(ctx: AppContext, t: ToolCtx, a: IntroDeckInput, lang: Locale, own: OwnOutputs = () => false): Promise<DeckCheck> {
  const problems: string[] = []
  problems.push(...orderProblems(a.slides))
  const src = await sourceText(ctx, t, a.sources, problems)
  for (const raw of a.sources) {
    // a file this tool made (downloaded and put back) would let the deck prove its own numbers
    try {
      const x = authorize(ctx.files.fx, ctx.files.rules(), t.user, raw.replace(/^\/+/, ''), 'read', { mustExist: true })
      if (own(crypto.createHash('sha256').update(readRegular(x.abs, 60 * 1024 * 1024).bytes).digest('hex'))) problems.push(`source "${raw}" is an intro deck this tool made; name the material it was made from instead`)
    } catch { /* sourceText said why */ }
  }
  const profile = (() => { try { return readCompanyProfile(ctx.files, t.user) } catch { return null } })()
  const known = (s: string) => src.tight.includes(squash(s)) || (profile ? squash(JSON.stringify(profile)).includes(squash(s)) : false)
  // the website: from the material or the saved profile, as its host
  let website: string | null = null
  if (a.website) {
    const h = host(a.website)
    const ok = (profile?.website && host(profile.website) === h) || (h && src.text.toLowerCase().includes(h))
    if (!h) problems.push(`website "${a.website}" is not a web address; give the host, e.g. acme.co.kr, or leave it out`)
    else if (!ok) problems.push(`website "${a.website}" is not written in the sources or the company profile; leave it out`)
    else website = h
  }
  const savedColor = profile?.colors?.[0] ?? null
  const brand = (a.brand_color ?? savedColor)?.toLowerCase() ?? null
  const { theme, replaced } = themeFor(a.theme, brand)
  const look = lookFor(theme, brand)
  // pictures: brand folder, real pictures, each once, big enough for their frame
  const pics: Record<string, PicInfo> = {}
  const used = new Map<string, string>()
  const wording = { into: 'the deck', without: 'that slide is made with type only' }
  let logo: DeckLogo | null = null
  let logoRel: string | null = null
  if (a.logo) {
    const r = readPicture(ctx, t, a.logo, LOGO_MIN_PX, 'logo', problems, wording)
    if (r) {
      logoRel = r.rel
      pics[r.rel] = { width: r.width, height: r.height }
      logo = { src: r.rel, width: r.width, height: r.height, light: await logoLook(r.bytes, r.kind, look.light.bg), dark: await logoLook(r.bytes, r.kind, look.feature.dark ? look.feature.bg : '#111111') }
    }
  }
  const slides: DeckSlide[] = a.slides.map((s) => JSON.parse(JSON.stringify(s)) as DeckSlide)
  for (const [i, s] of slides.entries()) {
    const where = (w: string) => `slides[${i}] (${s.kind}) ${w}`
    const list = slidePictures(s)
    if (s.kind === 'products' && list.length && list.length !== s.items.length) problems.push(where('items: either every item has a picture or none does'))
    for (const p of list) {
      const r = readPicture(ctx, t, p.path, DECK_PICTURE_MIN_PX, where(p.where), problems, wording)
      if (!r) continue
      if (r.rel === logoRel) { problems.push(where(`${p.where}: the logo goes only in \`logo\`; choose a picture or leave it out`)); continue }
      const prev = used.get(r.rel)
      if (prev) { problems.push(where(`${p.where}: "${p.path}" is already used on ${prev}; use another picture or none`)); continue }
      used.set(r.rel, `slide ${i + 1}`)
      const info: PicInfo = { width: r.width, height: r.height, ...(r.kind === 'png' && isCutout(r.bytes) ? { cutout: true } : {}) }
      const fits = p.frame === 'cover' ? (!info.cutout && PIC_RULES.bleed(info)) || PIC_RULES.half(info) : p.frame === 'half' ? PIC_RULES.half(info) : p.frame === 'bleed' ? !info.cutout && PIC_RULES.bleed(info) : PIC_RULES.card(info)
      if (!fits) {
        const need = p.frame === 'cover' ? 'a landscape picture at least 1,600 px wide, or one at least 800 px on its short side' : p.frame === 'half' ? 'at least 800 px on its short side' : p.frame === 'bleed' ? 'a landscape photograph (not a cut-out) at least 1,600 px wide' : 'at least 400 px on its short side'
        problems.push(where(`${p.where}: "${p.path}" (${r.width}×${r.height}) is too small for this place (it needs ${need}); choose another or leave it out`))
        continue
      }
      pics[r.rel] = info
      // the slide refers to the picture by its normalized team path from here on
      if (s.kind === 'products') { const it = s.items.find((x) => x.picture === p.path); if (it) it.picture = r.rel }
      else (s as { picture?: string }).picture = r.rel
    }
  }
  // numbers, names, contact details and claims
  for (const [i, s] of slides.entries()) {
    const where = (w: string) => `slides[${i}] (${s.kind}) ${w}`
    for (const [w, text] of slideTexts(s)) {
      if (['email', 'phone', 'website'].includes(w)) continue
      for (const n of new Set(numbersIn(text))) if (!hasNumber(src.text, n) && !(profile && hasNumber(spaced(JSON.stringify(profile)), n))) problems.push(where(`${w}: the number "${n}" is not in the sources; use only numbers written in the material, as written`))
      for (const word of SUPERLATIVES) if (text.toLowerCase().includes(word.toLowerCase()) && !src.text.toLowerCase().includes(word.toLowerCase())) problems.push(where(`${w}: "${word}" is not what the sources say; leave the claim out`))
    }
    if (s.kind === 'numbers') s.stats.forEach((st, k) => { if (!signVariants(st.number).some((v) => src.tight.includes(v))) problems.push(where(`stats[${k}].number "${st.number}" is not written in the sources exactly like that; copy the number with its sign and unit as the material writes it (never counted, computed or rounded)`)) })
    // a name as written; a person with their company or title ("name, company") may have the parts apart in the sources
    const knownName = (n: string) => known(n) || (/[,·|/]/.test(n) && n.split(/\s*[,·|/]\s*/).filter(Boolean).every(known))
    for (const [w, n] of slideNames(s)) if (!knownName(n)) problems.push(where(`${w}: "${n}" is not written in the sources like that; use names exactly as the material writes them, or leave them out`))
    if (s.kind === 'proof' && s.quote && !src.tight.includes(squash(s.quote.text))) problems.push(where('quote.text: a quote must stand in the sources word for word; copy it exactly or use another kind of proof'))
    if (s.kind === 'contact') for (const k of ['email', 'phone', 'address'] as const) { const v = s[k]; if (v && !known(v)) problems.push(where(`${k}: "${v}" is not written in the sources or the company profile exactly like that; leave it out`)) }
    if (s.kind === 'contact' && s.website) { const h = host(s.website); if (!h || !(src.text.toLowerCase().includes(h) || (profile?.website && host(profile.website) === h))) problems.push(where(`website: "${s.website}" is not written in the sources or the company profile; leave it out`)) }
    for (const [w, text] of slideTexts(s)) if (['headline', 'title', 'line', 'statement'].includes(w) && /[.。]$/.test(text.trim()) && !/(\.\.\.|…)$/.test(text.trim())) problems.push(where(`${w}: no full stop at the end of a headline`))
    for (const [w, text] of slideTexts(s)) if (((text.match(/\*/g) ?? []).length) > 2) problems.push(where(`${w}: mark at most one key phrase with a pair of *stars*`))
  }
  const doc: DeckDoc = { theme, lang, title: a.title.trim(), company: a.company.trim(), website, brand, logo, slides, pics, notes: slides.map((s) => notesFor(s, src.parts, lang)) }
  // the layout measures every line; its problems are the AI's too
  const out = layoutDeck(doc)
  problems.push(...out.problems)
  if (problems.length) return { ok: false, problems: [...new Set(problems)] }
  return { ok: true, deck: { doc, out, sources: src.paths, pictures: [...used.keys(), ...(logoRel ? [logoRel] : [])], replaced } }
}
