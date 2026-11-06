// Checking round 2's steps (docs/DECISIONS.md "D2", round 2): the outline (order, counts, pictures and their notes, the
// figure each content slide will carry and the `basis` quote that shows its relationship is in the sources) and each
// slide on its own (round 1's fact rules on every text, including the figure's: numbers as written, names as written, a
// quote word for word, contact details from the sources or the profile, no superlative the sources do not use; chart
// values exactly as written; pictures from a brand folder, each once, big enough; the accent through the allowlist
// sanitizer; every line fits). Problems are listed at once in the AI's own terms, like round 1.
import crypto from 'node:crypto'
import path from 'node:path'
import { DECK2_KINDS, DECK_ACCENTS_MAX, DECK_FIGURE_FOR, DECK_STRUCTURAL, type Deck2Kind, type DeckFigure, type DeckPictureNote, type DeckSlide2, type DeckStub, type DeckTheme, type DeckTier, type IntroDeckOutline, type Locale } from '@mycel/shared/api'
import type { WebPart } from './web'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { readCompanyProfile } from '../onboarding/profile'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { hasNumber, host, LOGO_MIN_PX, numbersIn, readPicture, signVariants, sourceText, spaced, squash } from '../promo-video/spec'
import { sanitizeAccent } from './accent'
import { PIC_RULES, type DeckLogo, type PicInfo } from './layout'
import { layoutSlide2, type DeckDoc2 } from './layout2'
import { hueless, lookFor2, themeFor2 } from './look'
import { isCutout } from './png'
import { DECK_PICTURE_MIN_PX, logoLook, SUPERLATIVES, type OwnOutputs } from './spec'

export interface Sources { text: string; tight: string; paths: string[]; parts: { path: string; text: string }[] }

/** What the outline settled: everything a slide call needs, stored with the build. */
export interface Plan {
  title: string
  company: string
  website: string | null
  brand: string | null
  theme: DeckTheme
  replaced: boolean
  asked: DeckTheme | null
  sampled: string | null
  logo: DeckLogo | null
  pattern: IntroDeckOutline['pattern']
  seed: number
  sources: string[]
  stubs: DeckStub[]
  pics: Record<string, PicInfo>
  picNotes: Record<string, Pick<DeckPictureNote, 'lettering' | 'calm' | 'tone'>>
  lang: Locale
  audience: string | null
  /** the time budget (tiers.ts) */
  tier: DeckTier
  /** pages of the company's site and outside articles the server read (the longer tiers): part of the material */
  web: WebPart[]
}

/** The material with the web pages the server read added (their label is the address, or outlet · date · address). */
export function withWeb(src: Sources, web: WebPart[]): Sources {
  if (!web.length) return src
  const parts = [...src.parts, ...web.map((w) => ({ path: w.label, text: w.text }))]
  const all = parts.map((p) => p.text).join('\n')
  return { text: spaced(all), tight: squash(all), paths: src.paths, parts }
}

const ORDER: Record<Deck2Kind, number> = Object.fromEntries(DECK2_KINDS.map((k, i) => [k, i])) as Record<Deck2Kind, number>

export function outlineOrderProblems(stubs: DeckStub[]): string[] {
  const p: string[] = []
  const kinds = stubs.map((s) => s.kind)
  if (kinds[0] !== 'cover') p.push('slides[0] must be the cover')
  if (kinds[1] !== 'about') p.push('slides[1] must be the about slide')
  if (kinds[kinds.length - 1] !== 'contact') p.push('the last slide must be the contact (closing) slide')
  for (const k of ['cover', 'about', 'contact'] as const) if (!kinds.includes(k)) p.push(`the deck needs a ${k} slide`)
  for (const k of DECK2_KINDS) {
    const n = kinds.filter((x) => x === k).length
    if (k === 'products' ? n > 2 : n > 1) p.push(`${k}: at most ${k === 'products' ? 'two slides' : 'one slide'}`)
  }
  for (let i = 1; i < kinds.length; i++) if (ORDER[kinds[i]!] < ORDER[kinds[i - 1]!]) { p.push(`slide order: ${kinds[i]} must come before ${kinds[i - 1]} (cover, about, opening, needs, offer, numbers, products, process, proof, history, contact)`); break }
  return p
}

/** Every text a round-2 slide shows, with where it is (`stars`: as written). */
export function slideTexts2(s: DeckSlide2, stars = false): [string, string][] {
  const out: [string, string][] = []
  const add = (where: string, v: string | undefined) => { if (v?.trim()) out.push([where, stars ? v : v.replace(/\*/g, '')]) }
  const fig = (f: DeckFigure | undefined) => {
    if (!f) return
    switch (f.kind) {
      case 'flow': f.steps.forEach((x, i) => { add(`figure.steps[${i}].head`, x.head); add(`figure.steps[${i}].body`, x.body) }); break
      case 'cycle': f.steps.forEach((x, i) => add(`figure.steps[${i}].head`, x.head)); add('figure.center', f.center); break
      case 'hub': add('figure.center', f.center); f.items.forEach((x, i) => { add(`figure.items[${i}].label`, x.label); add(`figure.items[${i}].sub`, x.sub) }); break
      case 'layers': f.items.forEach((x, i) => { add(`figure.items[${i}].head`, x.head); add(`figure.items[${i}].body`, x.body) }); break
      case 'timeline': f.items.forEach((x, i) => { add(`figure.items[${i}].when`, x.when); add(`figure.items[${i}].head`, x.head); add(`figure.items[${i}].body`, x.body) }); if (f.next) { add('figure.next.head', f.next.head); add('figure.next.body', f.next.body) } break
      case 'compare': for (const side of ['before', 'after'] as const) { add(`figure.${side}.label`, f[side].label); add(`figure.${side}.head`, f[side].head); f[side].items?.forEach((x, i) => add(`figure.${side}.items[${i}]`, x)) } break
      case 'funnel': f.stages.forEach((x, i) => add(`figure.stages[${i}]`, x)); break
      case 'merge': f.inputs.forEach((x, i) => add(`figure.inputs[${i}]`, x)); add('figure.target.head', f.target.head); add('figure.target.body', f.target.body); break
      case 'grid': f.items.forEach((x, i) => { add(`figure.items[${i}].head`, x.head); add(`figure.items[${i}].body`, x.body); x.tags?.forEach((tg, j) => add(`figure.items[${i}].tags[${j}]`, tg)) }); break
      case 'cards': f.items.forEach((x, i) => { add(`figure.items[${i}].name`, x.name); add(`figure.items[${i}].body`, x.body) }); break
      case 'donut': f.items.forEach((x, i) => { add(`figure.items[${i}].value`, x.value); add(`figure.items[${i}].label`, x.label) }); break
      case 'bars': f.items.forEach((x, i) => { add(`figure.items[${i}].label`, x.label); add(`figure.items[${i}].value`, x.value) }); break
      case 'line': f.points.forEach((x, i) => { add(`figure.points[${i}].x`, x.x); add(`figure.points[${i}].value`, x.value) }); break
      case 'figures': f.items.forEach((x, i) => { add(`figure.items[${i}].number`, x.number); add(`figure.items[${i}].label`, x.label) }); break
    }
  }
  switch (s.kind) {
    case 'cover': add('headline', s.headline); add('sub', s.sub); break
    case 'about': add('statement', s.statement); s.facts?.forEach((f, i) => { add(`facts[${i}].label`, f.label); add(`facts[${i}].value`, f.value) }); fig(s.figure); break
    case 'opening': add('line', s.line); add('sub', s.sub); break
    case 'needs': case 'products': case 'process': case 'history': add('title', s.title); fig(s.figure); break
    case 'offer': add('title', s.title); add('sub', s.sub); fig(s.figure); break
    case 'numbers': add('title', s.title); add('note', s.note); fig(s.figure); break
    case 'proof': add('title', s.title); s.names?.forEach((x, i) => add(`names[${i}]`, x)); if (s.quote) { add('quote.text', s.quote.text); add('quote.who', s.quote.who) } fig(s.figure); break
    case 'contact': add('line', s.line); add('offer', s.offer); add('person', s.person); add('email', s.email); add('phone', s.phone); add('website', s.website); add('address', s.address); break
  }
  return out
}
const figureOf = (s: DeckSlide2): DeckFigure | undefined => ('figure' in s ? s.figure : undefined)
/** The chart values a slide states (each exactly as written). */
function chartValues(f: DeckFigure | undefined): [string, string][] {
  if (!f) return []
  if (f.kind === 'donut') return f.items.map((x, i) => [`figure.items[${i}].value`, x.value])
  if (f.kind === 'bars') return f.items.map((x, i) => [`figure.items[${i}].value`, x.value])
  if (f.kind === 'line') return f.points.map((x, i) => [`figure.points[${i}].value`, x.value])
  if (f.kind === 'figures') return f.items.map((x, i) => [`figure.items[${i}].number`, x.number])
  return []
}
function slideNames2(s: DeckSlide2): [string, string][] {
  if (s.kind === 'proof') return [...(s.names ?? []).map((n, i) => [`names[${i}]`, n] as [string, string]), ...(s.quote ? [['quote.who', s.quote.who] as [string, string]] : [])]
  if (s.kind === 'contact' && s.person) return [['person', s.person]]
  return []
}
/** Pictures a slide uses: where, team path, the frame it needs. */
export function slidePictures2(s: DeckSlide2): { where: string; path: string; frame: 'cover' | 'half' | 'card' }[] {
  const out: { where: string; path: string; frame: 'cover' | 'half' | 'card' }[] = []
  if ((s.kind === 'cover' || s.kind === 'opening') && s.picture) out.push({ where: 'picture', path: s.picture, frame: 'cover' })
  const f = figureOf(s)
  if (f?.kind === 'compare' && f.after.picture) out.push({ where: 'figure.after.picture', path: f.after.picture, frame: 'half' })
  if (f?.kind === 'cards') f.items.forEach((it, i) => out.push({ where: `figure.items[${i}].picture`, path: it.picture, frame: 'card' }))
  return out
}

const LABEL: Record<Locale, string> = { ko: '출처', en: 'Source', id: 'Sumber', ja: '出典', es: 'Fuente' }
/** The speaker notes: where each number and name on the slide stands in the sources, quoted. */
export function notesFor2(s: DeckSlide2, parts: { path: string; text: string }[], lang: Locale): string[] {
  const tokens = new Set<string>()
  for (const [, t] of slideTexts2(s)) for (const n of numbersIn(t)) tokens.add(n)
  for (const [, n] of slideNames2(s)) tokens.add(n.trim())
  const out: string[] = []
  for (const tok of tokens) {
    for (const part of parts) {
      const text = spaced(part.text)
      const i = /^[\d.,]+$/.test(tok) ? (() => { const m = new RegExp(`(?<!\\d)(?<!\\d[.,])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)(?![.,]\\d)`).exec(text); return m ? m.index : -1 })() : text.indexOf(spaced(tok))
      if (i < 0) continue
      const a = Math.max(0, i - 36), b = Math.min(text.length, i + tok.length + 36)
      const name = /^https?:\/\//.test(part.path) || part.path.includes(' · ') ? part.path : path.basename(part.path)
      out.push(`${LABEL[lang]}: ${name} — "${a > 0 ? '…' : ''}${text.slice(a, b).trim()}${b < text.length ? '…' : ''}"`)
      break
    }
  }
  return [...new Set(out)]
}

const profileOf = (ctx: AppContext, t: ToolCtx) => { try { return readCompanyProfile(ctx.files, t.user) } catch { return null } }

/** Read the sources (refusing a file this tool gave out). */
export async function readSources(ctx: AppContext, t: ToolCtx, list: string[], problems: string[], own: OwnOutputs): Promise<Sources> {
  const src = await sourceText(ctx, t, list, problems)
  for (const raw of list) {
    try {
      const x = authorize(ctx.files.fx, ctx.files.rules(), t.user, raw.replace(/^\/+/, ''), 'read', { mustExist: true })
      if (own(crypto.createHash('sha256').update(readRegular(x.abs, 60 * 1024 * 1024).bytes).digest('hex'))) problems.push(`source "${raw}" is an intro deck this tool made; name the material it was made from instead`)
    } catch { /* sourceText said why */ }
  }
  return src
}

export type OutlineCheck = { ok: true; plan: Plan; src: Sources } | { ok: false; problems: string[] }

/** The outline: order, pictures and notes, figures and their basis, the theme. `sample` turns pictures into an accent
 * colour (render.ts through typst; null where there is none). */
export async function checkOutline(ctx: AppContext, t: ToolCtx, a: IntroDeckOutline, lang: Locale, own: OwnOutputs, sample: (bytes: Uint8Array[]) => Promise<string | null>, o: { tier: DeckTier; web: WebPart[] } = { tier: 'quick', web: [] }): Promise<OutlineCheck> {
  const problems: string[] = []
  problems.push(...outlineOrderProblems(a.slides))
  const src = withWeb(await readSources(ctx, t, a.sources, problems, own), o.web)
  const profile = profileOf(ctx, t)
  // the website from the material or the saved profile, as its host
  let website: string | null = null
  if (a.website) {
    const h = host(a.website)
    const ok = (profile?.website && host(profile.website) === h) || (h && src.text.toLowerCase().includes(h))
    if (!h) problems.push(`website "${a.website}" is not a web address; give the host, e.g. acme.co.kr, or leave it out`)
    else if (!ok) problems.push(`website "${a.website}" is not written in the sources or the company profile; leave it out`)
    else website = h
  }
  // figures: allowed for the kind, a basis quote for every relationship
  a.slides.forEach((s, i) => {
    const allowed = DECK_FIGURE_FOR[s.kind]
    if (s.figure && !allowed.includes(s.figure)) problems.push(`slides[${i}] (${s.kind}): a ${s.kind} slide takes ${allowed.length ? allowed.join(', ') : 'no figure'}, not ${s.figure}`)
    if (!s.figure && allowed.length && !['about', 'proof'].includes(s.kind)) problems.push(`slides[${i}] (${s.kind}): name the figure this slide will carry (${allowed.join(', ')})`)
    if (s.figure && DECK_STRUCTURAL.includes(s.figure)) {
      if (!s.basis?.trim()) problems.push(`slides[${i}] (${s.kind}): a ${s.figure} needs a basis: copy the sentence from the sources that shows it (${s.figure === 'flow' ? 'the order' : s.figure === 'cycle' ? 'that it repeats' : s.figure === 'hub' ? 'the centre and what it serves' : s.figure === 'layers' ? 'what is built on what' : s.figure === 'timeline' ? 'the years or the order of places' : s.figure === 'compare' ? 'the before and after' : s.figure === 'merge' ? 'the many channels into one' : 'the narrowing stages'}), or choose another figure`)
      else if (!src.tight.includes(squash(s.basis.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')))) problems.push(`slides[${i}] (${s.kind}) basis: "${s.basis.slice(0, 80)}" is not written in the sources word for word; copy a sentence exactly, or choose a figure the material supports`)
    }
  })
  // pictures: the logo, the notes and every picture a stub plans
  const pics: Record<string, PicInfo> = {}
  const picNotes: Plan['picNotes'] = {}
  const wording = { into: 'the deck', without: 'that slide is made with a drawn ground' }
  let logo: DeckLogo | null = null
  const brandIn = (a.brand_color ?? profile?.colors?.[0] ?? null)?.toLowerCase() ?? null
  const bytesOf = new Map<string, Uint8Array>()
  if (a.logo) {
    const r = readPicture(ctx, t, a.logo, LOGO_MIN_PX, 'logo', problems, wording)
    if (r) {
      pics[r.rel] = { width: r.width, height: r.height }
      const probe = lookFor2('paper', brandIn)
      logo = { src: r.rel, width: r.width, height: r.height, light: await logoLook(r.bytes, r.kind, probe.content.bg), dark: await logoLook(r.bytes, r.kind, '#111111') }
    }
  }
  const norm = new Map<string, string>()
  for (const note of a.pictures ?? []) {
    const r = readPicture(ctx, t, note.path, DECK_PICTURE_MIN_PX, `pictures: "${note.path}"`, problems, wording)
    if (!r) continue
    if (logo && r.rel === logo.src) { problems.push(`pictures: "${note.path}" is the logo; it goes only in \`logo\``); continue }
    pics[r.rel] = { width: r.width, height: r.height, ...(r.kind === 'png' && isCutout(r.bytes) ? { cutout: true } : {}) }
    picNotes[r.rel] = { lettering: note.lettering, calm: note.calm, tone: note.tone }
    norm.set(note.path, r.rel)
    bytesOf.set(r.rel, r.bytes)
  }
  const used = new Map<string, number>()
  const stubs = a.slides.map((s) => ({ ...s }))
  stubs.forEach((s, i) => {
    if (!s.picture) return
    const rel = norm.get(s.picture) ?? (() => { const r = readPicture(ctx, t, s.picture!, DECK_PICTURE_MIN_PX, `slides[${i}] (${s.kind}) picture`, problems, wording); if (r) { pics[r.rel] = { width: r.width, height: r.height, ...(r.kind === 'png' && isCutout(r.bytes) ? { cutout: true } : {}) }; bytesOf.set(r.rel, r.bytes) } return r?.rel })()
    if (!rel) return
    if (!picNotes[rel]) problems.push(`slides[${i}] (${s.kind}) picture "${s.picture}": add a note for it in \`pictures\` (what it shows, lettering, the calm side, the tone)`)
    const prev = used.get(rel)
    if (prev !== undefined && s.kind !== 'products') problems.push(`slides[${i}] (${s.kind}) picture "${s.picture}" is already planned for slide ${prev + 1}; use another picture or none`)
    used.set(rel, i)
    s.picture = rel
  })
  // the theme: deep colours go dark when the pictures on the cover and the opening are mostly dark
  const tones = stubs.filter((s) => (s.kind === 'cover' || s.kind === 'opening') && s.picture).map((s) => picNotes[s.picture!]?.tone)
  const picturesDark = tones.length > 0 && tones.filter((x) => x === 'dark').length * 2 > tones.length
  const { theme, replaced } = themeFor2(a.theme, brandIn, picturesDark)
  if (problems.length) return { ok: false, problems: [...new Set(problems)] }
  // a brand colour without hue: the accent from the brand pictures (the café's rust door)
  let sampled: string | null = null
  if (hueless(brandIn) && bytesOf.size) {
    try { sampled = await sample([...bytesOf.values()].slice(0, 6)) } catch { sampled = null }
  }
  const seed = Number.parseInt(crypto.createHash('sha256').update(`${t.user.id}|${a.title}`).digest('hex').slice(0, 8), 16)
  return {
    ok: true, src,
    plan: {
      title: a.title.trim(), company: a.company.trim(), website, brand: brandIn, theme, replaced, asked: a.theme ?? null, sampled, logo,
      pattern: a.pattern, seed, sources: src.paths, stubs, pics, picNotes, lang, audience: a.audience?.trim() || null, tier: o.tier, web: o.web,
    },
  }
}

export interface BuildState { slides: (DeckSlide2 | null)[]; accents: Record<number, string>; treat: DeckDoc2['treat'] }
export type SlideCheck = { ok: true; slide: DeckSlide2; accent: string | null; notes: string[]; dropped: string | null } | { ok: false; problems: string[] }

/** The document of a build as far as it goes (slides not made yet are left out of the layout but counted). */
export function docOf(plan: Plan, st: BuildState, notes: string[][]): DeckDoc2 {
  return {
    v: 2, theme: plan.theme, lang: plan.lang, title: plan.title, company: plan.company, website: plan.website, brand: plan.brand, sampled: plan.sampled,
    logo: plan.logo, pattern: plan.pattern, seed: plan.seed,
    slides: st.slides.map((s, i) => s ?? placeholder(plan.stubs[i]!)),
    sections: plan.stubs.map((s) => s.section), pics: plan.pics, picNotes: plan.picNotes, accents: st.accents, treat: st.treat, notes,
  }
}
/** A stand-in for a slide not made yet (only so a slide's page number and neighbours are known). */
function placeholder(s: DeckStub): DeckSlide2 {
  if (s.kind === 'cover') return { kind: 'cover', headline: s.headline }
  if (s.kind === 'contact') return { kind: 'contact', line: s.headline }
  if (s.kind === 'opening') return { kind: 'opening', line: s.headline }
  if (s.kind === 'about') return { kind: 'about', statement: s.headline }
  return { kind: 'proof', title: s.headline, names: ['', '', ''] } as DeckSlide2
}

/** One slide: its kind and figure as planned, the facts, the pictures, the accent, the fit. */
export function checkSlide(ctx: AppContext, t: ToolCtx, plan: Plan, src: Sources, st: BuildState, index: number, slideIn: DeckSlide2, o: { basis?: string } = {}): SlideCheck {
  const problems: string[] = []
  const stub = plan.stubs[index]
  if (!stub) return { ok: false, problems: [`index ${index}: the outline has ${plan.stubs.length} slides (0–${plan.stubs.length - 1})`] }
  const where = (w: string) => `slides[${index}] (${slideIn.kind}) ${w}`
  const s: DeckSlide2 = JSON.parse(JSON.stringify(slideIn))
  if (s.kind !== stub.kind) return { ok: false, problems: [`slides[${index}]: the outline planned a ${stub.kind} slide here, not ${s.kind}`] }
  const fig = figureOf(s)
  if (fig && stub.figure && fig.kind !== stub.figure) {
    const ok = o.basis && DECK_FIGURE_FOR[s.kind].includes(fig.kind) && (!DECK_STRUCTURAL.includes(fig.kind) || src.tight.includes(squash(o.basis)))
    if (!ok) problems.push(where(`figure: the outline planned a ${stub.figure} here; draw a ${stub.figure}${DECK_STRUCTURAL.includes(fig.kind) ? ` (a ${fig.kind} needs its own basis quote from the sources)` : ''}`))
  }
  if (!fig && stub.figure && s.kind !== 'about' && s.kind !== 'proof') problems.push(where(`figure: the outline planned a ${stub.figure} here`))
  if (s.kind === 'about' && !fig && !(s.facts?.length)) problems.push(where('give a figure (hub, compare or figures) or the facts'))
  const profile = profileOf(ctx, t)
  const profileText = profile ? spaced(JSON.stringify(profile)) : ''
  const known = (x: string) => src.tight.includes(squash(x)) || (profile ? squash(JSON.stringify(profile)).includes(squash(x)) : false)
  // numbers, claims and headlines
  for (const [w, text] of slideTexts2(s)) {
    if (['email', 'phone', 'website'].includes(w)) continue
    for (const n of new Set(numbersIn(text))) if (!hasNumber(src.text, n) && !(profile && hasNumber(profileText, n))) problems.push(where(`${w}: the number "${n}" is not in the sources; use only numbers written in the material, as written`))
    for (const word of SUPERLATIVES) if (text.toLowerCase().includes(word.toLowerCase()) && !src.text.toLowerCase().includes(word.toLowerCase())) problems.push(where(`${w}: "${word}" is not what the sources say; leave the claim out`))
  }
  for (const [w, v] of chartValues(fig)) if (!signVariants(v).some((x) => src.tight.includes(x))) problems.push(where(`${w} "${v}" is not written in the sources exactly like that; copy the number with its sign and unit as the material writes it (never counted, computed or rounded)`))
  const knownName = (n: string) => known(n) || (/[,·|/]/.test(n) && n.split(/\s*[,·|/]\s*/).filter(Boolean).every(known))
  for (const [w, n] of slideNames2(s)) if (!knownName(n)) problems.push(where(`${w}: "${n}" is not written in the sources like that; use names exactly as the material writes them, or leave them out`))
  if (s.kind === 'proof' && s.quote && !src.tight.includes(squash(s.quote.text))) problems.push(where('quote.text: a quote must stand in the sources word for word; copy it exactly or use another kind of proof'))
  if (s.kind === 'contact') {
    for (const k of ['email', 'phone', 'address'] as const) { const v = s[k]; if (v && !known(v)) problems.push(where(`${k}: "${v}" is not written in the sources or the company profile exactly like that; leave it out`)) }
    if (s.website) { const h = host(s.website); if (!h || !(src.text.toLowerCase().includes(h) || (profile?.website && host(profile.website) === h))) problems.push(where(`website: "${s.website}" is not written in the sources or the company profile; leave it out`)) }
  }
  for (const [w, text] of slideTexts2(s)) if (['headline', 'title', 'line', 'statement'].includes(w) && /[.。]$/.test(text.trim()) && !/(\.\.\.|…)$/.test(text.trim())) problems.push(where(`${w}: no full stop at the end of a headline`))
  for (const [w, text] of slideTexts2(s, true)) if (((text.match(/\*/g) ?? []).length) > 2) problems.push(where(`${w}: mark at most one key phrase with a pair of *stars*`))
  // pictures: in the plan or the brand folder, big enough, each once (cards may repeat none either)
  const usedElsewhere = new Map<string, number>()
  st.slides.forEach((x, i) => { if (x && i !== index) for (const p of slidePictures2(x)) usedElsewhere.set(p.path, i) })
  const seen = new Set<string>()
  for (const p of slidePictures2(s)) {
    let rel = p.path.replace(/^\/+/, '')
    if (!plan.pics[rel]) {
      const r = readPicture(ctx, t, p.path, DECK_PICTURE_MIN_PX, where(p.where), problems, { into: 'the deck', without: 'that slide is made without it' })
      if (!r) continue
      rel = r.rel
      plan.pics[rel] = { width: r.width, height: r.height, ...(r.kind === 'png' && isCutout(r.bytes) ? { cutout: true } : {}) }
    }
    if (plan.logo && rel === plan.logo.src) { problems.push(where(`${p.where}: the logo goes only in \`logo\``)); continue }
    if (seen.has(rel) || usedElsewhere.has(rel)) { problems.push(where(`${p.where}: "${p.path}" is already used${usedElsewhere.has(rel) ? ` on slide ${usedElsewhere.get(rel)! + 1}` : ''}; use another picture or none`)); continue }
    seen.add(rel)
    const info = plan.pics[rel]!
    const fits = p.frame === 'cover' ? (!info.cutout && PIC_RULES.bleed(info)) || PIC_RULES.half(info) : p.frame === 'half' ? PIC_RULES.half(info) : PIC_RULES.card(info)
    if (!fits) { problems.push(where(`${p.where}: "${p.path}" (${info.width}×${info.height}) is too small for this place (${p.frame === 'card' ? 'at least 400 px on its short side' : p.frame === 'half' ? 'at least 800 px on its short side' : 'a landscape picture at least 1,600 px wide, or one at least 800 px on its short side'}); choose another or leave it out`)); continue }
    if (p.frame === 'card' && plan.picNotes[rel]?.lettering === true) { /* lettering on a product card is fine (product markings) */ }
    // the slide refers to the picture by its team path from here on
    if (s.kind === 'cover' || s.kind === 'opening') s.picture = rel
    else if (fig?.kind === 'compare' && p.where === 'figure.after.picture') fig.after.picture = rel
    else if (fig?.kind === 'cards') { const it = fig.items.find((x) => x.picture === p.path); if (it) it.picture = rel }
  }
  // the accent: sanitized with the feature ground's colours; a rejection or a third accent costs only the accent
  let accent: string | null = null
  let dropped: string | null = null
  const raw = (s.kind === 'cover' || s.kind === 'opening' || s.kind === 'contact') ? s.accent : undefined
  if (raw?.trim()) {
    const others = Object.keys(st.accents).filter((k) => Number(k) !== index).length
    if (others >= DECK_ACCENTS_MAX) dropped = `the deck already has ${DECK_ACCENTS_MAX} accents`
    else {
      const look = lookFor2(plan.theme, plan.brand, plan.sampled)
      const g = look.feature
      const r = sanitizeAccent(raw, { ink: g.bg, ground: g.bg, line: g.lineStrong, mark: g.mark, onMark: g.onMark })
      if (r.ok) accent = r.svg
      else dropped = r.reason
    }
  }
  if ('accent' in s) delete (s as { accent?: string }).accent
  if (problems.length) return { ok: false, problems: [...new Set(problems)] }
  // the fit: this slide laid out among the others (page numbers, neighbours)
  const accents = { ...st.accents }
  if (accent) accents[index] = accent
  else delete accents[index]
  const trial: BuildState = { slides: st.slides.map((x, i) => (i === index ? s : x)), accents, treat: st.treat }
  const doc = docOf(plan, trial, [])
  const lay: string[] = []
  layoutSlide2(doc, index, undefined, lay)
  if (lay.length) return { ok: false, problems: [...new Set(lay)] }
  return { ok: true, slide: s, accent, notes: notesFor2(s, src.parts, plan.lang), dropped }
}
