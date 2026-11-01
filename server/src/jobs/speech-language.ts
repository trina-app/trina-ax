// The language of a transcript: what speech providers say they heard, and when to ask again told a language. Shared by
// voice input (jobs/openrouter-stt.ts) and the AI's video and audio reads (files/media.ts, files/service.ts).
// Measured on OpenRouter / DeepInfra whisper-large-v3-turbo (plans stt-hosted-2026-11-01): whisper names one language
// for a whole request from its first 30 seconds, so a 13-minute Korean meeting whose first voice it took for Japanese
// came back translated into Japanese (Hangul CER 97.7%); told "ko" it was 8.9%.
import type { TranscribeResult } from '@mycel/shared/api'

/** whisper's languages by name (openai/whisper tokenizer LANGUAGES and aliases): Groq answers "Korean", "English" */
const WHISPER_LANGUAGES: Record<string, string> = {
  english: 'en', chinese: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr', japanese: 'ja',
  portuguese: 'pt', turkish: 'tr', polish: 'pl', catalan: 'ca', dutch: 'nl', arabic: 'ar', swedish: 'sv', italian: 'it',
  indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi', hebrew: 'he', ukrainian: 'uk', greek: 'el', malay: 'ms',
  czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu', tamil: 'ta', norwegian: 'no', thai: 'th', urdu: 'ur',
  croatian: 'hr', bulgarian: 'bg', lithuanian: 'lt', latin: 'la', maori: 'mi', malayalam: 'ml', welsh: 'cy', slovak: 'sk',
  telugu: 'te', persian: 'fa', latvian: 'lv', bengali: 'bn', serbian: 'sr', azerbaijani: 'az', slovenian: 'sl',
  kannada: 'kn', estonian: 'et', macedonian: 'mk', breton: 'br', basque: 'eu', icelandic: 'is', armenian: 'hy',
  nepali: 'ne', mongolian: 'mn', bosnian: 'bs', kazakh: 'kk', albanian: 'sq', swahili: 'sw', galician: 'gl', marathi: 'mr',
  punjabi: 'pa', sinhala: 'si', khmer: 'km', shona: 'sn', yoruba: 'yo', somali: 'so', afrikaans: 'af', occitan: 'oc',
  georgian: 'ka', belarusian: 'be', tajik: 'tg', sindhi: 'sd', gujarati: 'gu', amharic: 'am', yiddish: 'yi', lao: 'lo',
  uzbek: 'uz', faroese: 'fo', 'haitian creole': 'ht', pashto: 'ps', turkmen: 'tk', nynorsk: 'nn', maltese: 'mt',
  sanskrit: 'sa', luxembourgish: 'lb', myanmar: 'my', tibetan: 'bo', tagalog: 'tl', malagasy: 'mg', assamese: 'as',
  tatar: 'tt', hawaiian: 'haw', lingala: 'ln', hausa: 'ha', bashkir: 'ba', javanese: 'jw', sundanese: 'su', cantonese: 'yue',
  burmese: 'my', valencian: 'ca', flemish: 'nl', haitian: 'ht', letzeburgesch: 'lb', pushto: 'ps', panjabi: 'pa',
  moldavian: 'ro', moldovan: 'ro', sinhalese: 'si', castilian: 'es', mandarin: 'zh',
}
const CODES = new Set(Object.values(WHISPER_LANGUAGES))

/** A provider's language -> whisper's code ("Korean" and "ko" -> "ko"); null for anything else. */
export function languageCode(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (CODES.has(s) || /^[a-z]{2}$/.test(s)) return s
  return WHISPER_LANGUAGES[s] ?? null
}

/** The writing system most of a text's letters are in: a told language that changes it gave a translation, not a
 * transcript (measured: English told "ko" gave "이제 Friday에 입장해 봅시다.", Korean told "en" an English sentence). Kana
 * and Han count as one (Japanese mixes them; Chinese and Japanese guesses swap). null: no letters. */
export function writingSystem(text: string): 'hangul' | 'latin' | 'cjk' | null {
  const n = { hangul: 0, latin: 0, cjk: 0 }
  for (const ch of text) {
    if (/\p{Script=Hangul}/u.test(ch)) n.hangul++
    else if (/\p{Script=Latin}/u.test(ch)) n.latin++
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) n.cjk++
  }
  const best = (Object.entries(n) as [keyof typeof n, number][]).sort((a, b) => b[1] - a[1])[0]!
  return best[1] ? best[0] : null
}
/** the writing system a language is written in (null: another one, or not known here) */
const LATIN = new Set(['en', 'id', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ms', 'vi', 'tl', 'tr', 'pl', 'sv', 'da', 'no', 'nn', 'fi', 'cs', 'sk', 'ro', 'hu', 'hr', 'sl', 'ca', 'gl', 'eu', 'et', 'lv', 'lt', 'jw', 'su'])
export function scriptOf(language: string): 'hangul' | 'latin' | 'cjk' | null {
  return language === 'ko' ? 'hangul' : language === 'ja' || language === 'zh' || language === 'yue' ? 'cjk' : LATIN.has(language) ? 'latin' : null
}

/** whisper's own caption when it was told a language the sound is not in ("(speaking in foreign language)", "[Foreign
 * language]"): measured on 4-6 s Korean pieces told "en" (auto had guessed ko or ja at p 0.32-0.36) */
const OTHER_LANGUAGE = /^\s*(?:[([][^)\]]*\b(foreign|non-english)\b[^)\]]*[)\]]|\*[^*]*\blanguage\b[^*]*\*)[\s.]*$/i
/** Whether an answer holds nothing but that caption: the language it was told is not the sound's. */
export function saysOtherLanguage(r: TranscribeResult): boolean {
  const lines = r.segments?.length ? r.segments.map((s) => s.text) : [r.text]
  return lines.some((t) => t.trim()) && lines.every((t) => !t.trim() || OTHER_LANGUAGE.test(t))
}

// ---------------- long pieces through OpenRouter ----------------
/** How sure whisper was of an answer's words: over its lines with text, `covered` seconds and the sum of each line's
 * seconds times its avg_logprob (OpenRouter's verbose_json; DeepInfra and Groq both give it). */
export interface Scored { covered: number; logprob: number }
/** an answer with how sure whisper was of it (absent: a provider without avg_logprob, or nothing said) */
export type ScoredAnswer = TranscribeResult & { scored?: Scored }

/** Scored from a provider's raw segments; undefined when a line with text has no avg_logprob. */
export function scoreSegments(raw: { start?: unknown; end?: unknown; text?: unknown; avg_logprob?: unknown }[]): Scored | undefined {
  let covered = 0, logprob = 0
  for (const s of raw) {
    if (typeof s?.text !== 'string' || !s.text.trim()) continue
    if (typeof s.avg_logprob !== 'number' || !Number.isFinite(s.avg_logprob)) return undefined
    const d = Math.max(0.1, (typeof s.end === 'number' ? s.end : 0) - (typeof s.start === 'number' ? s.start : 0))
    covered += d
    logprob += d * s.avg_logprob
  }
  return covered > 0 ? { covered, logprob } : undefined
}

/** OpenRouter pieces and recordings at least this long are checked (whisper decides the language of a whole request
 * from its first 30 seconds; a shorter one is mostly that window) */
export const LONG_PIECE_SEC = 60
/** whisper was unsure of an answer below this mean avg_logprob. Measured on DeepInfra: its transcripts -0.04 to -0.36
 * (10 minutes of Korean -0.20, a two-minute Korean-English meeting -0.30 to -0.36), its translations into a wrong
 * language -0.48 to -2.3 (the QA meeting heard as Japanese -0.93, as English -0.48) */
export const UNSURE_LOGPROB = -0.4
/** what an answer left out counts as, so that no answer wins by dropping the speech it found hard (told "ko", the QA
 * meeting's last piece dropped 55 s of English) */
const MISSING_LOGPROB = -1
/** how much surer whisper must be of a retry for it to replace the language it heard */
const RETRY_MARGIN = 0.1
/** the share of a retry's speech time that must be written in the told language's script: below it whisper did not
 * follow the hint (Japanese told "ko" stayed Japanese) */
const TOLD_SCRIPT_SHARE = 0.25

/** The mean avg_logprob of an answer over `over` seconds (at least what it covered; the rest counts as missing). */
export function confidence(s: Scored, over = s.covered): number {
  const total = Math.max(over, s.covered)
  return (s.logprob + (total - s.covered) * MISSING_LOGPROB) / total
}

/**
 * The language to tell a long piece (or recording) once more, or undefined to keep whisper's own guess `r.language`.
 * `file`: the language most heard in this file's other pieces, if any; `team`: the team's language. The retry is told
 * the file's language, else the team's, when that is not what whisper heard and: what it heard is neither the team's
 * language nor English, whisper was unsure of its words (UNSURE_LOGPROB), or another piece of the file was heard in
 * another language. Nothing to compare by (no avg_logprob) or nothing said: no retry.
 */
export function longRetryLanguage(r: ScoredAnswer, o: { team: string; file?: string }): string | undefined {
  const told = o.file ?? o.team
  if (!/^[a-z]{2}$/.test(told) || r.language === told || !r.scored || !r.segments?.length) return undefined
  if (r.language !== o.team && r.language !== 'en') return told
  if (confidence(r.scored) < UNSURE_LOGPROB) return told
  if (o.file && o.file !== r.language) return told
  return undefined
}

/** The share of an answer's speech time written in `script`. */
function scriptShare(r: TranscribeResult, script: 'hangul' | 'latin' | 'cjk'): number {
  let all = 0, inScript = 0
  for (const s of r.segments ?? []) {
    if (!s.text.trim()) continue
    const d = Math.max(0.1, s.end - s.start)
    all += d
    if (writingSystem(s.text) === script) inScript += d
  }
  return all ? inScript / all : 0
}

/**
 * Whether a long piece's retry, told `told`, replaces whisper's first answer: it is not only the "foreign language"
 * caption, it is written at least partly in the told language's script (whisper followed the hint), and whisper is
 * surer of its words (confidence over the longer of the two, by RETRY_MARGIN). Measured on every pair of the plan's
 * clips (27 half-minute pieces of the QA meeting, its two long pieces, a Japanese meeting told "ko"): the answer kept
 * this way was the one in the language spoken.
 */
export function keepLongRetry(first: ScoredAnswer, again: ScoredAnswer, told: string): boolean {
  if (!first.scored || !again.scored || !again.segments?.length || saysOtherLanguage(again)) return false
  const script = scriptOf(told)
  if (script && scriptShare(again, script) < TOLD_SCRIPT_SHARE) return false
  const over = Math.max(first.scored.covered, again.scored.covered)
  return confidence(again.scored, over) > confidence(first.scored, over) + RETRY_MARGIN
}
