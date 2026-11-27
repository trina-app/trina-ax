// Pieces of speech (shared/src/speech-pieces.ts cuts them at pauses): the web app's voice input while the person talks
// (docs/AGENTS/plan/20261117-0143-voice-live-text.md, POST /api/transcribe/piece) sends each piece here. The server
// turns it into text with the team's voice input setting and answers at once:
// - 'openrouter': the app's WAV as it is (sendToOpenRouter: zero data retention requested, the second try, the hosting
//   key's free-hours meter). No ffmpeg per piece.
// - 'local': whisper.cpp on this server in a video piece's kind of turn (whisper-turns.ts pieceTurn: voice input goes
//   first, a piece waits at most MEETING_TURN_WAIT_MS).
// - 'off', no key, no whisper-cli: refused. Safe operations 1A (sound never leaves the server) refuses OpenRouter.
// The route checks the chat as POST /api/transcribe does (the caller's, never a confidential chat's sound to
// OpenRouter); its own pieces at once and a per-person limit a minute (VOICE_PIECES_PER_MIN, VOICE_SOUND_SEC_PER_MIN:
// someone talking makes at most 60 s of sound a minute). Every OpenRouter piece goes through the free-hours meter with
// its seconds of sound, as one recording does.
// The piece is checked (the app's fixed 44-byte WAV header, at most MEETING_PIECE_MAX_SEC), used and deleted.
// The MEETING_* and Meeting* names are from the desktop meeting notes that also sent pieces here (removed 2026-11-19,
// docs/decisions/20261119-remove-meeting-notes.md); they stay until the voice input work on this file settles.
import fs from 'node:fs'
import path from 'node:path'
import { MEETING_PIECE_MAX_SEC, type Locale, type MeetingPieceResult } from '@mycel/shared/api'
import { fail, modelReady, whisperFile, whisperUnsure, type TranscribeConfig } from './transcribe'
import { openRouterSpeech, sendToOpenRouter, SPEECH_CONFIDENTIAL, SPEECH_NO_KEY, SPEECH_OFF } from './openrouter-stt'
import { keepSpeech, NOT_WORDS, silent, soundOf, type Sound } from './no-speech'
import { pieceTurn } from './whisper-turns'
import { confidence, saysOtherLanguage, scriptOf, UNSURE_LOGPROB, writingSystem, type ScoredAnswer } from './speech-language'
import { JobFailure } from './service'
import { copyOffLoop } from '../files/copy-off-loop'

/** the longest a piece waits for the server's one whisper.cpp before the app is told to send it again later */
export const MEETING_TURN_WAIT_MS = 20_000
/** the longest a piece may take */
export const MEETING_PIECE_TIMEOUT_MS = 60_000
/** voice input: pieces of one person at once (one recording sends at most two) */
export const VOICE_PIECES_IN_FLIGHT = 2
/** voice input: the window of the per-person limit, and what it allows in it */
export const VOICE_LIMIT_WINDOW_MS = 60_000
export const VOICE_PIECES_PER_MIN = 40
export const VOICE_SOUND_SEC_PER_MIN = 120
export const MEETING_BUSY = () => fail(
  '팀 서버가 다른 소리를 받아 적는 중이에요. 이 조각은 조금 뒤 다시 보낼게요.',
  'The team server is busy with other speech. This piece will be sent again shortly.',
  'Server tim sedang sibuk dengan suara lain. Potongan ini akan dikirim lagi sebentar lagi.',
  'チームのサーバーが別の音声を処理中です。この部分は少し後でもう一度送ります。',
  'El servidor del equipo está ocupado con otra voz. Este fragmento se enviará de nuevo en breve.',
  '团队服务器正在处理其他语音。这一段稍后会再次发送。',
  'unavailable', 'busy')
export const MEETING_NOT_READY = () => fail(
  '음성 입력 준비가 아직 끝나지 않았어요. 잠시 뒤 다시 보낼게요.',
  'Voice input is still getting ready. This piece will be sent again shortly.',
  'Input suara masih disiapkan. Potongan ini akan dikirim lagi sebentar lagi.',
  '音声入力の準備がまだ終わっていません。この部分は少し後でもう一度送ります。',
  'La entrada de voz aún se está preparando. Este fragmento se enviará de nuevo en breve.',
  '语音输入还在准备中。这一段稍后会再次发送。',
  'unavailable', 'not_ready')
/** the person already has VOICE_PIECES_IN_FLIGHT pieces under way: the app sends this one again shortly */
export class MeetingInFlight extends Error { constructor() { super('in_flight'); this.name = 'MeetingInFlight' } }
/** voice input: the person sent more than the per-person limit allows in a minute; `retryAfter` seconds until it does */
export class PieceTooFast extends Error { constructor(public retryAfter: number) { super('too_fast'); this.name = 'PieceTooFast' } }
/** voice input is off here (no provider, no whisper-cli): a final refusal with its reason */
const OFF = () => { const f = SPEECH_OFF(); return new JobFailure('conflict', f.messages, 'off') }
const NO_KEY = () => { const f = SPEECH_NO_KEY(); return new JobFailure('conflict', f.messages, 'no_key') }
/** the request was closed by the app before the answer */
export class MeetingGone extends Error { constructor() { super('gone'); this.name = 'MeetingGone' } }
const NOT_A_PIECE = () => fail(
  '소리 조각을 읽을 수 없어요.',
  "This piece of sound can't be read.",
  'Potongan suara ini tidak dapat dibaca.',
  '音声の断片を読み取れません。', 'No se puede leer este fragmento de sonido.', '无法读取这段声音。', 'bad_request', 'not_wav')

/** The piece is the app's WAV: RIFF/WAVE, one 16-byte PCM fmt chunk, 16-bit, mono, 16 kHz, then the data chunk to the
 * end of the file, within MEETING_PIECE_MAX_SEC. Returns its length in seconds, or null. */
export function pieceSeconds(head: Uint8Array, size: number): number | null {
  if (head.length < 44 || size < 44) return null
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE' || b.toString('latin1', 12, 16) !== 'fmt ' || b.toString('latin1', 36, 40) !== 'data') return null
  if (b.readUInt32LE(4) !== size - 8) return null
  if (b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16) return null
  const data = b.readUInt32LE(40)
  if (data !== size - 44 || data % 2) return null
  const sec = data / 32_000
  return sec > 0 && sec <= MEETING_PIECE_MAX_SEC ? sec : null
}

/** whisper doubts a hinted voice piece below this mean avg_logprob: lower than UNSURE_LOGPROB (measured on a minute and
 * more), since a 2 s piece in the right language often scores near -0.4; a translation scored -0.48 to -2.3 */
export const VOICE_HINT_DOUBT_LOGPROB = -0.6
/** a hinted answer that may be in the wrong language: only the "foreign language" caption, or whisper very unsure of it */
export function hintDoubtful(r: ScoredAnswer): boolean {
  return saysOtherLanguage(r) || (!!r.scored && confidence(r.scored) < VOICE_HINT_DOUBT_LOGPROB)
}
/** the answer without the hint replaces the hinted one: words where the hinted one had only the caption; else whisper
 * sure of it (UNSURE_LOGPROB), surer than of the hinted one by HINT_MARGIN, and written in its own language's script
 * (whisper's id/ms or ko/ja guesses on a short piece must not win on a score alone) */
const HINT_MARGIN = 0.2
export function keepUntold(told: ScoredAnswer, free: ScoredAnswer): boolean {
  if (!free.text.trim() || saysOtherLanguage(free)) return false
  if (saysOtherLanguage(told)) return true
  if (!told.scored || !free.scored) return false
  const script = free.language ? scriptOf(free.language) : null
  if (script && writingSystem(free.text) !== script) return false
  const over = Math.max(told.scored.covered, free.scored.covered)
  const sure = confidence(free.scored, over)
  return sure >= UNSURE_LOGPROB && sure > confidence(told.scored, over) + HINT_MARGIN
}

export interface MeetingDeps {
  stt: TranscribeConfig
  provider(): 'off' | 'local' | 'openrouter'
  /** OpenRouter: the key to use and the model it may use, or null without a key */
  openRouter(): { key: string; model: string } | null
  /** Safe operations 1A: no sound leaves this server */
  confidential(): boolean
}

/** pieces under way per person */
const inFlight = new Map<string, number>()
/** voice input's pieces of the last VOICE_LIMIT_WINDOW_MS per person: when and how long */
const voiceSent = new Map<string, { at: number; sec: number }[]>()
/** tests: forget every count */
export function resetPieceLimitsForTests() { inFlight.clear(); voiceSent.clear() }
/** voice input's limit a minute: seconds until `sec` more fits, 0 when it fits now (then it is counted) */
function voiceLimit(userId: string, sec: number, now = Date.now()): number {
  const from = now - VOICE_LIMIT_WINDOW_MS
  const recent = (voiceSent.get(userId) ?? []).filter((p) => p.at > from)
  const total = recent.reduce((n, p) => n + p.sec, 0)
  if (recent.length >= VOICE_PIECES_PER_MIN || total + sec > VOICE_SOUND_SEC_PER_MIN) {
    voiceSent.set(userId, recent)
    return Math.max(1, Math.ceil((recent[0]!.at + VOICE_LIMIT_WINDOW_MS - now) / 1000))
  }
  recent.push({ at: now, sec })
  voiceSent.set(userId, recent)
  return 0
}
/** Turn one piece of voice input (a server-owned file, removed here whatever happens) into lines. Throws a JobFailure
 * (localized), MeetingInFlight while the person has VOICE_PIECES_IN_FLIGHT pieces under way, or PieceTooFast over the
 * limit a minute. */
export async function speechPiece(deps: MeetingDeps, userId: string, file: string, o: { language?: string; locale: Locale; signal?: AbortSignal }): Promise<MeetingPieceResult> {
  const slot = userId
  try {
    if ((inFlight.get(slot) ?? 0) >= VOICE_PIECES_IN_FLIGHT) throw new MeetingInFlight()
    const provider = deps.provider()
    if (provider === 'off') throw OFF()
    // sound never leaves this server (Safe operations 1A): refused before the piece is read
    if (provider === 'openrouter' && deps.confidential()) throw SPEECH_CONFIDENTIAL()
    let seconds: number | null = null
    let bytes: Buffer | null = null
    {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const st = fs.fstatSync(fd)
        const head = Buffer.alloc(44)
        if (st.isFile() && fs.readSync(fd, head, 0, 44, 0) === 44) seconds = pieceSeconds(head, st.size)
        // the whole piece (at most MEETING_PIECE_MAX_SEC, about 500 KB): OpenRouter's body, and the sound check
        if (seconds !== null) {
          bytes = Buffer.alloc(st.size)
          if (fs.readSync(fd, bytes, 0, st.size, 0) !== st.size) seconds = null
        }
      } finally { fs.closeSync(fd) }
    }
    if (seconds === null) throw NOT_A_PIECE()
    const sound: Sound | null = soundOf(bytes!)
    const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : undefined
    const wait = voiceLimit(userId, seconds)
    if (wait > 0) throw new PieceTooFast(wait)
    // a piece with no sound goes to no model (jobs/no-speech.ts): no whisper.cpp turn, no OpenRouter request
    if (silent(sound)) return { lines: [], language: null }

    inFlight.set(slot, (inFlight.get(slot) ?? 0) + 1)
    const ac = new AbortController()
    const stop = () => ac.abort(new Error('aborted'))
    o.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, MEETING_PIECE_TIMEOUT_MS)
    try {
      let r: { segments?: { start: number; end: number; text: string }[]; text: string; language: string | null }
      /** false: voice input's hint was not used for these words (refused by the provider, or doubted and replaced) */
      let hinted: false | undefined
      if (provider === 'openrouter') {
        const or = deps.openRouter()
        if (!or) throw NO_KEY()
        let got = await sendToOpenRouter(deps.stt, or.key, or.model, bytes!, 'wav', { language: lang, signal: ac.signal, seconds, hintOnly: true })
        // voice input's language is the app's, only a hint: whisper told a language the person did not speak translates
        // (speech-language.ts) and is unsure of it, or writes the "foreign language" caption; then the piece goes once
        // more without it (one more request on the meter: OpenRouter bills it too), and that answer is kept only when
        // whisper is sure of it. Not when the hint was not used at all (a provider that refused the field).
        if (lang && got.hinted !== false && hintDoubtful(got)) {
          const free = await sendToOpenRouter(deps.stt, or.key, or.model, bytes!, 'wav', { signal: ac.signal, seconds }).catch((e) => { if (ac.signal.aborted) throw e; return null })
          if (free && keepUntold(got, free)) got = { ...free, hinted: false }
        }
        hinted = got.hinted
        // whisper's words for noise or a beep are not lines (jobs/no-speech.ts)
        r = openRouterSpeech(got, sound)
      } else {
        if (!deps.stt.whisperBin) throw OFF()
        const model = await modelReady(deps.stt)
        if (!model) throw MEETING_NOT_READY()
        const got = await pieceTurn(async (yieldSignal) => {
          const both = AbortSignal.any([ac.signal, yieldSignal])
          fs.mkdirSync(deps.stt.workBase, { recursive: true, mode: 0o700 })
          const work = fs.realpathSync(fs.mkdtempSync(path.join(deps.stt.workBase, 'meet-')))
          try {
            await copyOffLoop(file, path.join(work, 'piece.wav'))
            // no temperature fallback, as a video read's pieces (whisper-turns, transcribe.ts whisperFile noFallback)
            // (voice input's hint is the app's language, not the speaker's: whisper.cpp told it would translate, so it
            // guesses there)
            return await whisperFile(deps.stt, model, work, 'piece.wav', { language: undefined, signal: both, timeoutMs: MEETING_PIECE_TIMEOUT_MS, noFallback: true, tokens: true })
          } finally { fs.rmSync(work, { recursive: true, force: true }) }
        }, { signal: ac.signal, waitMs: MEETING_TURN_WAIT_MS })
        if (!got.ok) throw MEETING_BUSY()
        // whisper's words for noise or a beep are not lines (jobs/no-speech.ts)
        r = keepSpeech(got.value, sound, whisperUnsure(got.value))
      }
      const lines = (r.segments?.length ? r.segments : r.text ? [{ start: 0, end: seconds, text: r.text }] : [])
        .map((l) => { const start = Math.min(seconds!, Math.max(0, l.start)); return { start, end: Math.min(seconds!, Math.max(start, l.end)), text: l.text.replace(/\s+/g, ' ').trim() } })
        .filter((l) => l.text && !NOT_WORDS.test(l.text))
      return { lines, language: r.language, ...(lang && hinted === false ? { hinted: false as const } : {}) }
    } catch (e) {
      if (e instanceof JobFailure) throw e
      // the time limit (not the app going away): send it again later
      if (ac.signal.aborted && !o.signal?.aborted) throw MEETING_BUSY()
      // the app went away: nobody reads the answer
      if (o.signal?.aborted) throw new MeetingGone()
      throw e
    } finally {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', stop)
      const n = (inFlight.get(slot) ?? 1) - 1
      if (n > 0) inFlight.set(slot, n)
      else inFlight.delete(slot)
    }
  } finally { fs.rmSync(file, { force: true }) }
}
