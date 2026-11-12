// Characters a name may not hold: a room's own name (api/rooms.ts RoomName) and a person's name (api/auth.ts
// PersonName). A name is shown and quoted as one line of plain text: a line break in it would end that line (in a quote
// of "Ask Trina about this", the next line is no longer quoted: chat/read-rooms.ts isQuoteLine), and invisible
// characters let two names look alike.

/** Control characters, every format character (bidirectional marks, overrides and isolates, zero-width spaces and
 * non-joiners, the byte order mark, soft hyphens, invisible operators, tag characters, …) but the zero-width joiner that
 * emoji sequences need, line and paragraph separators, and the blank letters that draw nothing (the Hangul fillers
 * U+115F, U+1160, U+3164 and U+FFA0, the blank Braille pattern U+2800). */
export const NAME_FORBIDDEN = /(?!\u200d)\p{Cf}|[\p{Cc}\u2028\u2029\u115f\u1160\u3164\uffa0\u2800]/u
/** The field message of a name refused for them; the server answers it in the person's language (api/errors.ts
 * FIELD_MESSAGES). */
export const NAME_FORBIDDEN_FIELD = 'invisible or control characters'
/** A name as one line, for a name saved before the rule (or from elsewhere): line breaks, control and separator
 * characters become spaces. */
export const oneLineName = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
