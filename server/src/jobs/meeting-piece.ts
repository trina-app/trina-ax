// Pieces of speech (shared/src/speech-pieces.ts cuts them at pauses): the desktop app's meeting notes
// (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md, POST /api/meetings/piece) and the web app's voice input while
// the person talks (docs/AGENTS/plan/20261117-0143-voice-live-text.md, POST /api/transcribe/piece) send each piece
// here. The server turns it into text with the team's voice input setting and answers at once:
// - 'openrouter': the app's WAV as it is (sendToOpenRouter: zero data retention requested, the second try, the hosting
//   key's free-hours meter). No ffmpeg per piece.
// - 'local': whisper.cpp on this server in a video piece's kind of turn (whisper-turns.ts pieceTurn: voice input goes
//   first, a piece waits at most MEETING_TURN_WAIT_MS). Meetings measure their own speed here (in memory); a server
//   that cannot keep up says so before a meeting starts (GET /api/meetings/status).
// - 'off', no key, no whisper-cli: refused. Safe operations 1A (sound never leaves the server) refuses OpenRouter.
// Voice input ('voice'): the route checks the chat as POST /api/transcribe does (the caller's, never a confidential
// chat's sound to OpenRouter); its own pieces at once and a per-person limit a minute (VOICE_PIECES_PER_MIN,
// VOICE_SOUND_SEC_PER_MIN: someone talking makes at most 60 s of sound a minute), and no meeting speed check (it is
// not a meeting that must keep up). Every OpenRouter piece goes through the free-hours meter with its seconds of sound,
// as one recording does.
// The piece is checked (the app's fixed 44-byte WAV header, at most MEETING_PIECE_MAX_SEC), used and deleted.
import fs from 'node:fs'
import path from 'node:path'
import { MEETING_PIECE_MAX_SEC, type Locale, type MeetingPieceResult, type MeetingStatus } from '@mycel/shared/api'
import { fail, modelReady, ensureModel, whisperFile, whisperUnsure, WHISPER_MODELS, type TranscribeConfig } from './transcribe'
import { openRouterSpeech, sendToOpenRouter, SPEECH_CONFIDENTIAL, SPEECH_NO_KEY, SPEECH_OFF } from './openrouter-stt'
import { keepSpeech, NOT_WORDS, silent, soundOf, type Sound } from './no-speech'
import { pieceTurn } from './whisper-turns'
import { confidence, saysOtherLanguage, scriptOf, UNSURE_LOGPROB, writingSystem, type ScoredAnswer } from './speech-language'
import { JobFailure } from './service'

/** above this (seconds of whisper, model loading included, per second of sound) a server cannot keep up with a
 * meeting: two tracks may carry speech at once */
export const MEETING_LOCAL_MAX_SEC_PER_SEC = 0.45
/** pieces of one person being turned into text at the same time (a meeting has two tracks) */
export const MEETING_PIECES_IN_FLIGHT = 2
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
/** pieces measured before the speed counts (the first after a pause loads the model from disk and is not counted) */
const SPEED_MIN_PIECES = 3
/** the speed is the sum of whisper time over the sum of sound of the pieces of the last MEETING_SPEED_WINDOW_MS */
export const MEETING_SPEED_WINDOW_MS = 10 * 60_000
/** after a failed first-use model download, the status says `off` this long before it tries again */
export const MEETING_MODEL_RETRY_MS = 5 * 60_000

export const MEETING_TOO_SLOW = () => { const f = fail(
  '회의 기록에는 더 빠른 설정이 필요해요. 관리자에게 물어보세요.',
  'Meeting notes need a faster setup. Ask your admin.',
  'Catatan rapat memerlukan pengaturan yang lebih cepat. Tanyakan admin Anda.',
  '会議メモにはより速い設定が必要です。管理者に確認してください。',
  'Las notas de reunión necesitan una configuración más rápida. Pregunte a su administrador.',
  '会议记录需要更快的设置。请询问管理员。',
  'unavailable', 'too_slow'); return new JobFailure('conflict', f.messages, 'too_slow') }
export const MEETING_CONFIDENTIAL = () => fail(
  '이 팀은 소리를 팀 서버 밖으로 보내지 않아요. 회의 기록은 관리자가 음성 입력을 "이 서버에서"로 바꾸면 쓸 수 있어요.',
  'This team never sends sound outside its own server. Meeting notes work when an admin sets voice input to "On this server".',
  'Tim ini tidak pernah mengirim suara ke luar servernya. Catatan rapat bisa dipakai jika admin mengatur input suara ke "Di server ini".',
  'このチームは音声をチームのサーバーの外に送りません。管理者が音声入力を「このサーバー上」にすると会議メモを使えます。',
  'Este equipo nunca envía sonido fuera de su propio servidor. Las notas de reunión funcionan si un administrador configura la entrada de voz como "En este servidor".',
  '这个团队从不把声音发送到自己的服务器之外。管理员把语音输入设为“在此服务器上”后，就能使用会议记录。',
  'forbidden', 'confidential')
export const MEETING_BUSY = () => fail(
  '팀 서버가 다른 소리를 받아 적는 중이에요. 이 조각은 조금 뒤 다시 보낼게요.',
  'The team server is busy with other speech. This piece will be sent again shortly.',
  'Server tim sedang sibuk dengan suara lain. Potongan ini akan dikirim lagi sebentar lagi.',
  'チームのサーバーが別の音声を処理中です。この部分は少し後でもう一度送ります。',
  'El servidor del equipo está ocupado con otra voz. Este fragmento se enviará de nuevo en breve.',
  '团队服务器正在处理其他语音。这一段稍后会再次发送。',
  'unavailable', 'busy')
export const MEETING_NOT_READY = () => fail(
  '회의 기록 준비가 아직 끝나지 않았어요. 잠시 뒤 다시 보낼게요.',
  'Meeting notes are still getting ready. This piece will be sent again shortly.',
  'Catatan rapat masih disiapkan. Potongan ini akan dikirim lagi sebentar lagi.',
  '会議メモの準備がまだ終わっていません。この部分は少し後でもう一度送ります。',
  'Las notas de reunión aún se están preparando. Este fragmento se enviará de nuevo en breve.',
  '会议记录还在准备中。这一段稍后会再次发送。',
  'unavailable', 'not_ready')
/** the person already has MEETING_PIECES_IN_FLIGHT pieces under way: the app sends this one again shortly */
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

/** This server's speed on meeting pieces: whisper.cpp's time (not the wait for the turn) over the sound, summed over
 * the pieces of the last MEETING_SPEED_WINDOW_MS (whisper reads a 30 s window whatever it gets, so a short piece's own
 * ratio says little). The first piece after a quiet spell loads the model from disk and is not counted. Old pieces are
 * forgotten, so a server that was busy for a while is not refused for good. */
export class MeetingSpeed {
  private pieces: { at: number; ms: number; sec: number }[] = []
  private lastAt = -Infinity
  constructor(private now: () => number = Date.now) {}
  record(elapsedMs: number, seconds: number) {
    if (!(seconds > 0) || !(elapsedMs >= 0)) return
    const at = this.now()
    const cold = at - this.lastAt > MEETING_SPEED_WINDOW_MS
    this.lastAt = at
    if (cold) return
    this.pieces.push({ at, ms: elapsedMs, sec: seconds })
  }
  /** null until SPEED_MIN_PIECES recent pieces were measured */
  secPerSec(): number | null {
    const from = this.now() - MEETING_SPEED_WINDOW_MS
    this.pieces = this.pieces.filter((p) => p.at >= from)
    if (this.pieces.length < SPEED_MIN_PIECES) return null
    const ms = this.pieces.reduce((n, p) => n + p.ms, 0), sec = this.pieces.reduce((n, p) => n + p.sec, 0)
    return ms / 1000 / sec
  }
  tooSlow(): boolean { const v = this.secPerSec(); return v !== null && v > MEETING_LOCAL_MAX_SEC_PER_SEC }
}

export interface MeetingDeps {
  stt: TranscribeConfig
  provider(): 'off' | 'local' | 'openrouter'
  /** OpenRouter: the key to use and the model it may use, or null without a key */
  openRouter(): { key: string; model: string } | null
  /** Safe operations 1A: no sound leaves this server */
  confidential(): boolean
  speed: MeetingSpeed
}

/** pieces under way per person and use ('meeting:<id>', 'voice:<id>'): a meeting and voice input never wait for each other */
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
/** the last failed first-use model download (meetingStatus waits MEETING_MODEL_RETRY_MS before another) */
let modelFailedAt = -Infinity

/** GET /api/meetings/status: whether meeting notes can start now. A local server without its model starts the
 * first-use download (one at a time) and says how far it is. */
export async function meetingStatus(deps: MeetingDeps): Promise<MeetingStatus> {
  const p = deps.provider()
  if (p === 'off') return { state: 'off' }
  if (p === 'openrouter') {
    if (deps.confidential()) return { state: 'confidential' }
    return deps.openRouter() ? { state: 'ready' } : { state: 'off' }
  }
  if (!deps.stt.whisperBin) return { state: 'off' }
  if (deps.speed.tooSlow()) return { state: 'too_slow' }
  if (await modelReady(deps.stt)) return { state: 'ready' }
  // a failed download is not started again by every look of every member's app
  const spec = deps.stt.modelOverride ?? WHISPER_MODELS[deps.stt.model]
  if (Date.now() - modelFailedAt < MEETING_MODEL_RETRY_MS) return { state: 'getting_ready', modelMb: Math.round(spec.size / 1_000_000), progress: 0, failed: true }
  void ensureModel(deps.stt).catch(() => { modelFailedAt = Date.now() })
  let have = 0
  try { have = fs.statSync(path.join(deps.stt.modelDir, spec.file + '.part')).size } catch { /* not started */ }
  return { state: 'getting_ready', modelMb: Math.round(spec.size / 1_000_000), progress: Math.min(1, have / spec.size) }
}

/** A meeting's piece (speechPiece for meeting notes). */
export function meetingPiece(deps: MeetingDeps, userId: string, file: string, o: { language?: string; locale: Locale; signal?: AbortSignal }): Promise<MeetingPieceResult> {
  return speechPiece(deps, userId, file, { ...o, use: 'meeting' })
}

/** Turn one piece (a server-owned file, removed here whatever happens) into lines. Throws a JobFailure (localized),
 * MeetingInFlight while the person has their use's pieces under way, or (voice input) PieceTooFast over the limit a
 * minute. */
export async function speechPiece(deps: MeetingDeps, userId: string, file: string, o: { language?: string; locale: Locale; signal?: AbortSignal; use: 'meeting' | 'voice' }): Promise<MeetingPieceResult> {
  const voice = o.use === 'voice'
  const slot = `${o.use}:${userId}`
  try {
    if ((inFlight.get(slot) ?? 0) >= (voice ? VOICE_PIECES_IN_FLIGHT : MEETING_PIECES_IN_FLIGHT)) throw new MeetingInFlight()
    const provider = deps.provider()
    if (provider === 'off') throw OFF()
    // sound never leaves this server (Safe operations 1A): refused before the piece is read
    if (provider === 'openrouter' && deps.confidential()) throw voice ? SPEECH_CONFIDENTIAL() : MEETING_CONFIDENTIAL()
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
    if (voice) {
      const wait = voiceLimit(userId, seconds)
      if (wait > 0) throw new PieceTooFast(wait)
    }
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
        let got = await sendToOpenRouter(deps.stt, or.key, or.model, bytes!, 'wav', { language: lang, signal: ac.signal, seconds, hintOnly: voice })
        // voice input's language is the app's, only a hint: whisper told a language the person did not speak translates
        // (speech-language.ts) and is unsure of it, or writes the "foreign language" caption; then the piece goes once
        // more without it (one more request on the meter: OpenRouter bills it too), and that answer is kept only when
        // whisper is sure of it. Not when the hint was not used at all (a provider that refused the field).
        if (voice && lang && got.hinted !== false && hintDoubtful(got)) {
          const free = await sendToOpenRouter(deps.stt, or.key, or.model, bytes!, 'wav', { signal: ac.signal, seconds }).catch((e) => { if (ac.signal.aborted) throw e; return null })
          if (free && keepUntold(got, free)) got = { ...free, hinted: false }
        }
        hinted = got.hinted
        // whisper's words for noise or a beep are not lines (jobs/no-speech.ts)
        r = openRouterSpeech(got, sound)
      } else {
        if (!deps.stt.whisperBin) throw OFF()
        // a meeting must keep up with two tracks; voice input only waits a little longer
        if (!voice && deps.speed.tooSlow()) throw MEETING_TOO_SLOW()
        const model = await modelReady(deps.stt)
        if (!model) throw MEETING_NOT_READY()
        let t0 = 0
        const got = await pieceTurn(async (yieldSignal) => {
          // whisper's own time: the wait for the turn is not the server's speed
          t0 = Date.now()
          const both = AbortSignal.any([ac.signal, yieldSignal])
          fs.mkdirSync(deps.stt.workBase, { recursive: true, mode: 0o700 })
          const work = fs.realpathSync(fs.mkdtempSync(path.join(deps.stt.workBase, 'meet-')))
          try {
            fs.copyFileSync(file, path.join(work, 'piece.wav'), fs.constants.COPYFILE_FICLONE)
            // no temperature fallback, as a video read's pieces (whisper-turns, transcribe.ts whisperFile noFallback)
            // (voice input's hint is the app's language, not the speaker's: whisper.cpp told it would translate, so it
            // guesses there)
            return await whisperFile(deps.stt, model, work, 'piece.wav', { language: voice ? undefined : lang, signal: both, timeoutMs: MEETING_PIECE_TIMEOUT_MS, noFallback: true, tokens: true })
          } finally { fs.rmSync(work, { recursive: true, force: true }) }
        }, { signal: ac.signal, waitMs: MEETING_TURN_WAIT_MS })
        if (!got.ok) throw MEETING_BUSY()
        deps.speed.record(Date.now() - t0, seconds)
        // whisper's words for noise or a beep are not lines (jobs/no-speech.ts)
        r = keepSpeech(got.value, sound, whisperUnsure(got.value))
      }
      const lines = (r.segments?.length ? r.segments : r.text ? [{ start: 0, end: seconds, text: r.text }] : [])
        .map((l) => { const start = Math.min(seconds!, Math.max(0, l.start)); return { start, end: Math.min(seconds!, Math.max(start, l.end)), text: l.text.replace(/\s+/g, ' ').trim() } })
        .filter((l) => l.text && !NOT_WORDS.test(l.text))
      return { lines, language: r.language, ...(voice && lang && hinted === false ? { hinted: false as const } : {}) }
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
