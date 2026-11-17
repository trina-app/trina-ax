// Voice input and meeting pieces that hold no speech (QA TC-4581). Whisper writes something for sound with no words:
// "you" over digital silence, "(beep)" over a beep, letters in a loop over a hum, and from louder noise one of the lines
// it learned from video subtitles ("Thank you.", "Thanks for watching!", a subtitle credit). The person must see
// "Nothing was recognized" instead (the web app shows it for an answer with no text, or a piece with no lines), so:
// 1. soundOf: what the server's own 16 kHz mono 16-bit WAV holds (the conversion's audio.wav, or the app's piece);
//    silent sound (SILENT_DB) goes to no model at all, so it costs no whisper.cpp turn and no OpenRouter request;
// 2. keepSpeech, on whisper's answer: its marks for sound with no words are dropped, and the rest too when the sound
//    is weak (quiet, or a tone / steady noise that does not move like speech) and whisper was unsure of it, or when
//    every line is one of those learned lines (HALLUCINATIONS) on weak sound. A person who says "Thank you" makes
//    sound that moves like speech, so that is kept.
// Measured 2026-11-17 with whisper.cpp 1.9 and the small model on generated sound and macOS `say` speech: digital
// silence -> " you" (its first word 0.14 sure), a 1 kHz beep -> " (beep)", brown noise at -50 dBFS -> a loop of one
// letter (0.06), white noise at -35 dBFS -> a loop of one Georgian letter (0.08); "Yes" 0.81, "Thank you." 0.93.
import type { TranscribeResult } from '@mycel/shared/api'

/** the loudest 20 ms frame (RMS, dBFS) under this: silence, nothing is sent to a model (speech from a quiet room
 * microphone peaks around -45 dBFS, its frames at -50; a 2 s pink noise at -60 made whisper write nothing anyway) */
export const SILENT_DB = -60
/** the loudest frame under this: quiet sound (weak) */
export const QUIET_DB = -50
/** frames count as sound above this, and within SOUND_RANGE_DB of the loudest */
const SOUND_FLOOR_DB = -55
const SOUND_RANGE_DB = 30
/** speech moves: the level of its sound frames spreads by this much (standard deviation, dB) and their zero-crossing
 * rate by this much. Measured: speech 3-9 dB and 0.012-0.35 (a quiet "hello" 3.0 dB, "ne" 0.012); a steady tone
 * 0.0 dB and 0.002, pink, brown and white noise 0.3-1.8 dB (zero crossings 0.02-0.03) */
const SPEECH_SPREAD_DB = 2
const SPEECH_ZCR_SPREAD = 0.006
/** whisper.cpp was unsure of a line whose first word is less sure than this (its token probability, -ojf) */
export const UNSURE_FIRST_P = 0.3
/** OpenRouter: a line whose no-speech probability is above this and avg_logprob under NO_SPEECH_LOGPROB is no speech
 * (whisper's own rule, which whisper.cpp applies to every line here); above UNSURE_NO_SPEECH the answer is unsure */
export const NO_SPEECH_PROB = 0.6
export const NO_SPEECH_LOGPROB = -1
export const UNSURE_NO_SPEECH = 0.5

const FRAME = 320

export interface Sound {
  seconds: number
  /** the loudest 20 ms frame, dBFS */
  peakDb: number
  /** seconds of frames with sound */
  soundSec: number
  /** the sound moves like speech (its level and its zero-crossing rate vary from frame to frame) */
  speechLike: boolean
}

/** What a 16 kHz mono 16-bit PCM WAV holds (any chunk before the data, such as ffmpeg's LIST or afconvert's FLLR, is
 * skipped; afconvert's WAVE_FORMAT_EXTENSIBLE header counts as PCM); null for anything else. */
export function soundOf(wav: Uint8Array): Sound | null {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null
  let pcm = false
  let data: Buffer | null = null
  for (let pos = 12; pos + 8 <= b.length;) {
    const id = b.toString('latin1', pos, pos + 4), size = b.readUInt32LE(pos + 4)
    if (id === 'fmt ' && size >= 16 && pos + 24 <= b.length) {
      const tag = b.readUInt16LE(pos + 8)
      pcm = (tag === 1 || tag === 0xfffe) && b.readUInt16LE(pos + 10) === 1 && b.readUInt32LE(pos + 12) === 16000 && b.readUInt16LE(pos + 22) === 16
    }
    if (id === 'data') { data = b.subarray(pos + 8, Math.min(b.length, pos + 8 + size)); break }
    pos += 8 + size + (size & 1)
  }
  if (!pcm || !data) return null
  const n = Math.floor(data.length / 2)
  const levels: number[] = [], zcrs: number[] = []
  for (let f = 0; (f + 1) * FRAME <= n; f++) {
    let sum = 0, sq = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) { const x = data.readInt16LE(i * 2); sum += x; sq += x * x }
    const mean = sum / FRAME
    let z = 0, prev = data.readInt16LE(f * FRAME * 2) - mean
    for (let i = f * FRAME + 1; i < (f + 1) * FRAME; i++) { const x = data.readInt16LE(i * 2) - mean; if ((x >= 0) !== (prev >= 0)) z++; prev = x }
    levels.push(20 * Math.log10(Math.max(1, Math.sqrt(sq / FRAME)) / 32768))
    zcrs.push(z / FRAME)
  }
  const peakDb = levels.length ? Math.max(...levels) : -Infinity
  const floor = Math.max(SOUND_FLOOR_DB, peakDb - SOUND_RANGE_DB)
  const loud = levels.map((l, i) => (l > floor ? i : -1)).filter((i) => i >= 0)
  const spread = (v: number[]) => { const m = v.reduce((a, x) => a + x, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) }
  const speechLike = loud.length >= 5 && spread(loud.map((i) => levels[i]!)) >= SPEECH_SPREAD_DB && spread(loud.map((i) => zcrs[i]!)) >= SPEECH_ZCR_SPREAD
  return { seconds: n / 16000, peakDb, soundSec: loud.length * FRAME / 16000, speechLike }
}

/** nothing worth sending to a model */
export const silent = (s: Sound | null): boolean => !!s && s.peakDb < SILENT_DB
/** quiet, or not moving like speech */
const weak = (s: Sound | null): boolean => !!s && (s.peakDb < QUIET_DB || !s.speechLike)

/** whisper's marks for sound with no words: [BLANK_AUDIO], (beep), (music), [음악], ♪, *click* */
export const NOT_WORDS = /^\s*(?:[[(（][^\])）]{0,40}[\])）]|\*[^*]{0,40}\*|[♪♫♬\s]+)\s*$/

/** Lines whisper learned from video subtitles and writes for sound with no speech, compared whole after
 * normalize(): English, Korean, Japanese, Chinese, Indonesian, Spanish (Korean as escapes: server code holds no
 * Hangul) */
const HALLUCINATIONS = new Set([
  'you', 'thankyou', 'thankyouverymuch', 'thankyousomuch', 'thanks', 'thanksforwatching', 'thankyouforwatching',
  'thankyousomuchforwatching', 'thanksforwatchingandseeyounexttime', 'pleasesubscribe', 'likeandsubscribe',
  'pleaselikeandsubscribe', 'bye', 'byebye', 'theend',
  // thank you for watching / thank you / please subscribe and like
  '시청해주셔서감사합니다', '감사합니다',
  '구독과좋아요부탁드립니다',
  'ご視聴ありがとうございました', 'ありがとうございました', 'ご清聴ありがとうございました', 'チャンネル登録お願いします',
  '谢谢观看', '谢谢大家', '感谢观看', '謝謝觀看', '谢谢',
  'terimakasih', 'terimakasihtelahmenonton', 'terimakasihsudahmenonton',
  'gracias', 'graciasporver', 'graciasporverelvideo', 'suscribete', 'muchasgracias',
])
/** subtitle credits ("Subtitles by the Amara.org community", 字幕由Amara.org社区提供, "Subtítulos realizados por ...") */
const CREDIT = /^(?:(?:subtitles?|captions?|transcri(?:bed|ption)|translat(?:ed|ion))(?:by|madeby|providedby|realizadospor)|subt[ií]tulos|字幕|amaraorg|자막)/

/** lower case, no punctuation, symbols or spaces */
const normalize = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
/** one of the lines whisper writes for no speech */
export function learnedLine(text: string): boolean {
  const t = normalize(text)
  return !!t && (HALLUCINATIONS.has(t) || CREDIT.test(t))
}

type Line = { start: number; end: number; text: string }
export type Heard = TranscribeResult & { segments?: Line[] }

/**
 * Whisper's answer without what it wrote for no speech. `sound`: soundOf the audio it heard (null: unknown, then
 * only the marks and an unsure answer of learned lines are dropped); `unsure`: whisper's own signal (whisper.cpp's
 * first-word probability, OpenRouter's no-speech probability / avg_logprob). Returns the answer with no text and no
 * lines when nothing in it was speech, else with only the marks taken out.
 */
export function keepSpeech<T extends Heard>(r: T, sound: Sound | null, unsure: boolean): T {
  const lines = (r.segments?.length ? r.segments : r.text.trim() ? [{ start: 0, end: r.durationSec ?? 0, text: r.text }] : [])
    .filter((l) => l.text.trim() && !NOT_WORDS.test(l.text))
  const none = { ...r, text: '', segments: [] }
  if (!lines.length || silent(sound)) return none
  if (weak(sound) && unsure) return none
  if ((weak(sound) || (!sound && unsure)) && lines.every((l) => learnedLine(l.text))) return none
  if (lines.length === (r.segments?.length ? r.segments.length : 1)) return r
  return { ...r, text: lines.map((l) => l.text.trim()).join(' ').replace(/\s+/g, ' ').trim(), segments: r.segments?.length ? lines : r.segments }
}
