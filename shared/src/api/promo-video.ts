// The company's promo video (docs/DECISIONS.md "V — The first result is the company's promo video"). The AI never
// writes the video: it fills the slots below with the `promo_video` tool, the server checks them (lengths that fit,
// numbers that are written in the material, pictures from a brand folder, the style that fits the brand colour) and
// builds a HyperFrames composition from our template (server/src/promo-video/): five beats on a 120 BPM grid with
// music. The chat shows it as an artifact that plays in the browser (muted until the person turns the sound on);
// [영상 파일로 받기] renders the same composition with its sound to an MP4 where the server can (a development Mac today).
import { z } from 'zod'
import { endpoint, stream } from './endpoint'

/**
 * The style families: ink (near-black, the brand colour as a bright accent and light), deep (a ground of the brand's
 * own hue at night depth, a soft tint of it as the accent), mono (graphite and white). The server decides which fit
 * the brand colour (no usable colour: mono only); the AI picks among those.
 */
export const PROMO_STYLES = ['ink', 'deep', 'mono'] as const
export const PromoStyle = z.enum(PROMO_STYLES)
export type PromoStyle = z.infer<typeof PromoStyle>

/** The music beds (all on the same 120 BPM grid): bright and driving · calm and premium · a dark cinematic pulse. */
export const PROMO_MUSIC = ['bright', 'calm', 'pulse'] as const
export const PromoMusic = z.enum(PROMO_MUSIC)
export type PromoMusic = z.infer<typeof PromoMusic>

/** The artifact key the promo video is stored under (one per chat; a new call replaces it as a new version). */
export const PROMO_ARTIFACT_KEY = 'promo-video'
export const PROMO_TOOL = 'promo_video'

const Text = (max: number, what: string) => z.string().trim().max(max).describe(what)
const Line = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const Headline = (what: string) => z.array(z.string().trim().min(1).max(40)).min(1).max(2)
  .describe(`${what} One or two lines, split where the line should break on screen: at most about 11 Korean characters (spaces count) or 20 Latin letters per line. No full stop at the end. Mark the one key phrase with *stars* (once, e.g. "*팀 전체*가 씁니다"); it is shown in the accent colour.`)
const Picture = z.string().trim().min(1).max(1000).optional()
const Focus = z.enum(['center', 'top', 'bottom', 'left', 'right']).optional().describe('Which part of the picture must stay in view when it is cropped (default center).')

export const PromoVideoInput = z.object({
  title: z.string().trim().min(1).max(80).describe('The video\'s name, e.g. "(회사 이름) 홍보 영상".'),
  company: z.string().trim().min(1).max(40).describe('The company name as the material writes it.'),
  website: z.string().trim().max(200).optional().describe('The company website from the material or the company profile, shown at the end.'),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The brand colour "#rrggbb": the first of the company profile\'s brand colours, else one the material uses for the brand. Leave out when none is known.'),
  logo: z.string().trim().min(1).max(1000).optional().describe('The team path of the company logo in the brand images folder (PNG, JPG or WebP), shown on the end card.'),
  style: PromoStyle.optional().describe('ink: near-black with the brand colour as bright light (bold, energetic, consumer and tech). deep: a dark ground of the brand\'s own colour, calm and editorial (B2B, services, craft). mono: black and white, premium. Leave out to let the server choose from the brand colour; a style that does not fit the colour is replaced by one that does.'),
  music: PromoMusic.optional().describe('bright: upbeat and driving. calm: light and premium. pulse: dark and cinematic. Leave out to match the style.'),
  sources: z.array(z.string().trim().min(1).max(1000)).min(1).max(5)
    .describe('The team files the words came from (the attached company intro, deck or 회사 소개.md). Every number on screen must be written in them.'),
  hook: z.object({
    label: Line(40, 'One short line above the big words saying what is measured or who it is about, in the customer\'s words, e.g. "견적 한 건 작성 시간".'),
    before: Line(16, 'The old state the customer knows, one to three words shown huge, e.g. "반나절" or "빈 폴더". At most about 6 Korean characters.'),
    after: Line(16, 'The new state the company gives, one to three words shown huge in the accent colour, e.g. "14초" or "팀의 지식". A number here must be written in the material.'),
    line: Text(40, 'One short line under it that finishes the thought or names where the number comes from, e.g. "운영 환경에서 직접 측정". Optional.').optional(),
    mode: z.enum(['strike', 'swap']).optional().describe('strike: the old words are struck through and the new ones slam in under them (best for a number or a big contrast). swap: the new words replace the old ones in the same place (best for words). Default: strike when "after" has a number, else swap.'),
  }).strict().describe('Beat 1, the hook: the customer\'s outcome as a before → after.'),
  promise: z.object({
    headline: Headline('Beat 2: the promise, what the company gives, in one sentence.'),
    sub: Text(60, 'One plain sentence under it (about 30 Korean characters). Optional.').optional(),
    picture: Picture.describe('The team path of a wide brand picture from the brand images folder (a product, a place, the service in use) shown full bleed under the words; leave it out for a type-and-light version.'),
    focus: Focus,
  }).strict(),
  work: z.object({
    kicker: Line(24, 'A short label above the headline naming what it is, e.g. "자동차 부품 견적 AI".'),
    headline: Headline('Beat 3: what the company does or makes, concretely.'),
    points: z.array(z.string().trim().min(1).max(20)).max(3).optional().describe('Up to three very short items (about 10 Korean characters each), e.g. features or services, written in the material.'),
    picture: Picture.describe('The team path of the company\'s own picture that shows the work (a product screen, the product, the place, the service) from the brand images folder, shown in a floating window; leave it out for a type-and-light version.'),
    focus: Focus,
  }).strict(),
  proof: z.object({
    stats: z.array(z.object({
      number: z.string().trim().min(1).max(16).describe('A number exactly as the material writes it, with its unit or sign, e.g. "+300%", "1,200곳", "4.92", "×5". Never counted, computed or rounded.'),
      label: Line(30, 'What the number is, in a few words, e.g. "구매 전환율 · 영업 챗봇".'),
    }).strict()).max(2).optional().describe('Beat 4: one or two numbers from the material that prove the promise (results, customers, years). Leave it out when the material has no such number.'),
    headline: z.array(z.string().trim().min(1).max(40)).max(2).optional().describe('Without numbers: the most concrete fact as a statement in one or two lines (*stars* mark the key phrase). With one number: an optional short line under it.'),
    sub: Text(60, 'One plain sentence under it. Optional.').optional(),
    picture: Picture.describe('Optional: a picture from the brand images folder shown dimmed behind the numbers.'),
    focus: Focus,
  }).strict(),
  cta: z.object({
    line: Line(30, 'What the company is, in one short line under its name, e.g. "AI 개발·AX 전문 파트너".'),
    offer: Text(20, 'The site\'s real offer or next step as written there, e.g. "14일 무료 체험", "초기 상담 무료", "매장 방문 예약". Leave it out when the material has none.').optional(),
  }).strict().describe('Beat 5, the end card: the logo (or the name), this line, the offer and the website.'),
}).strict()
export type PromoVideoInput = z.infer<typeof PromoVideoInput>

/** none: never made · rendering: an MP4 is being made · done: ready to download · failed: the last try failed */
export const PromoMp4State = z.enum(['none', 'rendering', 'done', 'failed'])
export type PromoMp4State = z.infer<typeof PromoMp4State>

export const PromoVideoInfo = z.object({
  artifactId: z.string(),
  chatId: z.string(),
  title: z.string(),
  style: PromoStyle,
  duration: z.number(),
  mp4: z.object({
    /** this server can make the MP4 (a development Mac with the HyperFrames CLI; nothing else yet): else no button */
    available: z.boolean(),
    state: PromoMp4State,
    /** seconds the last render took */
    seconds: z.number().nullable(),
    bytes: z.number().nullable(),
  }),
})
export type PromoVideoInfo = z.infer<typeof PromoVideoInfo>

export const PROMO_VIDEO = {
  getPromoVideo: endpoint({ method: 'GET', path: '/api/promo-videos/:id', auth: 'user', owner: 'B', response: PromoVideoInfo,
    summary: 'A promo video of one of the caller\'s chats, by its artifact id: its style and length, and whether an MP4 can be made here and how far it is.' }),
  renderPromoVideo: endpoint({ method: 'POST', path: '/api/promo-videos/:id/mp4', auth: 'user', owner: 'B', response: PromoVideoInfo, status: 202,
    summary: 'Make the MP4 of a promo video (one at a time on this server; an MP4 made before is kept). 404 where this server cannot make one.' }),
  downloadPromoVideo: endpoint({ method: 'GET', path: '/api/promo-videos/:id/mp4', auth: 'user', owner: 'B', response: stream(false),
    summary: 'Download the MP4 of a promo video once it is made.' }),
} as const
