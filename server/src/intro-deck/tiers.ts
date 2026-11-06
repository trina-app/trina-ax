// How long a deck may take (docs/DECISIONS.md "D2", round 2, the owner's "3분 5분 10분"): one team setting,
// `introDeckTier` (owners and admins choose it in Admin › Team settings, 5 minutes until they do: DEFAULT_DECK_TIER;
// MYCEL_DECK_TIER overrides it on a dev server only), and what each tier
// spends its time on. Every fact rule stays: a number, name or quote only as written in the material or in a page the
// server itself read again (the site's pages, an outside article with its outlet and date, cited in the notes).
//   quick    ≈ 3 min: the material saved at setup (≤ 4 pages of the site), outline → slides → one review.
//   standard ≈ 5 min: the server reads 8–10 pages of the same site (the setup draft's scope: the saved website's host
//            and its subdomains, SSRF rules of web_fetch), the AI makes 2–3 web searches for reputable facts; a second
//            review only when the first found more than two problems.
//   deep     ≈ 10 min: about 15 pages (product and case pages too), 6–8 searches, the strongest model the engine offers
//            for the whole answer (outline and copy), two reviews and one headline pass after seeing every slide.
import type { Database } from 'bun:sqlite'
import { DEFAULT_DECK_TIER, DeckTier, type DeckTier as Tier } from '@mycel/shared/api'
import { getTeamSettings } from '../admin/settings'

export interface TierSpec {
  minutes: number
  /** site pages the server reads in the `read` step (0: no read step) */
  pages: number
  /** web searches the AI may make: [at least, at most] */
  searches: [number, number]
  /** review rounds with pictures at most */
  reviews: number
  /** problems the first review must find (the server's findings plus the AI's fixes) for a second round */
  secondReviewOver: number
  /** a headline pass in the last review round */
  headlines: boolean
  /** the strongest model the engine offers for the whole answer */
  strongModel: boolean
  /** after this much of the answer, no more review rounds (the deck is finished at once) */
  cutoffMs: number
}

export const TIERS: Record<Tier, TierSpec> = {
  quick: { minutes: 3, pages: 0, searches: [0, 0], reviews: 1, secondReviewOver: Infinity, headlines: false, strongModel: false, cutoffMs: 150_000 },
  standard: { minutes: 5, pages: 10, searches: [2, 3], reviews: 2, secondReviewOver: 2, headlines: false, strongModel: false, cutoffMs: 270_000 },
  deep: { minutes: 10, pages: 15, searches: [6, 8], reviews: 2, secondReviewOver: -1, headlines: true, strongModel: true, cutoffMs: 540_000 },
}

/** The team's tier (DEFAULT_DECK_TIER until an owner or admin picks another). `dev`: a dev server, where MYCEL_DECK_TIER
 * wins. */
export function deckTier(db: Database, dev = false): Tier {
  if (dev) { const env = DeckTier.safeParse(process.env.MYCEL_DECK_TIER); if (env.success) return env.data }
  try { return getTeamSettings(db).introDeckTier } catch { return DEFAULT_DECK_TIER }
}

/** What the tool description adds for a longer tier (the AI reads it at the start of every answer). */
export function tierText(t: Tier): string {
  const s = TIERS[t]
  if (t === 'quick') return 'Time budget: about 3 minutes. Use the material you were given (no extra reading or searching); start with step "outline".'
  return `Time budget: about ${s.minutes} minutes. Before the outline: (a) call step "read" once: the server reads up to ${s.pages} pages of the company's own website (${t === 'deep' ? 'about, products, cases, customers, news and history pages' : 'about, products and news pages'}) and gives you their text; ` +
    `(b) make ${s.searches[0]}–${s.searches[1]} WebSearch searches for reputable outside facts about the company (${t === 'deep' ? 'its history, numbers written by the press, customer cases, awards, launches' : 'press milestones, awards, launches'}), open the best articles with web_fetch, and list each article you use in the outline's \`web_sources\` (url, outlet, date). A fact from an article may be used only when its article is listed there (the server reads it again and checks); no source, not used. Prefer the company's own pages for numbers. ` +
    (s.reviews > 1 ? `The review may come back for a second look${s.headlines ? ', and then asks for one headline pass' : ' when the first found several problems'}. ` : '') +
    'Keep every other rule.'
}
