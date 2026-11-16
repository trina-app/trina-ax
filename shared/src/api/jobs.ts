// Long-running work (tab 4 "업로드와 오래 걸리는 작업"). Owner: C (server/src/routes/jobs.ts, server/src/jobs/*).
// Starting endpoints answer 202 { jobId } at once; progress over WebSocket job.progress / job.done.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { JobAccepted, SMALL_UPLOAD_MAX } from './common'
import { endpoint, multipart } from './endpoint'
import { Job } from './entities'

export const TranscribeFields = z.object({
  /** language hint (ISO 639-1), default: auto */
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  /** chat the voice input belongs to (the composer sends it; absent: a chat not created yet). The server checks it is
   * the caller's and refuses (403, reason `confidential`) to send a confidential chat's recording to OpenRouter. */
  chatId: Uuid7.optional(),
})

/** Meeting notes (desktop app, docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): one piece of a meeting's sound,
 * cut at a pause by the app, at most MEETING_PIECE_MAX_SEC, as 16 kHz mono 16-bit WAV. */
export const MEETING_PIECE_MAX_SEC = 15.5
/** the WAV of a piece: a 44-byte header and 32 000 bytes a second */
export const MEETING_PIECE_MAX_BYTES = 44 + Math.ceil(MEETING_PIECE_MAX_SEC * 32_000)
export const MeetingPieceFields = z.object({
  /** language of the meeting (ISO 639-1); absent: whisper guesses per piece */
  language: z.string().regex(/^[a-z]{2}$/).optional(),
})
export const MeetingPieceResult = z.object({
  /** the lines heard, times in seconds from the piece's start */
  lines: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  language: z.string().nullable(),
})
export type MeetingPieceResult = z.infer<typeof MeetingPieceResult>
/** whether meeting notes can start now: `off` (voice input off, no key, no whisper.cpp), `confidential` (Safe
 * operations 1A with OpenRouter: sound never leaves the server), `too_slow` (this server's whisper.cpp cannot keep up),
 * `getting_ready` (the first-use speech model is downloading: its size and how far it is) */
export const MeetingStatus = z.object({
  state: z.enum(['ready', 'off', 'confidential', 'too_slow', 'getting_ready']),
  modelMb: z.number().int().positive().optional(),
  progress: z.number().min(0).max(1).optional(),
})
export type MeetingStatus = z.infer<typeof MeetingStatus>

export const JOBS = {
  getJob: endpoint({ method: 'GET', path: '/api/jobs/:id', auth: 'user', owner: 'C', response: Job, summary: 'Own job (jobs of nobody, e.g. system backups: the owner). Result when done.' }),
  cancelJob: endpoint({ method: 'POST', path: '/api/jobs/:id/cancel', auth: 'user', owner: 'C', response: Job, summary: 'Cancel a queued or running own job.' }),
  transcribe: endpoint({ method: 'POST', path: '/api/transcribe', auth: 'user', owner: 'C', status: 202, body: multipart(TranscribeFields, SMALL_UPLOAD_MAX), response: JobAccepted, summary: 'Voice input / recordings up to 50 MB (larger: upload session with target transcribe). Result: TranscribeResult.' }),
  meetingStatus: endpoint({ method: 'GET', path: '/api/meetings/status', auth: 'user', owner: 'C', response: MeetingStatus, summary: 'Meeting notes (desktop app): whether they can start now with the team\'s voice input setting; on a server that turns speech into text itself, starts the first-use model download and says how far it is.' }),
  meetingPiece: endpoint({ method: 'POST', path: '/api/meetings/piece', auth: 'user', owner: 'C', body: multipart(MeetingPieceFields, MEETING_PIECE_MAX_BYTES), response: MeetingPieceResult, summary: "Meeting notes (desktop app): one piece of a meeting's sound (16 kHz mono 16-bit WAV, at most 15.5 s) turned into text with the team's voice input setting, answered at once. The sound is deleted after; nothing is kept. Send again after retryAfter on 429 (reason in_flight) and 503 (busy, not_ready); 409 (off, no_key, too_slow) and 403 (confidential) end the meeting." }),
} as const
