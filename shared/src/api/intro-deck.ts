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
  downloadIntroDeckPdf: endpoint({ method: 'GET', path: '/api/intro-decks/:id/pdf', auth: 'user', owner: 'B', response: stream(false),
    summary: 'Download an intro deck as a PDF (404 where this server has no typst).' }),
} as const
