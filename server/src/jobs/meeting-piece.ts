// Meeting notes (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): the desktop app cuts a meeting's sound into
// pieces at pauses (desktop/src/common/meeting/chunker.ts) and sends each here (POST /api/meetings/piece). The server
// turns it into text with the team's voice input setting and answers at once:
// - 'openrouter': the app's WAV as it is (sendToOpenRouter: zero data retention requested, the second try, the hosting
//   key's free-hours meter). No ffmpeg per piece.
// - 'local': whisper.cpp on this server in a video piece's kind of turn (whisper-turns.ts pieceTurn: voice input goes
//   first, a piece waits at most MEETING_TURN_WAIT_MS). Meetings measure their own speed here (in memory); a server
//   that cannot keep up says so before a meeting starts (GET /api/meetings/status).
// - 'off', no key, no whisper-cli: refused. Safe operations 1A (sound never leaves the server) refuses OpenRouter.
// The piece is checked (the app's fixed 44-byte WAV header, at most MEETING_PIECE_MAX_SEC), used and deleted.
import fs from 'node:fs'
import path from 'node:path'
import { MEETING_PIECE_MAX_SEC, type Locale, type MeetingPieceResult, type MeetingStatus } from '@mycel/shared/api'
import { fail, modelReady, ensureModel, whisperFile, WHISPER_MODELS, type TranscribeConfig } from './transcribe'
import { sendToOpenRouter, SPEECH_NO_KEY, SPEECH_OFF } from './openrouter-stt'
import { pieceTurn } from './whisper-turns'
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
/** pieces measured before the speed counts (the first may load the model from disk) */
const SPEED_MIN_PIECES = 3

export const MEETING_TOO_SLOW = () => fail(
  '회의 기록에는 더 빠른 설정이 필요해요. 관리자에게 물어보세요.',
  'Meeting notes need a faster setup. Ask your admin.',
  'Catatan rapat memerlukan pengaturan yang lebih cepat. Tanyakan admin Anda.',
  '会議メモにはより速い設定が必要です。管理者に確認してください。',
  'Las notas de reunión necesitan una configuración más rápida. Pregunte a su administrador.',
  '会议记录需要更快的设置。请询问管理员。',
  'unavailable', 'too_slow')
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
const NOT_A_PIECE = () => fail(
  '회의 소리 조각을 읽을 수 없어요.', "This piece of the meeting's sound can't be read.", 'Potongan suara rapat ini tidak dapat dibaca.',
  '会議の音声の断片を読み取れません。', 'No se puede leer este fragmento del sonido de la reunión.', '无法读取这段会议声音。', 'bad_request', 'not_wav')

/** The piece is the app's WAV: RIFF/WAVE, one 16-byte PCM fmt chunk, 16-bit, mono, 16 kHz, then the data chunk to the
 * end of the file, within MEETING_PIECE_MAX_SEC. Returns its length in seconds, or null. */
export function pieceSeconds(head: Uint8Array, size: number): number | null {
  if (head.length < 44 || size < 44) return null
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE' || b.toString('latin1', 12, 16) !== 'fmt ' || b.toString('latin1', 36, 40) !== 'data') return null
  if (b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16) return null
  const data = b.readUInt32LE(40)
  if (data !== size - 44 || data % 2) return null
  const sec = data / 32_000
  return sec > 0 && sec <= MEETING_PIECE_MAX_SEC ? sec : null
}

/** whisper's marks for sound with no words ([BLANK_AUDIO], (music), [음악]) are not lines */
const NOT_WORDS = /^\s*[[(（][^\])）]{0,40}[\])）]\s*$/

/** This server's speed on meeting pieces: a moving average of wall time per second of sound, model loading included. */
export class MeetingSpeed {
  private avg = 0
  private n = 0
  record(elapsedMs: number, seconds: number) {
    if (!(seconds > 0)) return
    const v = elapsedMs / 1000 / seconds
    this.n++
    this.avg = this.n === 1 ? v : this.avg * 0.8 + v * 0.2
  }
  /** null until a few pieces were measured */
  secPerSec(): number | null { return this.n >= SPEED_MIN_PIECES ? this.avg : null }
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

const inFlight = new Map<string, number>()

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
  const spec = deps.stt.modelOverride ?? WHISPER_MODELS[deps.stt.model]
  void ensureModel(deps.stt).catch(() => { /* asked again by the next status */ })
  let have = 0
  try { have = fs.statSync(path.join(deps.stt.modelDir, spec.file + '.part')).size } catch { /* not started */ }
  return { state: 'getting_ready', modelMb: Math.round(spec.size / 1_000_000), progress: Math.min(1, have / spec.size) }
}

/** Turn one piece (a server-owned file, removed here whatever happens) into lines. Throws a JobFailure (localized) or
 * an Error('busy') while the person has MEETING_PIECES_IN_FLIGHT pieces under way. */
export async function meetingPiece(deps: MeetingDeps, userId: string, file: string, o: { language?: string; locale: Locale; signal?: AbortSignal }): Promise<MeetingPieceResult> {
  try {
    if ((inFlight.get(userId) ?? 0) >= MEETING_PIECES_IN_FLIGHT) throw new Error('busy')
    const provider = deps.provider()
    if (provider === 'off') throw SPEECH_OFF()
    let seconds: number | null = null
    let bytes: Buffer | null = null
    {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const st = fs.fstatSync(fd)
        const head = Buffer.alloc(44)
        if (st.isFile() && fs.readSync(fd, head, 0, 44, 0) === 44) seconds = pieceSeconds(head, st.size)
        if (seconds !== null && provider === 'openrouter') {
          bytes = Buffer.alloc(st.size)
          if (fs.readSync(fd, bytes, 0, st.size, 0) !== st.size) seconds = null
        }
      } finally { fs.closeSync(fd) }
    }
    if (seconds === null) throw NOT_A_PIECE()
    const lang = o.language && /^[a-z]{2}$/.test(o.language) ? o.language : undefined

    inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1)
    const ac = new AbortController()
    const stop = () => ac.abort(new Error('aborted'))
    o.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, MEETING_PIECE_TIMEOUT_MS)
    try {
      let r: { segments?: { start: number; end: number; text: string }[]; text: string; language: string | null }
      if (provider === 'openrouter') {
        if (deps.confidential()) throw MEETING_CONFIDENTIAL()
        const or = deps.openRouter()
        if (!or) throw SPEECH_NO_KEY()
        r = await sendToOpenRouter(deps.stt, or.key, or.model, bytes!, 'wav', { language: lang, signal: ac.signal, seconds })
      } else {
        if (!deps.stt.whisperBin) throw SPEECH_OFF()
        if (deps.speed.tooSlow()) throw MEETING_TOO_SLOW()
        const model = await modelReady(deps.stt)
        if (!model) throw MEETING_TOO_SLOW()
        const t0 = Date.now()
        const got = await pieceTurn(async (yieldSignal) => {
          const both = AbortSignal.any([ac.signal, yieldSignal])
          fs.mkdirSync(deps.stt.workBase, { recursive: true, mode: 0o700 })
          const work = fs.realpathSync(fs.mkdtempSync(path.join(deps.stt.workBase, 'meet-')))
          try {
            fs.copyFileSync(file, path.join(work, 'piece.wav'), fs.constants.COPYFILE_FICLONE)
            return await whisperFile(deps.stt, model, work, 'piece.wav', { language: lang, signal: both, timeoutMs: MEETING_PIECE_TIMEOUT_MS })
          } finally { fs.rmSync(work, { recursive: true, force: true }) }
        }, { signal: ac.signal, waitMs: MEETING_TURN_WAIT_MS })
        if (!got.ok) throw MEETING_BUSY()
        deps.speed.record(Date.now() - t0, seconds)
        r = got.value
      }
      const lines = (r.segments?.length ? r.segments : r.text ? [{ start: 0, end: seconds, text: r.text }] : [])
        .map((l) => ({ start: Math.max(0, l.start), end: Math.max(l.start, l.end), text: l.text.replace(/\s+/g, ' ').trim() }))
        .filter((l) => l.text && !NOT_WORDS.test(l.text))
      return { lines, language: r.language }
    } catch (e) {
      if (e instanceof JobFailure) throw e
      if (ac.signal.aborted && !o.signal?.aborted) throw MEETING_BUSY()
      throw e
    } finally {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', stop)
      const n = (inFlight.get(userId) ?? 1) - 1
      if (n > 0) inFlight.set(userId, n)
      else inFlight.delete(userId)
    }
  } finally { fs.rmSync(file, { force: true }) }
}
