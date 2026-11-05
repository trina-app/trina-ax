// The `promo_video` tool (docs/DECISIONS.md "V"): the AI hands over the slots of a promo video, the server checks them
// (spec.ts), builds the composition from our template (template.ts) and keeps it as the chat's artifact
// "promo-video" (a new version each time), with the checked slots in promo_videos for the MP4 (render.ts).
// A failed check is one answer listing every problem; the AI may try once more in the same answer. A second failure
// tells it to stop and say in one plain sentence why there is no video (no third try in that answer).
import { PROMO_ARTIFACT_KEY, PROMO_TOOL, PromoVideoInput, type Locale, type PromoStyle } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { teamDefaultLocale } from '../admin/settings'
import { Denied, ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import type { ToolRegistry } from '../tools/registry'
import { audioCues } from './audio'
import { DURATION } from './layout'
import { checkPromoInput } from './spec'
import { artifactDocument, type PlayerText } from './template'

/** The font face file the artifact page loads from this server (web/scripts/build-vendor.ts writes it). */
export const PROMO_FONT_CSS = '/vendor/fonts/promo-video.css'
/** The sounds, as scripts holding data: addresses (the only way a sound reaches the artifact frame). */
export const PROMO_AUDIO_BASE = '/vendor/promo-video/'

/** What people call the styles (the answer names the style this way, never by its id). */
export const STYLE_NAME: Record<Locale, Record<PromoStyle, string>> = {
  ko: { ink: '임팩트', deep: '에디토리얼', mono: '모노' },
  en: { ink: 'Bold', deep: 'Editorial', mono: 'Mono' },
  id: { ink: 'Tegas', deep: 'Editorial', mono: 'Mono' },
  ja: { ink: 'インパクト', deep: 'エディトリアル', mono: 'モノ' },
  es: { ink: 'Impacto', deep: 'Editorial', mono: 'Mono' },
}

const PLAYER: Record<Locale, PlayerText> = {
  ko: { play: '재생', pause: '일시정지', soundOn: '소리 켜기', soundOff: '소리 끄기', stills: '장면 {n}' },
  en: { play: 'Play', pause: 'Pause', soundOn: 'Turn sound on', soundOff: 'Turn sound off', stills: 'Scene {n}' },
  id: { play: 'Putar', pause: 'Jeda', soundOn: 'Nyalakan suara', soundOff: 'Matikan suara', stills: 'Adegan {n}' },
  ja: { play: '再生', pause: '一時停止', soundOn: '音をオン', soundOff: '音をオフ', stills: 'シーン {n}' },
  es: { play: 'Reproducir', pause: 'Pausa', soundOn: 'Activar sonido', soundOff: 'Silenciar', stills: 'Escena {n}' },
}

export const PROMO_TOOL_DESCRIPTION =
  `Make the company's promo video (${DURATION} s, 1080×1350, five beats with music) from our template. You never write HTML or CSS for it: you fill the slots below, ` +
  'the server checks them and builds the video, which shows next to the chat (artifact "promo-video"; calling again makes a new version). ' +
  'Read the material first (the files you name in `sources`), look at the pictures in the brand images folder, then call this once with every slot. ' +
  'The story: 1 hook — the customer\'s outcome as before → after (e.g. "time to write one quote": "half a day" → "14 s"); 2 promise — what the company gives, over a brand picture; ' +
  '3 work — what it does, on its own picture in a window; 4 proof — one or two numbers written in the material (or, without any, the most concrete fact); 5 end card — logo, one line, the site\'s real offer, the website. ' +
  'Rules the server checks: every number on screen is written in the sources (proof numbers exactly as written, with sign and unit); every line fits (about 11 Korean characters or 20 Latin letters per headline line; a line too wide comes back as a problem); ' +
  'pictures come only from the team\'s brand images folder, each at most once, at least 600 px on the short side; a beat without a fitting picture is made with type and light (leave `picture` out; never invent one). ' +
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
  const html = artifactDocument(doc, { fontCss: PROMO_FONT_CSS, audioBase: PROMO_AUDIO_BASE, cues: audioCues(doc), text: PLAYER[lang], title: a.title })
  const c = componentC(ctx)
  const prev = ctx.db.query('SELECT 1 FROM artifacts WHERE chat_id = ? AND key = ? LIMIT 1').get(turn.chatId, PROMO_ARTIFACT_KEY)
  const s = c.artifacts.apply({ userId: t.user.id, ...turn }, { action: prev ? 'rewrite' : 'create', key: PROMO_ARTIFACT_KEY, type: 'html', title: a.title, content: html } as Parameters<typeof c.artifacts.apply>[1])
  ctx.db.query('INSERT INTO promo_videos (artifact_id, chat_id, user_id, spec, created_at) VALUES (?,?,?,?,?)')
    .run(s.id, turn.chatId, t.user.id, JSON.stringify({ title: a.title, sources: checked.spec.sources, doc }), new Date().toISOString())
  tries.delete(key)
  const style = STYLE_NAME[lang][doc.family]
  // only scenes 2 and 3 have a picture of their own; the hook, the proof and the end card are type and light by design
  const typeOnly = [doc.promise.picture ? '' : 'scene 2 (the promise)', doc.work.picture ? '' : 'scene 3 (what the company does)'].filter(Boolean)
  const changed = a.style && a.style !== doc.family ? ` (the "${a.style}" style does not fit this brand colour, so the server used "${doc.family}")` : ''
  return {
    text: `Made the promo video "${a.title}" (${DURATION} s with music, the "${style}" style${changed}; beats made with type and light instead of a picture: ${typeOnly.join(', ') || 'none'}). ` +
      'It opens by itself next to the chat (muted until the person turns the sound on). Your answer is one short line in the person\'s language: that the video is made and that they can say which scene or words to change; ' +
      'only if scene 2 or 3 is listed above as made with type and light, one more sentence that names that scene (in plain words, e.g. "두 번째 장면") and says pictures added to the brand images folder can go in next time; scenes 1, 4 and 5 never count. ' +
      'Nothing else: no tool, skill or slot names, no style ids, colour codes or file paths, no list of the beats, no HTML.',
    summary: `${PROMO_TOOL} ${doc.family} -> artifact ${s.key} v${s.version}`,
    structured: { key: s.key, version: s.version, artifactId: s.id },
  }
}

export function registerPromoVideo(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: PROMO_TOOL,
    description: PROMO_TOOL_DESCRIPTION,
    input: PromoVideoInput,
    describe: (a) => `${PROMO_TOOL} ${a.style ?? 'auto'}`,
    run: (a, t) => makePromoVideo(ctx, a, t),
  })
}
