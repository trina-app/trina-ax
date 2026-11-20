// Team name report (control plane `src/teams/tenant-name.ts`): a HOSTED team server tells the control plane the team's
// name after an owner renames the team in Admin › Team settings (or names it at setup), so the hosting service's
// console, billing pages and mails show the same name (the control plane's `teams.display_name`). MIT (see LICENSE in
// this folder).
//
// Erasable TypeScript, imports only ./drive-broker.ts (no imports itself): the team server and the control plane
// (Bun) load this file as it is. The caller computes sha256 and the signature itself (node:crypto).
//
// Channel: the Drive broker's signed API, reused as it is (drive-broker.ts): POST, JSON body, header
//   Authorization: TrinaDriveBroker key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>, sig=<base64>
//   sig = Ed25519 over driveBrokerSigningString(TEAM_NAME_PATH, ts, nonce, sha256 hex of the exact body bytes).
// The path is part of the signed string, so a signature for a Drive broker call never verifies here and the other way
// round. Same skew (DRIVE_BROKER_MAX_SKEW_MS), same replay rule (a (key, nonce) once), same body limit, same error
// codes (DRIVE_BROKER_ERRORS).
//
// Who: ONLY the relay team key the control plane recorded at enroll for the PRIMARY tenant of a hosted team (trial,
// active or past_due). A self-installed server (also one registered for the Drive or Slack broker) never sends this
// and is refused (`not_hosted`): its name is not the hosting service's business. Nothing in the body names the team:
// the control plane changes the name of the team whose key signed, and only that one.
//
// Body:   { v: 1, displayName }   (strict: unknown keys are refused)
// Answer: { ok: true, changed }   changed = the control plane's name was different and is now this one
//
// The name: what the team server shows, without surrounding white space, 1-TEAM_NAME_MAX characters (code points; the
// same 60 the hosting service's console allows when a team is made), Unicode NFC, and none of the characters that let a
// name look like another in a mail or the console: controls, format and private-use characters, line or paragraph
// separators, every default-ignorable code point (zero-width characters, bidirectional marks, overrides and isolates,
// the Arabic letter mark, word joiner, soft hyphen, variation selectors, tags, ...), the Hangul fillers and the Braille
// blank (they show as a space), and more than five combining marks on one letter. A zero-width joiner and variation
// selector 16 are fine only inside an emoji (👨‍👩‍👧, ❤️). teamNameProblem() is the one rule: the team server checks a
// name with it when an owner saves it and before it sends, the control plane again.
import { DRIVE_BROKER_MAX_BODY_BYTES, driveBrokerSigningString } from './drive-broker.ts'

export const TEAM_NAME_PATH = '/api/hosted-team/v1/name'
/** the longest team name, in code points: the hosting service's console allows 60 when a team is made */
export const TEAM_NAME_MAX = 60
export const TEAM_NAME_MAX_BODY_BYTES = DRIVE_BROKER_MAX_BODY_BYTES

export interface TeamNameReport { v: 1; displayName: string }
export interface TeamNameAnswer { ok: true; changed: boolean }

/** characters a team name may not hold: controls (C0, DEL, C1), format characters (interlinear annotation, ...),
 * private-use characters, unpaired surrogates, line and paragraph separators,
 * default-ignorable code points (zero-width space, non-joiner and joiner, bidirectional marks, embeddings, overrides and
 * isolates, word joiner, soft hyphen, variation selectors, tags, byte order mark, ...), the Arabic letter mark, the
 * Hangul fillers and the Braille blank (they look like a space). The explicit ones are listed although the property
 * holds most of them, so a reader sees them. */
const BAD = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u061C\u115F\u1160\u3164\uFFA0\u2800\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u
/** an emoji with its zero-width joiners, variation selector 16 and skin tones (👨‍👩‍👧, ❤️, 👍🏽): the only place a
 * joiner or a variation selector may be */
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu
/** more than five combining marks in a row: text stacked over the lines around it */
const STACKED = /\p{M}{6,}/u

/** null when `name` may be a team name as it is, else a short reason (a code, never the name) */
export function teamNameProblem(name: unknown): 'not_text' | 'empty' | 'too_long' | 'spaces' | 'not_nfc' | 'bad_character' | null {
  if (typeof name !== 'string') return 'not_text'
  if (name.trim() === '') return 'empty'
  if ([...name].length > TEAM_NAME_MAX) return 'too_long'
  if (name !== name.trim()) return 'spaces'
  if (BAD.test(name.replace(EMOJI, 'e')) || STACKED.test(name)) return 'bad_character'
  if (name !== name.normalize('NFC')) return 'not_nfc'
  return null
}

/** what the team server sends for a name it shows: trimmed and NFC, or null when that still is not a valid name */
export function teamNameToSend(name: string): string | null {
  const n = name.normalize('NFC').trim()
  return teamNameProblem(n) === null ? n : null
}

export function parseTeamNameReport(raw: unknown): TeamNameReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== 2 || !keys.includes('v') || !keys.includes('displayName') || o.v !== 1) return null
  return teamNameProblem(o.displayName) === null ? { v: 1, displayName: o.displayName as string } : null
}

/** The UTF-8 string the team key signs: the Drive broker's, with this path. */
export function teamNameSigningString(ts: number, nonce: string, bodySha256Hex: string): string {
  return driveBrokerSigningString(TEAM_NAME_PATH, ts, nonce, bodySha256Hex)
}
