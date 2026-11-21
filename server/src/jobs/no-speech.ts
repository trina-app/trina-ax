// Voice input pieces that hold no speech (QA TC-4581). Whisper writes something for sound with no words:
// "you" over digital silence, "(beep)" over a beep, letters in a loop over a hum, and from louder noise one of the lines
// it learned from video subtitles ("Thank you.", "Thanks for watching!", a subtitle credit). The person must see
// "Nothing was recognized" instead (the web app shows it for an answer with no text, or a piece with no lines), so:
// 1. soundOf: what the server's own 16 kHz mono 16-bit WAV holds (the conversion's audio.wav, or the app's piece);
//    silent sound (SILENT_DB) goes to no model at all, so it costs no whisper.cpp turn and no OpenRouter request;
// 2. keepSpeech, on whisper's answer: its marks for sound with no words are dropped, and the rest too when the sound
//    is weak (a tone or steady noise that does not move like speech) and whisper was unsure of it, or when
//    every line is one of those learned lines (HALLUCINATIONS) on weak sound. A person who says "Thank you" makes
//    sound that moves like speech, so that is kept.
// Measured 2026-11-17 with whisper.cpp 1.9 and the small model on generated sound and macOS `say` speech: digital
// silence -> " you" (its first word 0.14 sure), a 1 kHz beep -> " (beep)", brown noise at -50 dBFS -> a loop of one
// letter (0.06), white noise at -35 dBFS -> a loop of one Georgian letter (0.08); "Yes" 0.81, "Thank you." 0.93.
import type { TranscribeResult } from '@mycel/shared/api'

/** the loudest 20 ms frame (RMS, dBFS) under this: silence, nothing is sent to a model (speech from a quiet room
 * microphone peaks around -45 dBFS, its frames at -50; a 2 s pink noise at -60 made whisper write nothing anyway) */
export const SILENT_DB = -60
/** frames count as sound within SOUND_RANGE_DB of the loudest (and above SOUND_FLOOR_DB, digital silence): relative,
 * so quiet speech is measured as loud speech is (an absolute -55 floor cut a quiet "Thanks" at -43 dBFS to its vowel,
 * and -75 a quiet "yes" in Korean at -51 to its loudest frames) */
const SOUND_FLOOR_DB = -85
const SOUND_RANGE_DB = 30
/** speech moves: the level of its sound frames spreads by this much (standard deviation, dB) and their zero-crossing
 * rate by this much. Measured (macOS say, 0-40 dB down, with and without a -75 dBFS noise floor): speech 5.9-11.7 dB and
 * 0.013-0.35; white, pink and brown noise 0.3-1.8 dB (zero crossings 0.02-0.03) */
const SPEECH_SPREAD_DB = 2
const SPEECH_ZCR_SPREAD = 0.006
/** a beep is a pure tone: a frame whose autocorrelation reaches TONE_R at some lag (a sine's half period gives -1)
 * is tonal, and sound whose loudest frames (within TONE_CORE_DB of the peak) are tonal in more than TONE_SHARE of
 * them is a tone, whatever noise is around it. Measured: beeps and a chime 1.00 at any level above the noise; speech
 * 0.00-0.30 (a Korean "thank you" 0.30, a Korean "yes" 0.09), noise 0.00 */
const TONE_R = -0.9
const TONE_CORE_DB = 10
const TONE_SHARE = 0.6
/** at most this many of the loudest frames are looked at for a tone (each costs about 25 000 multiplications) */
const TONE_FRAMES = 400
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
  let peakDb = -Infinity
  for (const l of levels) if (l > peakDb) peakDb = l
  const floor = Math.max(SOUND_FLOOR_DB, peakDb - SOUND_RANGE_DB)
  const loud = levels.map((l, i) => (l > floor ? i : -1)).filter((i) => i >= 0)
  const spread = (v: number[]) => { const m = v.reduce((a, x) => a + x, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) }
  const speechLike = loud.length >= 5 && spread(loud.map((i) => levels[i]!)) >= SPEECH_SPREAD_DB && spread(loud.map((i) => zcrs[i]!)) >= SPEECH_ZCR_SPREAD
    && !tone(data, levels.map((l, i) => (l > peakDb - TONE_CORE_DB ? i : -1)).filter((i) => i >= 0))
  return { seconds: n / 16000, peakDb, soundSec: loud.length * FRAME / 16000, speechLike }
}

/** the frames `core` (indexes) are mostly a pure tone (TONE_SHARE of at most TONE_FRAMES, picked evenly) */
function tone(data: Buffer, core: number[]): boolean {
  if (!core.length) return false
  const step = Math.max(1, core.length / TONE_FRAMES)
  const x = new Float64Array(FRAME)
  let tonal = 0, seen = 0
  for (let k = 0; k < core.length; k += step) {
    const f = core[Math.floor(k)]!
    let m = 0
    for (let i = 0; i < FRAME; i++) { x[i] = data.readInt16LE((f * FRAME + i) * 2); m += x[i]! }
    m /= FRAME
    let e = 0
    for (let i = 0; i < FRAME; i++) { x[i]! -= m; e += x[i]! * x[i]! }
    seen++
    if (e <= 0) continue
    // lags 2-80 samples: tones from 100 Hz to 4 kHz reach -1 at their half period
    for (let t = 2; t <= 80; t++) {
      let c = 0
      for (let i = 0; i + t < FRAME; i++) c += x[i]! * x[i + t]!
      if ((c / e) * FRAME / (FRAME - t) < TONE_R) { tonal++; break }
    }
  }
  return tonal > seen * TONE_SHARE
}

/** nothing worth sending to a model */
export const silent = (s: Sound | null): boolean => !!s && s.peakDb < SILENT_DB
/** not moving like speech (a tone, steady noise); quiet speech is speech (silence is SILENT_DB) */
const weak = (s: Sound | null): boolean => !!s && !s.speechLike

/** whisper's marks for sound with no words: [BLANK_AUDIO], (beep), (music), [music in Korean], ♪, *click* */
export const NOT_WORDS = /^\s*(?:[[(（][^\])）]{0,40}[\])）]|\*[^*]{0,40}\*|[♪♫♬\s]+)\s*$/

/** Whisper's sound tags inside a line ("[Coughing] Please send …", "(upbeat music)", "[BLANK_AUDIO]", QA TC-4674). A
 * bracketed part is a tag only when ALL of it is one: a sound word alone, or with one word before it (upbeat music,
 * phone ringing) or after it (door closes, speaking Japanese). Exact word forms, no prefixes, so what a person said in
 * brackets stays: "(line of sight)", "(music festival budget)", "(cheers team)", "[draft]". Chinese, Japanese and Korean
 * tags match only as the whole inside. Korean as escapes (server code holds no Hangul). */
const SOUND = '(?:music|musical|instrumental|singing|humming|whistling|laugh|laughs|laughing|laughter|chuckles?|chuckling|giggles?|giggling|' +
  'cough|coughs|coughing|sneezes?|sneezing|sniffs?|sniffing|sniffles|sighs?|sighing|breathing|breathes|gasps?|gasping|groans?|groaning|' +
  'yawns?|yawning|snoring|crying|sobbing|screams?|screaming|grunts?|grunting|applause|applauding|clapping|claps|cheering|cheers|' +
  'beep|beeps|beeping|blank_audio|silence|noise|static|inaudible|indistinct|unintelligible|clicking|clicks|typing|footsteps|knocking|' +
  'knocks|ringing|rings|chimes|chiming|buzzing|buzzes|thud|bang|bangs|banging|thunder|murmuring|mumbling|mumbles|chatter|chattering|' +
  'barking|barks|vibrating|vibrates|pause|outro|intro|sfx|musik|tertawa|batuk|tepuk tangan|hening|música|risas|aplausos|silencio|ruido|tos)'
/** a word that makes a bracketed part read as a person's words ("(our music)", "(the applause)") */
const PLAIN_WORD = /^(?:the|a|an|of|for|to|in|on|at|is|are|was|here|there|who|my|our|your|his|her|their|its|from|about|list|team|and|or|with|this|that|no|not|please|me|you|we|i)$/i
/** what may follow a sound word in a tag ("music playing", "laughter continues") */
const AFTER = '(?:continues|continuing|playing|plays|fades|fading|stops|ends|starts|swells|intensifies|loudly|softly|nearby)'
const SOUND_TAG = new RegExp(
  `^(?:\\p{L}+\\s+)?${SOUND}$|^${SOUND}\\s+${AFTER}$|^(?:sound effects?|no speech|no audio|foreign language|speaking (?:in )?(?:a )?(?:foreign language|\\p{L}+)|speaks \\p{L}+|door (?:closes|closing|opens|opening|slams|creaks)|phone (?:ringing|rings|buzzing|vibrating))$`,
  'iu')
/** whole-inside tags in Chinese, Japanese and Korean (music, laughter, applause, cough, silence, noise, a sigh; Korean
 * words for music, laughter, applause, a cough, silence, noise and a sigh, optionally with the word for "sound") */
const CJK_TAG = /^(?:音楽|音乐|笑|笑い(?:声)?|笑声|拍手|掌声|咳|咳嗽|無音|无声|静音|沉默|ノイズ|噪音|(?:\uC74C\uC545|\uC6C3\uC74C|\uBC15\uC218|\uAE30\uCE68|\uCE68\uBB35|\uC18C\uC74C|\uD55C\uC228|\uBB34\uC74C)(?:\s*\uC18C\uB9AC)?)$/u
const BRACKETED = /[ \t]*(?:\[([^\]\n]{1,40})\]|\(([^)\n]{1,40})\)|（([^）\n]{1,40})）|\*([^*\s]{1,30})\*)[ \t]*/g
/** a bracketed part (its inside) that is one of whisper's sound tags */
export function soundTag(inner: string): boolean {
  const t = inner.trim().replace(/\s+/g, ' ')
  if (CJK_TAG.test(t)) return true
  const words = t.split(' ')
  // "speaking in Korean" may hold "in"; elsewhere a plain word means a person said it
  return SOUND_TAG.test(t) && (/^speaking /i.test(t) || !words.some((w) => PLAIN_WORD.test(w)))
}
/** One line without whisper's sound tags and music notes; real bracketed words kept, line breaks kept. */
export function withoutSoundTags(text: string): string {
  const t = text.replace(BRACKETED, (m, a?: string, b?: string, c?: string, d?: string) => (soundTag(a ?? b ?? c ?? d ?? '') ? ' ' : m))
    .replace(/[ \t]*[♪♫♬]+[ \t]*/g, ' ')
  return t === text ? text : t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim()
}
/** An answer without whisper's sound tags in its text and lines (a line left empty goes) */
export function stripSoundTags<T extends Heard>(r: T): T {
  if (r.segments?.length) {
    const segments = r.segments.map((l) => ({ ...l, text: withoutSoundTags(l.text) }))
    if (segments.every((l, i) => l.text === r.segments![i]!.text)) return r
    const kept = segments.filter((l) => l.text.trim())
    return { ...r, segments: kept, text: kept.map((l) => l.text.trim()).join(' ').replace(/\s+/g, ' ').trim() }
  }
  const text = withoutSoundTags(r.text)
  return text === r.text ? r : { ...r, text }
}

/** Lines whisper learned from video subtitles and writes for sound with no speech, compared whole after
 * normalize(): English, Korean, Japanese, Chinese, Indonesian, Spanish (Korean as escapes: server code holds no
 * Hangul) */
const HALLUCINATIONS = new Set([
  'you', 'thankyou', 'thankyouverymuch', 'thankyousomuch', 'thanks', 'thanksforwatching', 'thankyouforwatching',
  'thankyousomuchforwatching', 'thanksforwatchingandseeyounexttime', 'pleasesubscribe', 'likeandsubscribe',
  'pleaselikeandsubscribe', 'bye', 'byebye', 'theend',
  // thank you for watching / thank you / please subscribe and like
  '\uC2DC\uCCAD\uD574\uC8FC\uC154\uC11C\uAC10\uC0AC\uD569\uB2C8\uB2E4', '\uAC10\uC0AC\uD569\uB2C8\uB2E4',
  '\uAD6C\uB3C5\uACFC\uC88B\uC544\uC694\uBD80\uD0C1\uB4DC\uB9BD\uB2C8\uB2E4',
  'ご視聴ありがとうございました', 'ありがとうございました', 'ご清聴ありがとうございました', 'チャンネル登録お願いします',
  '谢谢观看', '谢谢大家', '感谢观看', '謝謝觀看', '谢谢',
  'terimakasih', 'terimakasihtelahmenonton', 'terimakasihsudahmenonton',
  'gracias', 'graciasporver', 'graciasporverelvideo', 'suscribete', 'muchasgracias',
])
/** subtitle credits ("Subtitles by the Amara.org community", 字幕由Amara.org社区提供, "Subtítulos realizados por ...") */
const CREDIT = /^(?:(?:subtitles?|captions?|transcri(?:bed|ption)|translat(?:ed|ion))(?:by|madeby|providedby|realizadospor)|subt[ií]tulos|字幕|amaraorg|\uC790\uB9C9)/

/** lower case, no punctuation, symbols or spaces */
const normalize = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
/** one of the lines whisper writes for no speech */
export function learnedLine(text: string): boolean {
  const t = normalize(text)
  return !!t && (HALLUCINATIONS.has(t) || CREDIT.test(t))
}

/** One letter over and over ("ლლლლლ", a Sinhala letter 120 times): what whisper writes for a fan or a room's hum
 * (measured 2026-11-19, whisper.cpp small on real fan and office noise at 5-10 dB below speech; the sound moved enough to
 * pass as speech-like). Nobody says it. Hangul jamo are left alone: "ㅋㅋㅋㅋㅋ" is something a person dictates. */
export function letterLoop(text: string): boolean {
  const t = [...normalize(text)]
  return t.length >= 5 && new Set(t).size === 1 && !/[\u3131-\u318E\u1100-\u11FF]/u.test(t[0]!)
}

type Line = { start: number; end: number; text: string }
export type Heard = TranscribeResult & { segments?: Line[] }

/**
 * Whisper's answer without what it wrote for no speech. `sound`: soundOf the audio it heard (null: unknown, then
 * only the marks and an unsure answer of learned lines are dropped); `unsure`: whisper's own signal (whisper.cpp's
 * first-word probability, OpenRouter's no-speech probability / avg_logprob). Returns the answer with no text and no
 * lines when nothing in it was speech, else with only the marks taken out.
 */
export function keepSpeech<T extends Heard>(r0: T, sound: Sound | null, unsure: boolean): T {
  // "[Coughing] Please send …": the tag goes, the words stay (TC-4674); a line that was only tags is dropped below
  const r = stripSoundTags(r0)
  const lines = (r.segments?.length ? r.segments : r.text.trim() ? [{ start: 0, end: r.durationSec ?? 0, text: r.text }] : [])
    .filter((l) => l.text.trim() && !NOT_WORDS.test(l.text) && !letterLoop(l.text))
  const none = { ...r, text: '', segments: [] }
  if (!lines.length || silent(sound)) return none
  if (weak(sound) && unsure) return none
  if ((weak(sound) || (!sound && unsure)) && lines.every((l) => learnedLine(l.text))) return none
  if (lines.length === (r.segments?.length ? r.segments.length : 1)) return r
  return { ...r, text: lines.map((l) => l.text.trim()).join(' ').replace(/\s+/g, ' ').trim(), segments: r.segments?.length ? lines : r.segments }
}
