// The `promo_video` tool (docs/DECISIONS.md "V"): the AI hands over the slots of a promo video, the server checks them
// (spec.ts), builds the composition from our template (template.ts) and keeps it as the chat's artifact
// "promo-video" (a new version each time), with the checked slots in promo_videos for the MP4 (render.ts).
// A failed check is one answer listing every problem; the AI may try once more in the same answer. A second failure
// tells it to stop and say in one plain sentence why there is no video (no third try in that answer).
import { PROMO_ARTIFACT_KEY, PROMO_TOOL, PromoVideoInput, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { teamDefaultLocale } from '../admin/settings'
import { Denied, ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import type { ToolRegistry } from '../tools/registry'
import { sceneTimes } from './layout'
import { checkPromoInput } from './spec'
import { artifactDocument, type PlayerText } from './template'

/** The font face file the artifact page loads from this server (web/scripts/build-vendor.ts writes it). */
export const PROMO_FONT_CSS = '/vendor/fonts/promo-video.css'

/** What people call the styles (the answer names the style this way, never by its id). */
const STYLE_NAME: Record<Locale, Record<'bold' | 'editorial' | 'night', string>> = {
  ko: { bold: '임팩트', editorial: '매거진', night: '시네마틱' },
  en: { bold: 'Bold', editorial: 'Editorial', night: 'Cinematic' },
  id: { bold: 'Tegas', editorial: 'Editorial', night: 'Sinematik' },
  ja: { bold: 'インパクト', editorial: 'マガジン', night: 'シネマティック' },
  es: { bold: 'Impacto', editorial: 'Editorial', night: 'Cinemático' },
}

const PLAYER: Record<Locale, PlayerText & { title: string }> = {
  ko: { title: '홍보 영상', play: '재생', pause: '일시정지', replay: '처음부터', stills: '장면 {n}', scene: (n) => `장면 ${n}` },
  en: { title: 'Promo video', play: 'Play', pause: 'Pause', replay: 'From the start', stills: 'Scene {n}', scene: (n) => `Scene ${n}` },
  id: { title: 'Video promosi', play: 'Putar', pause: 'Jeda', replay: 'Dari awal', stills: 'Adegan {n}', scene: (n) => `Adegan ${n}` },
  ja: { title: 'プロモーション動画', play: '再生', pause: '一時停止', replay: '最初から', stills: 'シーン {n}', scene: (n) => `シーン ${n}` },
  es: { title: 'Vídeo promocional', play: 'Reproducir', pause: 'Pausa', replay: 'Desde el inicio', stills: 'Escena {n}', scene: (n) => `Escena ${n}` },
}

export const PROMO_TOOL_DESCRIPTION =
  'Make the company\'s promo video (about 14 s, 1080×1350) from one of our templates. You never write HTML or CSS for it: you fill the slots below, ' +
  'the server checks them and builds the video, which shows next to the chat (artifact "promo-video"; calling again makes a new version). ' +
  'Read the material first (the files you name in `sources`), look at the photos in the brand images folder, then call this once with every slot. ' +
  'Rules the server checks: every number on screen is written in the sources (the proof number exactly as written, with its unit); each headline line ' +
  'fits (about 12 Korean characters or 22 Latin letters; a line too wide comes back as a problem); photos come only from the team\'s brand images folder, ' +
  'each at most once, at least 600 px on the short side; a scene without a fitting photo is made type-only (leave `picture` out). ' +
  'If the result lists problems, fix all of them and call once more; if it fails again, stop and tell the person why in one plain sentence.'

/** Calls per turn: the first try and one rewrite. */
const tries = new Map<string, number>()
const MAX_TRIES = 2

function turnChat(ctx: AppContext, t: ToolCtx): { chatId: string; messageId: string | null } {
  if (!t.turnId) throw new ToolError('promo_video only works inside a chat turn')
  const r = ctx.db.query('SELECT chat_id, message_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; message_id: string | null; user_id: string } | null
  if (!r) throw new ToolError('unknown turn')
  if (r.user_id !== t.user.id) throw new Denied('turn belongs to another person')
  return { chatId: r.chat_id, messageId: r.message_id }
}

export async function makePromoVideo(ctx: AppContext, a: PromoVideoInput, t: ToolCtx): Promise<{ text: string; summary: string; structured: Record<string, unknown> }> {
  const turn = turnChat(ctx, t)
  const key = t.turnId ?? ''
  const n = (tries.get(key) ?? 0) + 1
  if (n > MAX_TRIES) throw new ToolError('Do not call promo_video again in this answer. Tell the person in one plain sentence that the video could not be made this time and why (the problems you were given).')
  tries.set(key, n)
  if (tries.size > 2000) for (const k of [...tries.keys()].slice(0, 1000)) tries.delete(k)
  const lang = teamDefaultLocale(ctx.db)
  const checked = await checkPromoInput(ctx, t, a, lang)
  if (!checked.ok) {
    const list = checked.problems.map((p) => `- ${p}`).join('\n')
    if (n >= MAX_TRIES) throw new ToolError(`The video could not be made:\n${list}\nDo not call promo_video again in this answer. Tell the person in one plain sentence that the video could not be made this time and why, in their language.`)
    throw new ToolError(`Nothing was made yet. Fix every problem below and call promo_video once more with all the slots:\n${list}`)
  }
  const { doc } = checked.spec
  const text = PLAYER[lang]
  const html = artifactDocument(doc, { fontCss: PROMO_FONT_CSS, text, title: a.title })
  const c = componentC(ctx)
  const prev = ctx.db.query('SELECT 1 FROM artifacts WHERE chat_id = ? AND key = ? LIMIT 1').get(turn.chatId, PROMO_ARTIFACT_KEY)
  const s = c.artifacts.apply({ userId: t.user.id, ...turn }, { action: prev ? 'rewrite' : 'create', key: PROMO_ARTIFACT_KEY, type: 'html', title: a.title, content: html } as Parameters<typeof c.artifacts.apply>[1])
  ctx.db.query('INSERT INTO promo_videos (artifact_id, chat_id, user_id, spec, created_at) VALUES (?,?,?,?,?)')
    .run(s.id, turn.chatId, t.user.id, JSON.stringify({ title: a.title, sources: checked.spec.sources, doc }), new Date().toISOString())
  tries.delete(key)
  const { duration } = sceneTimes()
  const withPhoto = doc.scenes.filter((x) => x.picture).map((x) => x.kind)
  const typeOnly = doc.scenes.filter((x) => !x.picture).map((x) => x.kind)
  return {
    text: `Made the promo video "${a.title}" (${duration} s, the "${STYLE_NAME[lang][a.style]}" style; scenes with a photo: ${withPhoto.join(', ') || 'none'}; type-only: ${typeOnly.join(', ') || 'none'}). ` +
      `It plays next to the chat. In your answer: one or two short lines on what the video says and why the "${STYLE_NAME[lang][a.style]}" style (call it by that name; no style ids, colour codes or other technical words); if some scenes are type-only, one line that photos added to the brand images folder can go in next time. ` +
      'Never paste HTML or the slots, and do not list the scenes again.',
    summary: `${PROMO_TOOL} ${a.style} -> artifact ${s.key} v${s.version}`,
    structured: { key: s.key, version: s.version, artifactId: s.id },
  }
}

export function registerPromoVideo(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: PROMO_TOOL,
    description: PROMO_TOOL_DESCRIPTION,
    input: PromoVideoInput,
    describe: (a) => `${PROMO_TOOL} ${a.style}`,
    run: (a, t) => makePromoVideo(ctx, a, t),
  })
}
