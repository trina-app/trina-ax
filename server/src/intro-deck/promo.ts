// The hook for the next round (docs/DECISIONS.md "D2", plan §11): "이 소개서로 10초 홍보 영상도 만들어 둘까요?" makes the
// promo video from the checked deck without reading the website again. Not wired yet (DECK_VIDEO_SUGGESTION is off):
// a pure function from the stored deck to the promo video's slots, which the promo_video tool still checks itself.
//   hook ← the cover and the needs · promise ← the offer and its picture · work ← the products or the process ·
//   proof ← the numbers · end card ← the contact slide and the logo.
// Note for that round: the owner asked for 10 s; the promo video is 18.5 s, so it needs a short cut.
import type { DeckSlide, PromoVideoInput } from '@mycel/shared/api'
import type { DeckDoc } from './layout'

type K<T extends DeckSlide['kind']> = Extract<DeckSlide, { kind: T }>
const plain = (s: string | undefined) => (s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim()
/** At most `max` characters, cut at a space when there is one. */
export function clip(s: string | undefined, max: number): string {
  const t = plain(s)
  if ([...t].length <= max) return t
  const cut = [...t].slice(0, max).join('')
  const sp = cut.lastIndexOf(' ')
  return (sp > max / 3 ? cut.slice(0, sp) : cut).trim()
}
/** One or two headline lines from a text (its own line breaks first, else split near the middle at a space). */
function headline(s: string | undefined): string[] {
  const raw = (s ?? '').replace(/\r/g, '')
  const parts = raw.split('\n').map((x) => x.trim()).filter(Boolean)
  if (parts.length >= 2) return parts.slice(0, 2).map((p) => clip(p, 40))
  const one = plain(raw)
  if ([...one].length <= 14) return one ? [one] : []
  const words = one.split(' ')
  let best = 1, diff = Infinity
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length)
    if (d < diff) { diff = d; best = i }
  }
  return [clip(words.slice(0, best).join(' '), 40), clip(words.slice(best).join(' '), 40)].filter(Boolean)
}

export function deckToPromoInput(doc: DeckDoc & { sources?: string[] }, sources: string[] = doc.sources ?? []): PromoVideoInput {
  const find = <T extends DeckSlide['kind']>(k: T) => doc.slides.find((s): s is K<T> => s.kind === k)
  const cover = find('cover')!, needs = find('needs'), offer = find('offer')!, numbers = find('numbers'), products = find('products'), process = find('process'), contact = find('contact')!
  const pic = (p: string | undefined) => (p && doc.pics[p] && !doc.pics[p]!.cutout ? p : undefined)
  const work = products
    ? { kicker: clip(products.eyebrow, 24), headline: headline(products.title), points: products.items.slice(0, 3).map((x) => clip(x.name, 20)), picture: pic(products.items.find((x) => pic(x.picture))?.picture) }
    : process
      ? { kicker: clip(process.eyebrow, 24), headline: headline(process.title), points: process.steps.slice(0, 3).map((x) => clip(x.head, 20)) }
      : { kicker: clip(offer.eyebrow, 24), headline: headline(offer.title), points: offer.pillars.map((x) => clip(x.head, 20)) }
  const stats = (numbers?.stats ?? []).slice(0, 2).map((s) => ({ number: plain(s.number).slice(0, 16), label: clip(s.label, 30) }))
  return {
    title: doc.title,
    company: doc.company,
    ...(doc.website ? { website: doc.website } : {}),
    ...(doc.brand ? { brand_color: doc.brand } : {}),
    ...(doc.logo ? { logo: doc.logo.src } : {}),
    sources: sources.slice(0, 5),
    hook: {
      label: clip(needs?.title ?? cover.eyebrow ?? cover.sub ?? doc.company, 40) || doc.company,
      before: clip(needs?.points[0]?.head ?? cover.eyebrow ?? doc.company, 16) || doc.company.slice(0, 16),
      after: clip(offer.pillars[0]?.head ?? doc.company, 16),
      mode: 'swap',
    },
    promise: { headline: headline(offer.title).length ? headline(offer.title) : headline(cover.headline), ...(offer.sub ? { sub: clip(offer.sub, 60) } : {}), ...(pic(offer.picture) ?? pic(cover.picture) ? { picture: (pic(offer.picture) ?? pic(cover.picture))! } : {}) },
    work: { kicker: work.kicker || clip(doc.company, 24), headline: work.headline.length ? work.headline : headline(cover.headline), ...(work.points.length ? { points: work.points } : {}), ...(work.picture ? { picture: work.picture } : {}) },
    proof: stats.length ? { stats } : { headline: headline(cover.headline) },
    cta: { line: clip(contact.line, 30) || clip(cover.sub ?? doc.company, 30), ...(contact.offer ? { offer: clip(contact.offer, 20) } : {}) },
  }
}
