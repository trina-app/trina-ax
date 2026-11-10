// The emoji picker's data (components/EmojiPicker.tsx, docs/DECISIONS.md "Any emoji as a reaction"): emojibase-data
// (MIT; names and keywords from Unicode CLDR, Unicode License v3, resources/notices/unicode-emoji/) trimmed at build
// time to what the picker needs, as two modules the app loads only when a picker opens (lib/emoji.ts):
//   virtual:emoji/en  one line per emoji: "emoji<TAB>group<TAB>English name<TAB>keywords" (keywords that are not words
//                     of the name, space-separated), in the data's order
//   virtual:emoji/ko  the same lines' Korean "name<TAB>keywords" (empty where the data has none), line for line
// Left out: skin-tone variants (the picker offers the plain one; a pasted variant works), the components group (skin
// tones and hair alone) and emoji newer than EMOJI_VERSION_MAX, which many phones and computers still draw as a box.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

const require = createRequire(path.resolve(import.meta.dirname, '..', 'package.json'))

/** the newest Emoji version the picker offers (15.0, 2022: in the systems of the last years) */
export const EMOJI_VERSION_MAX = 15
/** emojibase's "component" group: skin tones and hair on their own, no emoji to pick */
const COMPONENT_GROUP = 2

export interface EmojibaseEntry { emoji: string; label: string; hexcode: string; group?: number; version?: number; tags?: string[] }
export interface EmojibaseCompact { hexcode: string; label: string; tags?: string[] }

const clean = (s: string) => s.replace(/[\t\n\r]+/g, ' ').trim()
/** the keywords that are not already words of the name */
function keywords(label: string, tags: readonly string[] | undefined): string {
  const words = new Set(label.toLowerCase().split(/[\s:,.\-]+/))
  return [...new Set((tags ?? []).map((t) => clean(t)).filter((t) => t && !words.has(t.toLowerCase())))].join(' ')
}

/** The two modules' text from emojibase's English data (with versions) and a locale's compact data. */
export function emojiModules(en: readonly EmojibaseEntry[], ko: readonly EmojibaseCompact[]): { en: string; ko: string } {
  const koBy = new Map(ko.map((e) => [e.hexcode, e]))
  const enLines: string[] = []
  const koLines: string[] = []
  for (const e of en) {
    if (e.group === undefined || e.group === COMPONENT_GROUP || (e.version ?? 0) > EMOJI_VERSION_MAX) continue
    enLines.push([e.emoji, e.group, clean(e.label), keywords(e.label, e.tags)].join('\t'))
    const k = koBy.get(e.hexcode)
    koLines.push(k ? [clean(k.label), keywords(k.label, k.tags)].join('\t') : '\t')
  }
  return { en: enLines.join('\n'), ko: koLines.join('\n') }
}

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(require.resolve(`emojibase-data/${file}`), 'utf8')) as T

/** emojiModules of the installed emojibase-data */
export function installedEmojiModules() {
  return emojiModules(read<EmojibaseEntry[]>('en/data.json'), read<EmojibaseCompact[]>('ko/compact.json'))
}

const IDS = { 'virtual:emoji/en': 'en', 'virtual:emoji/ko': 'ko' } as const

export function emojiData(): Plugin {
  let built: { en: string; ko: string } | null = null
  return {
    name: 'mycel-emoji-data',
    resolveId(id) {
      return id in IDS ? `\0${id}` : null
    },
    load(id) {
      const lang = IDS[id.slice(1) as keyof typeof IDS]
      if (!id.startsWith('\0') || !lang) return null
      built ??= installedEmojiModules()
      return `export default ${JSON.stringify(built[lang])}`
    },
  }
}
