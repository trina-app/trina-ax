// The speech model, downloaded before anyone needs it (QA TC-4919, docs/decisions/20261118-speech-model-ahead.md).
// Before it the first recording an AI read on an Office Mac met the 488 MB download and the AI told the person to "use
// voice input once" and ask again. Now, wherever the team's speech provider is "this server" (local: an Apple silicon
// Mac with whisper-cli by default, or a server an admin set to it) and whisper.cpp is there, the server downloads the
// model on its own: a minute after it starts, and again on a later check when the provider is switched to local or a
// download failed (with a growing pause, so a server without internet does not try all the time). One download at a
// time (jobs/transcribe.ts ensureModel, shared with voice input and the AI's reads); sha256 checked as always.
// MYCEL_SPEECH_PREFETCH=0 turns it off (tests, a server that should only fetch on first use).
import type { Database } from 'bun:sqlite'
import { getTeamSettings } from '../admin/settings'
import { ensureModel, modelDownloading, modelOnDisk, type TranscribeConfig } from './transcribe'

/** after the server starts, before the first try (the server's own start comes first) */
export const PREFETCH_FIRST_MS = 60_000
/** how often the conditions are looked at again (an admin switched the provider to local) */
export const PREFETCH_CHECK_MS = 10 * 60_000
/** the pause after a failed download: doubled after each failure, up to the maximum */
export const PREFETCH_RETRY_MS = 5 * 60_000
export const PREFETCH_RETRY_MAX_MS = 6 * 60 * 60_000

/** Whether this server should have the model now: the provider is local and whisper.cpp is installed. */
export function wantsModel(db: Database, cfg: Pick<TranscribeConfig, 'whisperBin'>): boolean {
  if (!cfg.whisperBin) return false
  try { return getTeamSettings(db).speechProvider === 'local' } catch { return false }
}

export interface Prefetch { stop(): void; /** tests: one check now */ tick(): Promise<'skipped' | 'ready' | 'downloaded' | 'failed' | 'waiting'> }

export function startModelPrefetch(o: { db: Database; cfg: TranscribeConfig; log?: { info(m: string, x?: object): void; warn(m: string, x?: object): void }; env?: Record<string, string | undefined>; firstMs?: number; checkMs?: number; now?: () => number }): Prefetch {
  const env = o.env ?? process.env
  const now = o.now ?? Date.now
  let failures = 0
  let notBefore = 0
  let stopped = false
  const tick: Prefetch['tick'] = async () => {
    if (stopped || env.MYCEL_SPEECH_PREFETCH === '0' || !wantsModel(o.db, o.cfg)) return 'skipped'
    if (modelOnDisk(o.cfg)) return 'ready'
    if (modelDownloading()) return 'waiting'
    if (now() < notBefore) return 'waiting'
    try {
      o.log?.info('downloading the speech model ahead of first use')
      await ensureModel(o.cfg)
      failures = 0
      o.log?.info('the speech model is ready')
      return 'downloaded'
    } catch (e) {
      failures++
      notBefore = now() + Math.min(PREFETCH_RETRY_MAX_MS, PREFETCH_RETRY_MS * 2 ** (failures - 1))
      o.log?.warn('the speech model download failed; it is tried again later', { err: e instanceof Error ? e.message : String(e), failures })
      return 'failed'
    }
  }
  const first = setTimeout(() => { void tick() }, o.firstMs ?? PREFETCH_FIRST_MS)
  const every = setInterval(() => { void tick() }, o.checkMs ?? PREFETCH_CHECK_MS)
  first.unref?.()
  every.unref?.()
  return { stop() { stopped = true; clearTimeout(first); clearInterval(every) }, tick }
}
