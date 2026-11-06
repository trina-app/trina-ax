// The company's intro deck (회사 소개서; docs/DECISIONS.md "D2 — The first result is the company's intro deck"). The AI
// never designs it: it fills the slots of 6–10 slides with the `intro_deck` tool, the server checks them (lines that
// fit, numbers and names written in the material, pictures from a brand folder, a theme that fits the brand colour)
// and lays every slide out once (server/src/intro-deck/layout.ts). The same layout becomes the preview the chat shows,
// a PowerPoint file people can edit and a PDF that looks the same everywhere.
import { z } from 'zod'
import { endpoint, stream } from './endpoint'

/** paper: warm white with the brand as the accent (print, deep or muted colours, no colour) · ink: near-black warmed by
 * the brand, the brand as light (vivid colours; the promo video's tone) · brand: white pages with the cover, numbers and
 * contact on the solid brand colour (saturated mid or deep colours). The server decides which fit the brand colour. */
export const DECK_THEMES = ['paper', 'ink', 'brand'] as const
export const DeckTheme = z.enum(DECK_THEMES)
export type DeckTheme = z.infer<typeof DeckTheme>

export const DECK_ARTIFACT_KEY = 'intro-deck'
export const DECK_TOOL = 'intro_deck'
export const DECK_SLIDES_MIN = 6
export const DECK_SLIDES_MAX = 10

/** The slide kinds in the order a deck keeps (cover first, about second, contact last; one scene anywhere between the
 * third slide and contact). */
export const DECK_KINDS = ['cover', 'about', 'needs', 'offer', 'numbers', 'products', 'process', 'proof', 'history', 'scene', 'contact'] as const
export type DeckKind = (typeof DECK_KINDS)[number]

const Text = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const Opt = (max: number, what: string) => z.string().trim().max(max).optional().describe(what)
const Picture = z.string().trim().min(1).max(1000).optional()
const Focus = z.enum(['center', 'top', 'bottom', 'left', 'right']).optional().describe('Which part of the picture must stay in view when it is cropped (default center). Choose it after looking at the picture.')
const Eyebrow = Text(30, 'A short label above the title in the team\'s language (at most about 12 characters), e.g. "회사 소개", "What we do".')
const Title = Text(80, 'The slide\'s message in one sentence, at most two lines of about 22 Korean characters (or 40 Latin letters). No full stop. Mark one key phrase with *stars* to show it in the accent colour (optional, once).')
const Body = (lines: number) => Text(160, `At most ${lines} lines of about 22 Korean characters each; plain words, no list marks.`)

const Cover = z.object({
  kind: z.literal('cover'),
  eyebrow: Opt(30, 'Optional line above the headline, e.g. "회사 소개서" or the field the company works in.'),
  headline: Text(60, 'What the company does in its strongest line: one or two lines of about 13 Korean characters (or 22 Latin letters). Put "\\n" where the line should break. No full stop. *stars* mark one key phrase (optional).'),
  sub: Opt(60, 'One short line under it (about 30 Korean characters), e.g. the company\'s one-line introduction.'),
  picture: Picture.describe('The team path of a picture from the brand images folder that carries the brand (a product, a place, the service in use): landscape and at least 1,600 px wide for the full-bleed cover, or at least 800 px on the short side for the split cover. Leave it out for the type-only cover. Never a picture with text baked in, never a person\'s portrait.'),
  focus: Focus,
}).strict()

const About = z.object({
  kind: z.literal('about'),
  eyebrow: Eyebrow,
  statement: Text(110, 'The company in one sentence, two or three lines of about 18 Korean characters. *stars* mark one key phrase (optional).'),
  facts: z.array(z.object({
    label: Text(16, 'What the fact is (at most about 8 characters), e.g. "설립", "위치", "분야".'),
    value: Text(28, 'The fact exactly as the material writes it (at most about 14 characters), e.g. "2019년", "서울 성수동".'),
  }).strict()).max(4).optional().describe('Up to four base facts written in the material (founded, location, field, CEO, staff). Leave out what is not written.'),
}).strict()

const Needs = z.object({
  kind: z.literal('needs'),
  eyebrow: Eyebrow,
  title: Title,
  points: z.array(z.object({ head: Text(28, 'The problem or wish in a few words (at most about 14 characters).'), body: Body(2) }).strict()).min(2).max(3)
    .describe('The customer\'s problems (business customers) or "for people who …" (consumers): two or three.'),
}).strict()

const Offer = z.object({
  kind: z.literal('offer'),
  eyebrow: Eyebrow,
  title: Title,
  sub: Opt(90, 'One plain sentence under the title (optional).'),
  pillars: z.array(z.object({ head: Text(28, 'A short name (at most about 14 characters).'), body: Body(2) }).strict()).length(3)
    .describe('The three things the company does or gives.'),
  picture: Picture.describe('Optional: a picture from the brand images folder that shows the work (at least 800 px on the short side), shown on half of the slide. Leave it out for the type-only version.'),
  focus: Focus,
}).strict()

const Numbers = z.object({
  kind: z.literal('numbers'),
  eyebrow: Eyebrow,
  title: Title.optional(),
  stats: z.array(z.object({
    number: Text(16, 'A number exactly as the material writes it, with its unit or sign, e.g. "340곳", "1,200만 개", "94%", "+300%". Never counted, computed or rounded.'),
    label: Text(24, 'What it counts, at most about 12 characters, e.g. "구독 고객사".'),
  }).strict()).min(2).max(4).describe('Two to four numbers from the material that prove the offer.'),
  note: Opt(60, 'Only when the material writes it: when the numbers are from, e.g. "2025년 12월 기준".'),
}).strict()

const Products = z.object({
  kind: z.literal('products'),
  eyebrow: Eyebrow,
  title: Title,
  items: z.array(z.object({
    name: Text(28, 'The product or service name as written (at most about 14 characters).'),
    body: Body(2),
    picture: Picture.describe('Optional: the team path of this product\'s own picture from the brand images folder (at least 400 px on the short side). Either every item has a picture or none does.'),
    focus: Focus,
  }).strict()).min(2).max(4).describe('Two to four products or services. A second products slide may follow for more.'),
}).strict()

const Process = z.object({
  kind: z.literal('process'),
  eyebrow: Eyebrow,
  title: Title,
  steps: z.array(z.object({ head: Text(20, 'The step in a few words (at most about 10 characters).'), body: Opt(100, 'Optional: two short lines at most.') }).strict()).min(3).max(5)
    .describe('How it works or how it is made: three to five steps in order.'),
}).strict()

const Proof = z.object({
  kind: z.literal('proof'),
  eyebrow: Eyebrow,
  title: Title,
  names: z.array(Text(30, 'A customer or partner name exactly as written.')).min(3).max(12).optional()
    .describe('Customers or partners the material names (3–12), shown as a wall of names. Never invented, never logos.'),
  quote: z.object({ text: Text(140, 'A customer\'s words exactly as the material quotes them.'), who: Text(40, 'Who said it, as written (name and title or company).') }).strict().optional(),
  case: z.object({
    before: z.object({ label: Text(16, 'e.g. "이전"'), text: Body(3) }).strict(),
    action: z.object({ label: Text(16, 'e.g. "한 일"'), text: Body(3) }).strict(),
    result: z.object({ label: Text(16, 'e.g. "결과"'), text: Body(3) }).strict(),
  }).strict().optional().describe('One customer case as written: the situation before, what the company did, the result.'),
}).strict().describe('Proof: exactly one of names, quote or case.')

const History = z.object({
  kind: z.literal('history'),
  eyebrow: Eyebrow,
  title: Title,
  items: z.array(z.object({ when: Text(16, 'When, exactly as written, e.g. "2019", "2023.04".'), what: Body(2) }).strict()).min(3).max(6).optional()
    .describe('Turning points (3–6), oldest first.'),
  trust: z.array(Text(40, 'A certification, patent or award exactly as written.')).min(2).max(6).optional()
    .describe('Certifications, patents or awards the material names (2–6).'),
}).strict().describe('History or trust: exactly one of items or trust.')

const Scene = z.object({
  kind: z.literal('scene'),
  eyebrow: Opt(30, 'Optional short label above the line.'),
  line: Text(40, 'One line over the picture (about 18 Korean characters). No full stop.'),
  picture: z.string().trim().min(1).max(1000).describe('The team path of a landscape picture from the brand images folder, at least 1,600 px wide, that carries the brand (a place, a product, the work).'),
  focus: Focus,
}).strict()

const Contact = z.object({
  kind: z.literal('contact'),
  eyebrow: Opt(30, 'Optional short label above the line.'),
  line: Text(60, 'The closing line: what to do next, at most two lines of about 16 Korean characters. No full stop.'),
  offer: Opt(30, 'The site\'s real offer as written, e.g. "초기 상담 무료". Leave out when the material has none.'),
  person: Opt(40, 'A contact person and title as written.'),
  email: Opt(80, 'As written in the material or the company profile.'),
  phone: Opt(30, 'As written in the material or the company profile.'),
  website: Opt(120, 'As written in the material or the company profile.'),
  address: Opt(80, 'As written in the material (one line).'),
}).strict()

export const DeckSlide = z.discriminatedUnion('kind', [Cover, About, Needs, Offer, Numbers, Products, Process, Proof, History, Scene, Contact])
export type DeckSlide = z.infer<typeof DeckSlide>

export const IntroDeckInput = z.object({
  title: z.string().trim().min(1).max(80).describe('The deck\'s name: "(company name) 회사 소개서" in the team\'s language.'),
  company: z.string().trim().min(1).max(40).describe('The company name as the material writes it.'),
  website: z.string().trim().max(200).optional().describe('The company website from the material or the company profile.'),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The brand colour "#rrggbb": the first of the company profile\'s brand colours, else one the material uses for the brand. Leave out when none is known.'),
  logo: z.string().trim().min(1).max(1000).optional().describe('The team path of the company logo in the brand images folder (PNG, JPG or WebP).'),
  theme: DeckTheme.optional().describe('paper: light warm paper, the brand colour as the accent (prints well). ink: near-black with the brand colour as light (bold; the promo video\'s look). brand: white pages, the cover, numbers and contact on the brand colour. Leave out to let the server choose from the brand colour; a theme that does not fit the colour is replaced by one that does.'),
  audience: z.string().trim().max(40).optional().describe('Who the deck is for, from the skill form (e.g. "제조업 고객사"). It sets the order of points and the tone only; it is never a fact.'),
  sources: z.array(z.string().trim().min(1).max(1000)).min(1).max(8)
    .describe('The team files the words came from (the attached company intro, deck or 회사 소개.md). Every number and name on a slide must be written in them.'),
  slides: z.array(DeckSlide).min(DECK_SLIDES_MIN).max(DECK_SLIDES_MAX).describe('6–10 slides in this order: cover, about, then needs → offer → numbers → products (up to twice) → process → proof → history, and contact last; one scene may stand anywhere between the third slide and contact. Leave out a kind without material; never pad.'),
}).strict()
export type IntroDeckInput = z.infer<typeof IntroDeckInput>

// ── round 2 (docs/DECISIONS.md "D2", round 2): an outline first, then one slide per call, then one review ──────────
// The AI still never designs: it plans the deck (`step: "outline"`), fills one slide per call (`step: "slide"`), and,
// after the server has rendered and checked every slide and shown them to it as pictures, finishes it with at most
// three slide changes (`step: "finish"`). Every content slide carries exactly one figure, drawn by the server from the
// figure's slots (never coordinates or markup); the cover, an opening and the closing may carry one AI-drawn accent
// (geometry only, at most two per deck, sanitized to an allowlist).

/** The figures the server draws (one drawing language for all). */
export const DECK_FIGURES = ['flow', 'cycle', 'hub', 'layers', 'timeline', 'compare', 'funnel', 'merge', 'grid', 'cards', 'donut', 'bars', 'line', 'figures'] as const
export const DeckFigureKind = z.enum(DECK_FIGURES)
export type DeckFigureKind = z.infer<typeof DeckFigureKind>
/** Figures that state a relationship (an order, a loop, a centre, a stack, a before/after, a convergence, narrowing):
 * the outline must give a `basis` quote from the sources that shows it. */
export const DECK_STRUCTURAL: readonly DeckFigureKind[] = ['flow', 'cycle', 'hub', 'layers', 'timeline', 'compare', 'funnel', 'merge']
/** The slide kinds of round 2, in their order (`opening` once, right after `about`). */
export const DECK2_KINDS = ['cover', 'about', 'opening', 'needs', 'offer', 'numbers', 'products', 'process', 'proof', 'history', 'contact'] as const
export type Deck2Kind = (typeof DECK2_KINDS)[number]
/** Which figures each content slide may take (DESIGN "Deck structure"). */
export const DECK_FIGURE_FOR: Record<Deck2Kind, readonly DeckFigureKind[]> = {
  cover: [], opening: [], contact: [],
  about: ['hub', 'compare', 'figures'],
  needs: ['merge', 'compare', 'grid'],
  offer: ['layers', 'grid', 'hub'],
  numbers: ['donut', 'bars', 'line', 'figures'],
  products: ['cards', 'grid'],
  process: ['flow', 'cycle'],
  proof: ['compare'],
  history: ['timeline'],
}
export const DECK_PATTERNS = ['dots', 'lines', 'contours', 'none'] as const
export const DeckPattern = z.enum(DECK_PATTERNS)
export type DeckPattern = z.infer<typeof DeckPattern>
/** How long a deck may take, one setting per team (settings key `introDeckTier`; the default is `standard`, the owner's
 * choice of 2026-11-06: the welcome moves on to other steps while the deck is made):
 * quick ≈ 3 min (the material saved at setup, one review) · standard ≈ 5 min (8–10 pages of the company's site, 2–3
 * web searches with sourced facts, a second review when the first found more than two problems) · deep ≈ 10 min
 * (about 15 pages, 6–8 searches, the strongest model the engine offers, two reviews and a headline pass). */
export const DECK_TIERS = ['quick', 'standard', 'deep'] as const
export const DeckTier = z.enum(DECK_TIERS)
export type DeckTier = z.infer<typeof DeckTier>
/** The time budget until an owner or admin picks another (the one constant to change). */
export const DEFAULT_DECK_TIER: DeckTier = 'standard'
/** About how long each budget takes, in minutes (what the progress block's note says). */
export const DECK_TIER_MINUTES: Record<DeckTier, number> = { quick: 3, standard: 5, deep: 10 }
/** The accent SVG's size cap (DESIGN "AI accents"). */
export const DECK_ACCENT_MAX_BYTES = 12_000
export const DECK_ACCENTS_MAX = 2
/** Slide changes the one review round may carry. */
export const DECK_FIXES_MAX = 3

const Icon = z.string().trim().min(1).max(40).optional().describe('A Lucide icon name from the list in the tool description (e.g. "factory", "coffee", "users"). An unknown name becomes a neutral dot. Icons are generic signs, never a claim.')
const T = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const O = (max: number, what: string) => z.string().trim().max(max).optional().describe(what)
const Key = z.number().int().min(0).max(7).optional()

const FlowFig = z.object({
  kind: z.literal('flow'),
  steps: z.array(z.object({ icon: Icon, head: T(20, 'The step in a few words (≤ 10 Korean characters).'), body: O(80, 'Optional: up to two short lines (≤ 18 Korean characters each).') }).strict()).min(3).max(5),
  key: Key.describe('The step the material stresses (default: the last).'),
}).strict().describe('Steps in order, drawn as chevrons. Only when the material states an order.')
const CycleFig = z.object({
  kind: z.literal('cycle'),
  steps: z.array(z.object({ icon: Icon, head: T(16, 'The step (≤ 8 Korean characters).') }).strict()).min(3).max(6),
  center: O(16, 'Optional words in the middle of the ring (≤ 8 Korean characters).'),
}).strict().describe('A loop. Only when the material says it repeats.')
const HubFig = z.object({
  kind: z.literal('hub'),
  center: T(16, 'The centre: one thing that connects or serves the others (≤ 8 Korean characters; "\n" may break it).'),
  items: z.array(z.object({ icon: Icon, label: T(14, 'A satellite (≤ 7 Korean characters).'), sub: O(30, 'Optional small line under it.') }).strict()).min(3).max(6),
}).strict().describe('One centre and the things it connects or serves.')
const LayersFig = z.object({
  kind: z.literal('layers'),
  items: z.array(z.object({ head: T(24, 'The layer (≤ 12 Korean characters).'), body: O(60, 'Optional: one line (≤ 30 Korean characters).'), stack: z.boolean().optional().describe('Draw it as a stack of thin layers (many layers of one thing, e.g. stacked memory).') }).strict()).min(3).max(5)
    .describe('Top layer first.'),
  key: Key.describe('The layer the material stresses (default: the first).'),
}).strict().describe('A stack: one thing built on another. Only when the material says so.')
const TimelineFig = z.object({
  kind: z.literal('timeline'),
  items: z.array(z.object({
    when: T(12, 'A year exactly as written ("2019", "2023.04"), or a place name for an order of places.'),
    head: T(24, 'What happened (≤ 12 Korean characters).'),
    body: O(40, 'Optional small line under it (≤ 20 Korean characters).'),
  }).strict()).min(3).max(6).describe('Oldest first.'),
  next: z.object({ head: T(24, 'What comes next, only when the material names it.'), body: O(40, 'Optional small line.') }).strict().optional(),
  key: Key.describe('The point the material stresses (default: the newest; for places, the first).'),
}).strict().describe('Years written in the material, or an order of places the material states.')
const Side = (what: string) => z.object({
  label: T(12, 'A small label, e.g. "이전", "지금".'),
  head: T(30, `The ${what} in a few words (≤ 14 Korean characters).`),
  items: z.array(T(50, 'A short line (≤ 24 Korean characters).')).max(3).optional(),
}).strict()
const CompareFig = z.object({
  kind: z.literal('compare'),
  before: Side('old way, the situation before or option A'),
  after: Side('new way, the situation now or option B').extend({ picture: z.string().trim().min(1).max(1000).optional().describe('Optional: a picture of the "now" side (≥ 800 px on its short side).'), focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional() }).strict(),
}).strict().describe('Before → after, old way → new way, or a case. Only a comparison the material makes.')
const FunnelFig = z.object({
  kind: z.literal('funnel'),
  stages: z.array(T(20, 'A stage (≤ 10 Korean characters). No numbers unless written.')).min(3).max(5),
}).strict().describe('Narrowing stages.')
const MergeFig = z.object({
  kind: z.literal('merge'),
  inputs: z.array(T(14, 'One channel or source (≤ 7 Korean characters).')).min(3).max(6),
  target: z.object({ icon: Icon, head: T(16, 'Where they come together (≤ 8 Korean characters).'), body: O(60, 'Optional: one or two short lines.') }).strict(),
}).strict().describe('Many channels or sources into one place.')
const GridFig = z.object({
  kind: z.literal('grid'),
  items: z.array(z.object({
    icon: Icon,
    head: T(20, 'A name (≤ 10 Korean characters).'),
    body: O(70, 'Optional: up to two short lines (≤ 20 Korean characters each).'),
    tags: z.array(T(20, 'A product or service name as written.')).max(4).optional(),
  }).strict()).min(3).max(8),
  key: Key.describe('Optional: the one the material stresses.'),
}).strict().describe('A list of offers, products, services or pains, each with an icon.')
const CardsFig = z.object({
  kind: z.literal('cards'),
  items: z.array(z.object({
    name: T(28, 'The product name as written (≤ 14 Korean characters).'),
    body: O(60, 'Optional: up to two short lines.'),
    picture: z.string().trim().min(1).max(1000).describe('This product\'s own picture (≥ 400 px on its short side; no banner lettering).'),
    focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional(),
  }).strict()).min(2).max(4),
}).strict().describe('Product pictures as cards.')
const Value = T(16, 'A number exactly as written in the material, with its unit or sign ("80.2%", "340곳", "2주"). Never counted, computed or rounded.')
const DonutFig = z.object({
  kind: z.literal('donut'),
  items: z.array(z.object({ value: T(12, 'A share of a whole, exactly as written, e.g. "80.2%" (≤ 100 %).'), label: T(24, 'What it is (≤ 12 Korean characters).') }).strict()).min(1).max(3),
}).strict().describe('Shares of a whole written as %.')
const BarsFig = z.object({
  kind: z.literal('bars'),
  items: z.array(z.object({ label: T(20, 'What the bar is (≤ 10 Korean characters).'), value: Value }).strict()).min(2).max(4).describe('Values in the same unit.'),
  key: Key.describe('The bar the material stresses (default: the largest).'),
}).strict().describe('At least two values in the same unit, compared at true scale.')
const LineFig = z.object({
  kind: z.literal('line'),
  points: z.array(z.object({ x: T(12, 'The year or date as written.'), value: Value }).strict()).min(3).max(8),
}).strict().describe('At least three dated values.')
const FiguresFig = z.object({
  kind: z.literal('figures'),
  items: z.array(z.object({ number: Value, label: T(24, 'What it counts (≤ 12 Korean characters).') }).strict()).min(2).max(4),
}).strict().describe('Single numbers in a row.')
export const DeckFigure = z.discriminatedUnion('kind', [FlowFig, CycleFig, HubFig, LayersFig, TimelineFig, CompareFig, FunnelFig, MergeFig, GridFig, CardsFig, DonutFig, BarsFig, LineFig, FiguresFig])
export type DeckFigure = z.infer<typeof DeckFigure>

const Pic = z.string().trim().min(1).max(1000).optional()
const Foc = z.enum(['center', 'top', 'bottom', 'left', 'right']).optional()
const Accent = z.string().max(DECK_ACCENT_MAX_BYTES).optional().describe('The decorative accent: an SVG in the grammar of the tool description (viewBox 0 0 800 800, geometric shapes only, colours by name). Draw one on the closing, and one on the cover when it has no picture; at most two per deck.')
const Title2 = T(80, 'The slide\'s message in one sentence, at most two lines of about 22 Korean characters (or 40 Latin letters). No full stop.')
const FIG_SCHEMA = { flow: FlowFig, cycle: CycleFig, hub: HubFig, layers: LayersFig, timeline: TimelineFig, compare: CompareFig, funnel: FunnelFig, merge: MergeFig, grid: GridFig, cards: CardsFig, donut: DonutFig, bars: BarsFig, line: LineFig, figures: FiguresFig } as const
type FigSchema<K extends DeckFigureKind> = (typeof FIG_SCHEMA)[K]
/** The figures one slide kind may take, as their own union (the AI's schema lists only these). */
const Fig = <K extends DeckFigureKind>(...kinds: [K, ...K[]]) => (kinds.length === 1 ? FIG_SCHEMA[kinds[0]] : z.discriminatedUnion('kind', kinds.map((k) => FIG_SCHEMA[k]) as unknown as [FigSchema<K>, FigSchema<K>, ...FigSchema<K>[]])) as z.ZodType<z.infer<FigSchema<K>>>

export const DeckSlide2 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cover'), headline: T(60, 'One or two lines of about 10 Korean characters (or 17 Latin letters) each; "\n" breaks the line. No full stop. *stars* mark one key phrase.'), sub: O(60, 'One short line under it.'), picture: Pic, focus: Foc, accent: Accent }).strict(),
  z.object({
    kind: z.literal('about'),
    statement: T(110, 'The company in one sentence: with a hub or no figure, up to four lines of about 15 Korean characters; with a compare or figures figure it is set as the title (two lines of about 22).'),
    facts: z.array(z.object({ label: T(16, 'e.g. "설립", "위치".'), value: T(28, 'As written.') }).strict()).max(4).optional(),
    figure: Fig('hub', 'compare', 'figures').optional(),
  }).strict(),
  z.object({ kind: z.literal('opening'), line: T(48, 'One line opening the next part: two or three lines of about 9 Korean characters (or 15 Latin letters). No full stop.'), sub: O(70, 'Optional sub-line.'), picture: Pic, focus: Foc, accent: Accent }).strict(),
  z.object({ kind: z.literal('needs'), title: Title2, figure: Fig('merge', 'compare', 'grid') }).strict(),
  z.object({ kind: z.literal('offer'), title: Title2, sub: O(90, 'One plain sentence under the title (optional).'), figure: Fig('layers', 'grid', 'hub') }).strict(),
  z.object({ kind: z.literal('numbers'), title: Title2, note: O(60, 'Only when written: when the numbers are from, e.g. "2025년 12월 기준".'), figure: Fig('donut', 'bars', 'line', 'figures') }).strict(),
  z.object({ kind: z.literal('products'), title: Title2, figure: Fig('cards', 'grid') }).strict(),
  z.object({ kind: z.literal('process'), title: Title2, figure: Fig('flow', 'cycle') }).strict(),
  z.object({
    kind: z.literal('proof'),
    title: O(80, 'Optional title.'),
    quote: z.object({ text: T(140, 'A customer\'s words exactly as the material quotes them.'), who: T(40, 'Who said it, as written.') }).strict().optional(),
    names: z.array(T(30, 'A customer or partner name exactly as written.')).min(3).max(12).optional(),
    figure: Fig('compare').optional(),
  }).strict().describe('Exactly one of quote, names or a compare figure (a case).'),
  z.object({ kind: z.literal('history'), title: Title2, figure: Fig('timeline') }).strict(),
  z.object({
    kind: z.literal('contact'),
    line: T(60, 'The closing line, at most two lines of about 12 Korean characters (or 20 Latin letters). No full stop.'),
    offer: O(30, 'The site\'s real call to action as written, e.g. "무료로 시작하기". Leave out when there is none.'),
    person: O(40, 'A contact person and title as written.'),
    email: O(80, 'As written.'), phone: O(30, 'As written.'), website: O(120, 'As written.'), address: O(80, 'As written (one line).'),
    accent: Accent,
  }).strict(),
])
export type DeckSlide2 = z.infer<typeof DeckSlide2>

export const DeckPictureNote = z.object({
  path: z.string().trim().min(1).max(1000),
  subject: T(80, 'What the picture shows, in a few words.'),
  lettering: z.boolean().describe('Does it carry lettering where type would sit (banner text, signs, product markings in the open area)?'),
  calm: z.enum(['left', 'right', 'top', 'bottom', 'none']).describe('The side with quiet, even area where type could sit; none when it is busy everywhere.'),
  tone: z.enum(['dark', 'light', 'mixed']).describe('Mostly dark, mostly light, or mixed.'),
}).strict()
export type DeckPictureNote = z.infer<typeof DeckPictureNote>

export const DeckStub = z.object({
  kind: z.enum(DECK2_KINDS),
  section: T(14, 'The section name for the running footer and the progress tile (≤ 7 Korean characters), e.g. "회사 소개", "숫자".'),
  headline: T(80, 'The headline draft.'),
  figure: DeckFigureKind.optional().describe('The figure this slide will carry (content slides).'),
  basis: z.string().trim().max(240).optional().describe('For flow, cycle, hub, layers, timeline, compare, funnel and merge: a sentence copied from the sources that shows the order, loop, centre, stack, comparison or convergence.'),
  picture: Pic.describe('The picture this slide will use, if any.'),
}).strict()
export type DeckStub = z.infer<typeof DeckStub>

const OutlineStep = z.object({
  step: z.literal('outline'),
  title: z.string().trim().min(1).max(80).describe('The deck\'s name: "(company name) 회사 소개서" in the team\'s language.'),
  company: z.string().trim().min(1).max(40).describe('The company name as the material writes it.'),
  website: z.string().trim().max(200).optional().describe('The company website from the material or the company profile.'),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The brand colour "#rrggbb" (the company profile\'s first, else one the material uses for the brand).'),
  logo: z.string().trim().min(1).max(1000).optional().describe('The team path of the logo in the brand images folder.'),
  theme: DeckTheme.optional().describe('paper, ink or brand; leave out to let the server choose from the brand colour and the pictures.'),
  audience: z.string().trim().max(40).optional().describe('Who the deck is for (order and tone only; never a fact).'),
  sources: z.array(z.string().trim().min(1).max(1000)).min(1).max(8).describe('The team files the words come from.'),
  pattern: DeckPattern.describe('The drawn pattern from the company\'s world: dots (technology, data, manufacturing, printed or riveted things), lines (architecture, finance, law, precision), contours (places, land, food origin, travel, outdoor), none when unsure.'),
  pictures: z.array(DeckPictureNote).max(12).optional().describe('A note for every picture you may use (after looking at each).'),
  web_sources: z.array(z.object({
    url: z.string().trim().min(1).max(2000).describe('An article or page you opened with web_fetch in this answer.'),
    outlet: z.string().trim().min(1).max(60).describe('Who published it (a newspaper, a magazine, an association), as the page shows it.'),
    date: z.string().trim().min(1).max(30).describe('Its date as the page shows it.'),
  }).strict()).max(8).optional().describe('Only when the tool description allows web searches: outside articles whose facts the deck uses. The server reads each again; a fact from one is checked against it and cited in the speaker notes. A fact without a source here cannot be used.'),
  slides: z.array(DeckStub).min(DECK_SLIDES_MIN).max(DECK_SLIDES_MAX),
}).strict()
const ReadStep = z.object({
  step: z.literal('read'),
  urls: z.array(z.string().trim().min(1).max(2000)).max(15).optional().describe('Optional: pages of the company\'s own website you want read (links you saw); the server adds the site\'s about, product, case and news pages up to the budget.'),
}).strict()
const SlideStep = z.object({
  step: z.literal('slide'),
  index: z.number().int().min(0).max(DECK_SLIDES_MAX - 1).describe('The slide\'s place in the outline (0 = the cover).'),
  slide: DeckSlide2,
}).strict()
const FinishStep = z.object({
  step: z.literal('finish'),
  fixes: z.array(z.object({
    index: z.number().int().min(0).max(DECK_SLIDES_MAX - 1),
    slide: DeckSlide2,
    basis: z.string().trim().max(240).optional().describe('Needed when the change swaps to another structural figure.'),
  }).strict()).max(DECK_FIXES_MAX).optional().describe('At most three slides changed after the review; leave out when every slide is right.'),
  drop_accents: z.array(z.number().int().min(0).max(DECK_SLIDES_MAX - 1)).max(DECK_ACCENTS_MAX).optional().describe('Slides whose accent looks clumsy: it is dropped (the drawn pattern stays).'),
  headlines: z.array(z.object({ index: z.number().int().min(0).max(DECK_SLIDES_MAX - 1), text: z.string().trim().min(1).max(110) }).strict()).max(DECK_SLIDES_MAX).optional()
    .describe('Only when the result asks for the headline pass: a stronger headline for a slide (its title, headline, statement or line), same facts, same length rules.'),
}).strict()
export const IntroDeckStep = z.discriminatedUnion('step', [ReadStep, OutlineStep, SlideStep, FinishStep])
/** What the AI is shown: one object (a tool's input schema must be an object, not a union), every step's fields
 * optional and named by the step that takes them; calls are still parsed with the strict union above. */
export const IntroDeckListing = z.object({
  step: z.enum(['read', 'outline', 'slide', 'finish']).describe('read (only when the tool description says so), then outline (title … slides), then slide once per slide (index, slide), then finish (fixes, drop_accents, headlines).'),
  urls: ReadStep.shape.urls.describe('read: optional pages of the company\'s own site to read.'),
  ...Object.fromEntries(Object.entries(OutlineStep.shape).filter(([k]) => k !== 'step').map(([k, v]) => [k, (v as z.ZodType).optional().describe(`outline: ${(v as z.ZodType).description ?? k}`)])),
  index: SlideStep.shape.index.optional().describe('slide: the slide\'s place in the outline (0 = the cover).'),
  slide: DeckSlide2.optional().describe('slide: the slide\'s slots.'),
  fixes: z.array(z.object({
    index: z.number().int().min(0).max(DECK_SLIDES_MAX - 1),
    slide: z.object({ kind: z.enum(DECK2_KINDS) }).loose().describe('The whole slide again, in the same form as `slide`.'),
    basis: z.string().max(240).optional(),
  })).max(DECK_FIXES_MAX).optional().describe('finish: at most three slides changed after the review; leave out when every slide is right.'),
  drop_accents: FinishStep.shape.drop_accents.describe('finish: slides whose accent looks clumsy.'),
  headlines: FinishStep.shape.headlines.describe('finish: only when asked for the headline pass.'),
})
export type IntroDeckStep = z.infer<typeof IntroDeckStep>
export type IntroDeckOutline = z.infer<typeof OutlineStep>
export type IntroDeckRead = z.infer<typeof ReadStep>
export type IntroDeckSlideStep = z.infer<typeof SlideStep>
export type IntroDeckFinish = z.infer<typeof FinishStep>

/** One planned slide of a deck being built, as the chat's progress block and the panel show it. */
export const DeckBuildSlide = z.object({
  kind: z.enum(DECK2_KINDS),
  /** the outline's section name (team language) */
  section: z.string(),
  figure: DeckFigureKind.nullable(),
  /** a picture ground (the cover or an opening on a site picture): "brand colour on the site picture" in the sub-line */
  picture: z.boolean(),
  status: z.enum(['planned', 'working', 'done']),
  /** bumps whenever the slide is drawn again (thumbnail cache key) */
  rev: z.number().int().nonnegative(),
})
export type DeckBuildSlide = z.infer<typeof DeckBuildSlide>
/** A deck being built in a chat turn (the draft before the artifact): what the progress block and the panel show. */
export const DeckBuild = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string().nullable(),
  title: z.string(),
  phase: z.enum(['reading', 'slides', 'review', 'done', 'failed']),
  /** the time budget it was made with (absent from older servers: quick) */
  tier: DeckTier.optional(),
  /** what the longer budgets read before the outline: pages of the company's site and outside articles */
  read: z.object({ pages: z.number().int().nonnegative(), articles: z.number().int().nonnegative() }).optional(),
  slides: z.array(DeckBuildSlide),
  /** the slide being made now (its position in `slides`), or null */
  current: z.number().int().nullable(),
  /** the click (the turn's start), the outline, the last slide, the end */
  startedAt: z.string(),
  outlineAt: z.string().nullable(),
  slidesAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** the finished deck's artifact */
  artifactId: z.string().nullable(),
  /** slide pictures exist (typst on this server): GET /api/intro-decks/builds/:id/slides/:n */
  thumbs: z.boolean(),
})
export type DeckBuild = z.infer<typeof DeckBuild>
export const DeckBuildList = z.object({ builds: z.array(DeckBuild) })
export type DeckBuildList = z.infer<typeof DeckBuildList>

export const IntroDeckInfo = z.object({
  artifactId: z.string(),
  chatId: z.string(),
  title: z.string(),
  theme: DeckTheme,
  slides: z.number(),
  /** what this server can give: the PowerPoint file always, the PDF only where typst and the fonts are */
  pptx: z.boolean(),
  pdf: z.boolean(),
})
export type IntroDeckInfo = z.infer<typeof IntroDeckInfo>

export const INTRO_DECK = {
  getIntroDeck: endpoint({ method: 'GET', path: '/api/intro-decks/:id', auth: 'user', owner: 'B', response: IntroDeckInfo,
    summary: 'An intro deck of one of the caller\'s chats, by its artifact id: its title, theme, slide count and which files this server can make (PowerPoint always, PDF where typst is).' }),
  downloadIntroDeckPptx: endpoint({ method: 'GET', path: '/api/intro-decks/:id/pptx', auth: 'user', owner: 'B', response: stream(false),
    summary: 'Download an intro deck as a PowerPoint file (built from the checked slides, with the pictures the chat\'s owner can read now).' }),
  listDeckBuilds: endpoint({ method: 'GET', path: '/api/intro-decks/builds', auth: 'user', owner: 'B', query: z.object({ chatId: z.string().min(1).max(64) }), response: DeckBuildList,
    summary: 'The intro decks being built or built in round 2 in one of the caller\'s chats (newest first, at most 10): the planned slides, which are done, the step times and the finished artifact.' }),
  deckBuildSlide: endpoint({ method: 'GET', path: '/api/intro-decks/builds/:id/slides/:n', auth: 'user', owner: 'B', response: stream(false),
    summary: 'A picture (PNG, 960 × 540) of one finished slide of a deck being built (n: its position in the build\'s `slides`), for the progress block and the panel (404 until it is drawn, or where this server has no typst).' }),
  downloadIntroDeckPdf: endpoint({ method: 'GET', path: '/api/intro-decks/:id/pdf', auth: 'user', owner: 'B', response: stream(false),
    summary: 'Download an intro deck as a PDF (404 where this server has no typst).' }),
} as const
