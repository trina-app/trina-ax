// The tile colour of an Other app without its own icon (docs/decisions/20261116-other-app-icon.md): its name's first
// letter, as a person without a photo is shown (components/Avatar.tsx), on one of a few quiet tints picked from the
// app's id, so two Other apps in one conversation tell apart at a glance and an app keeps its colour everywhere. People
// stay on the neutral tile (the accent colour is for the one thing to do on a screen); these tints are soft, never the
// accent, with the letter in a deep shade of the same hue (light) or a light one (dark), readable in both themes.

/** The tints: background and letter, light and dark. Order is part of the rule (an app's index must not move). */
export const APP_TONES = [
  'bg-[#DBEAFE] text-[#1E40AF] dark:bg-[#1E3A5F] dark:text-[#BFDBFE]', // blue
  'bg-[#DCFCE7] text-[#166534] dark:bg-[#183D2A] dark:text-[#BBF7D0]', // green
  'bg-[#FEF3C7] text-[#92400E] dark:bg-[#43320F] dark:text-[#FDE68A]', // amber
  'bg-[#FCE7F3] text-[#9D174D] dark:bg-[#4A1D33] dark:text-[#FBCFE8]', // pink
  'bg-[#EDE9FE] text-[#5B21B6] dark:bg-[#33265A] dark:text-[#DDD6FE]', // violet
  'bg-[#CFFAFE] text-[#155E75] dark:bg-[#123D47] dark:text-[#A5F3FC]', // cyan
  'bg-[#FFE4E6] text-[#9F1239] dark:bg-[#4C1D24] dark:text-[#FECDD3]', // rose
  'bg-[#E0E7FF] text-[#3730A3] dark:bg-[#272B5C] dark:text-[#C7D2FE]', // indigo
] as const

/** A stable index for a text (FNV-1a over its UTF-16 units): the same id gives the same tint on every screen. */
export function toneIndex(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % APP_TONES.length
}

/** The tint of an app: by its id, else (a removed app) by its name. */
export const appTone = (app: { id: string | null; name: string }): string => APP_TONES[toneIndex(app.id ?? `name:${app.name}`)]!

/** The letter of a name as a picture shows it (Avatar.tsx): its first character, in capitals; '?' for an empty one. */
export const firstLetter = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? '?'
