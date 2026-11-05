// The company's promo video (docs/DECISIONS.md "V — The first result is the company's promo video"). The AI never
// writes the video: it fills the slots below with the `promo_video` tool, the server checks them (lengths that fit,
// numbers that are written in the material, pictures from a brand folder, colours) and builds a HyperFrames
// composition from one of our templates (server/src/promo-video/). The chat shows it as an artifact that plays in the
// browser; [영상 파일로 받기] renders the same composition to an MP4 where the server can (a development Mac today).
import { z } from 'zod'
import { endpoint, stream } from './endpoint'

/** The three templates: brand-coloured panels and heavy type · paper and a running header · dark with a brand glow */
export const PROMO_STYLES = ['bold', 'editorial', 'night'] as const
export const PromoStyle = z.enum(PROMO_STYLES)
export type PromoStyle = z.infer<typeof PromoStyle>

/** The artifact key the promo video is stored under (one per chat; a new call replaces it as a new version). */
export const PROMO_ARTIFACT_KEY = 'promo-video'
export const PROMO_TOOL = 'promo_video'

const Text = (max: number, what: string) => z.string().trim().max(max).describe(what)
const PromoScene = z.object({
  eyebrow: Text(40, 'A short label above the headline (about 2 to 14 characters), e.g. "도입 효과". Not the headline again.'),
  headline: z.array(z.string().trim().min(1).max(40)).min(1).max(2)
    .describe('One or two short lines, as they will break on screen: each line at most about 12 Korean characters (spaces count) or 22 Latin letters. No full stop at the end.'),
  sub: Text(120, 'One plain sentence under the headline that fits two lines (about 40 Korean or 70 Latin characters).'),
  picture: z.string().trim().min(1).max(1000).optional()
    .describe('The team path of a photo from the team\'s brand images folder (…/브랜드/이미지/…) that shows this scene\'s subject; leave it out for a type-only scene. Never the same photo twice.'),
  focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional().describe('Which part of the photo must stay in view when it is cropped (default center).'),
}).strict()

export const PromoVideoInput = z.object({
  title: z.string().trim().min(1).max(80).describe('The video\'s name, e.g. "(회사 이름) 홍보 영상".'),
  style: PromoStyle.describe('bold: brand-coloured panels and heavy type (strong, consumer-facing). editorial: paper, a running header, calm (B2B, services, craft). night: dark with a brand glow (premium, tech).'),
  company: z.string().trim().min(1).max(40).describe('The company name as the material writes it.'),
  website: z.string().trim().max(200).optional().describe('The company website from the material or the company profile, shown on the last scene.'),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The brand colour "#rrggbb": the first of the company profile\'s brand colours, else one the material uses for the brand. Leave out when none is known.'),
  logo: z.string().trim().min(1).max(1000).optional().describe('The team path of the company logo in the brand images folder (a PNG, JPG or WebP), shown on the last scene.'),
  sources: z.array(z.string().trim().min(1).max(1000)).min(1).max(5)
    .describe('The team files the words came from (the attached company intro, deck or 회사 소개.md). Every number on screen must be written in them.'),
  cover: PromoScene.describe('Scene 1: the strongest claim of the material (what the company gives its customers).'),
  problem: PromoScene.describe('Scene 2: the customer\'s problem or situation (or who the company is for).'),
  solution: PromoScene.describe('Scene 3: what the company does about it.'),
  proof: PromoScene.extend({
    number: z.string().trim().min(1).max(24).optional().describe('One number exactly as the material writes it, with its unit (e.g. "18%", "1,200곳", "7년"). Never counted, computed or rounded. Leave it out only when the material has no number at all: the headline is then the most concrete fact, shown large.'),
    label: Text(40, 'What the number is, in a few words (e.g. "평균 전기요금 절감"); empty without a number.').optional(),
  }).strict().describe('Scene 4: one number from the material, shown large (or, without any number in the material, the most concrete fact).'),
  cta: PromoScene.describe('Scene 5: the next step (contact, visit, try) with the logo.'),
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
