// The `intro_deck` tool (docs/DECISIONS.md "D2"): the AI hands over the slots of 6–10 slides, the server checks them
// (spec.ts), lays them out in one of three themes (layout.ts, theme.ts) and keeps the preview as the chat's artifact
// "intro-deck" (a new version each time), with the checked document in intro_decks for the PowerPoint file and the PDF
// (files.ts). A failed check is one answer listing every problem; the AI may try once more in the same answer. A
// second failure tells it to stop and say in one plain sentence why there is no deck (no third try in that answer).
import { DECK_ARTIFACT_KEY, DECK_TOOL, IntroDeckInput, type DeckTheme, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { teamDefaultLocale } from '../admin/settings'
import { Denied, ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import type { ToolRegistry } from '../tools/registry'
import { isOwnOutput } from './files'
import { deckHtml } from './html'
import { checkDeckInput } from './spec'

/** The font face file the deck's page loads from this server (web/scripts/build-vendor.ts writes it). */
export const DECK_FONT_CSS = '/vendor/fonts/pretendard.css'

/** What people call the themes (the answer names a replaced theme this way, never by its id). */
export const THEME_NAME: Record<Locale, Record<DeckTheme, string>> = {
  ko: { paper: '밝은 종이', ink: '어두운', brand: '브랜드색' },
  en: { paper: 'Light paper', ink: 'Dark', brand: 'Brand colour' },
  id: { paper: 'Kertas terang', ink: 'Gelap', brand: 'Warna merek' },
  ja: { paper: '明るい紙', ink: 'ダーク', brand: 'ブランドカラー' },
  es: { paper: 'Papel claro', ink: 'Oscuro', brand: 'Color de marca' },
}

export const DECK_TOOL_DESCRIPTION =
  'Make the company\'s intro deck (its company profile: 6–10 designed 16:9 slides) from our templates. You never write HTML, XML or any layout: you fill the slots of each slide, ' +
  'the server checks them, lays them out in a theme chosen from the brand colour and shows the deck next to the chat (artifact "intro-deck"; calling again makes a new version); people page through it and download it as PowerPoint and PDF. ' +
  'Read the material first (the files you name in `sources` and the company profile), look at every picture in the brand images folder, then call this once with every slide. ' +
  'Order: cover, about, then needs → offer → numbers → products (up to two slides) → process → proof → history, contact last; one scene may stand between the third slide and contact. Aim for 8–10 slides; leave out a kind without material, never pad. ' +
  'Rules the server checks: every number on a slide is written in the sources (stats exactly as written, with sign and unit); names of customers, partners, certifications and people as written; a quote word for word; contact details as written in the sources or the company profile; no superlative claim (best, first, only, No.1, in any language) unless the sources say it; ' +
  'every line fits (it is measured; a line too long comes back as a problem with the size it must keep); ' +
  'pictures only from the team\'s brand images folder, each at most once, never the logo, never portraits or banners with text: a full-bleed cover or scene needs a landscape picture at least 1,600 px wide, half a slide at least 800 px on the short side, a product card at least 400 px; a slide without a fitting picture is made with type only (leave `picture` out; never invent one). ' +
  'If the result lists problems, fix all of them and call once more; if it fails again, stop and tell the person why in one plain sentence.'

/** Calls per turn: the first try and one rewrite. */
const tries = new Map<string, number>()
const MAX_TRIES = 2

/** How the answer names a slide (plain words; the AI says it in the person's language). */
const KIND_WORDS: Record<string, string> = {
  cover: 'the cover', offer: 'the slide on what the company does', products: 'the products slide', scene: 'the picture slide',
}

function turnChat(ctx: AppContext, t: ToolCtx): { chatId: string; messageId: string | null } {
  if (!t.turnId) throw new ToolError('intro_deck only works inside a chat turn')
  const r = ctx.db.query('SELECT chat_id, message_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; message_id: string | null; user_id: string } | null
  if (!r) throw new ToolError('unknown turn')
  if (r.user_id !== t.user.id) throw new Denied('turn belongs to another person')
  return { chatId: r.chat_id, messageId: r.message_id }
}

export async function makeIntroDeck(ctx: AppContext, a: IntroDeckInput, t: ToolCtx): Promise<{ text: string; summary: string; structured: Record<string, unknown> }> {
  const turn = turnChat(ctx, t)
  const key = t.turnId ?? ''
  const n = (tries.get(key) ?? 0) + 1
  if (n > MAX_TRIES) throw new ToolError('Do not call intro_deck again in this answer. Tell the person in one plain sentence that the deck could not be made this time and why (the problems you were given).')
  tries.set(key, n)
  if (tries.size > 2000) for (const k of [...tries.keys()].slice(0, 1000)) tries.delete(k)
  const lang = teamDefaultLocale(ctx.db)
  const checked = await checkDeckInput(ctx, t, a, lang, (sha) => isOwnOutput(ctx, sha))
  if (!checked.ok) {
    const list = checked.problems.map((p) => `- ${p}`).join('\n')
    if (n >= MAX_TRIES) throw new ToolError(`The deck could not be made:\n${list}\nDo not call intro_deck again in this answer. Tell the person in one plain sentence that the deck could not be made this time and why, in their language.`)
    throw new ToolError(`Nothing was made yet. Fix every problem below and call intro_deck once more with all the slides:\n${list}`)
  }
  const { doc, out } = checked.deck
  const html = deckHtml(out, { fontCss: DECK_FONT_CSS, lang, title: doc.title })
  const c = componentC(ctx)
  const prev = ctx.db.query('SELECT 1 FROM artifacts WHERE chat_id = ? AND key = ? LIMIT 1').get(turn.chatId, DECK_ARTIFACT_KEY)
  const s = c.artifacts.apply({ userId: t.user.id, ...turn }, { action: prev ? 'rewrite' : 'create', key: DECK_ARTIFACT_KEY, type: 'html', title: doc.title, content: html } as Parameters<typeof c.artifacts.apply>[1])
  ctx.db.query('INSERT INTO intro_decks (artifact_id, chat_id, user_id, spec, created_at) VALUES (?,?,?,?,?)')
    .run(s.id, turn.chatId, t.user.id, JSON.stringify({ title: doc.title, sources: checked.deck.sources, doc }), new Date().toISOString())
  tries.delete(key)
  // content slides that take a picture but were made with type only (the cover, what we do, products, never the rest)
  const typeOnly = out.typeOnly.map((i) => `slide ${i + 1} (${KIND_WORDS[doc.slides[i]!.kind] ?? doc.slides[i]!.kind})`)
  const changed = checked.deck.replaced && a.theme ? ` (the "${THEME_NAME[lang][a.theme]}" look does not fit this brand colour, so the server used "${THEME_NAME[lang][doc.theme]}")` : ''
  const few = doc.slides.length < 8
  return {
    text: `Made the intro deck "${doc.title}" (${doc.slides.length} slides, the "${THEME_NAME[lang][doc.theme]}" look${changed}; slides made with type only although they could take a picture: ${typeOnly.join(', ') || 'none'}). ` +
      'It opens by itself next to the chat; people page through it and download it as PowerPoint or PDF from its header. Your answer is one short line in the person\'s language: that the deck is made and that they can say which slide to change; ' +
      'only if a slide is listed above as made with type only, one more sentence that names it in plain words (e.g. "the cover") and says pictures added to the brand images folder can go in next time; ' +
      (few ? 'and, since the material was thin, one sentence that a company intro file (an existing deck or brochure) added to the brand folder makes a fuller deck next time; ' : '') +
      'nothing else: no tool, skill or slot names, no theme ids, colour codes or file paths, no list of the slides, no HTML.',
    summary: `${DECK_TOOL} ${doc.theme} ${doc.slides.length} -> artifact ${s.key} v${s.version}`,
    structured: { key: s.key, version: s.version, artifactId: s.id },
  }
}

export function registerIntroDeck(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: DECK_TOOL,
    description: DECK_TOOL_DESCRIPTION,
    input: IntroDeckInput,
    describe: (a) => `${DECK_TOOL} ${a.theme ?? 'auto'} ${a.slides.length}`,
    run: (a, t) => makeIntroDeck(ctx, a, t),
  })
}
