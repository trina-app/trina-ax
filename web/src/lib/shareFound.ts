// Find work files' share step (docs/decisions/20261116-find-files-share-step.md): which of the files just
// added get the small "Good to share" hint, and the share itself: one press for all the ticked files (the batch call:
// each file under the Share dialog's rules, one notice per person).
import { ApiError, nameReason, type ProjectParticipant, type ShareFilesBatchResult, type TeamFileReason } from '@mycel/shared/api'

/** The kinds of document teams usually keep together (a form, the company's intro, brand material, a policy, a guide,
 * minutes). A report or a proposal is often one person's or one client's: no hint for those. */
export const SHARE_HINT_KINDS: ReadonlySet<TeamFileReason> = new Set<TeamFileReason>(['form', 'intro', 'brand', 'policy', 'training', 'minutes'])

/** The kind a file's hint names, or null (no hint): the AI's own reason from the list before (by the path it was added
 * at), else what its name says. */
export function shareHint(path: string, reasons: ReadonlyMap<string, TeamFileReason>): TeamFileReason | null {
  const r = reasons.get(path) ?? nameReason(path.slice(path.lastIndexOf('/') + 1))
  return r && SHARE_HINT_KINDS.has(r) ? r : null
}

/** The hinted files first, else as added (a stable order). */
export function hintedFirst(paths: readonly string[], reasons: ReadonlyMap<string, TeamFileReason>): string[] {
  return paths.map((p, i) => ({ p, i, h: shareHint(p, reasons) ? 0 : 1 })).sort((a, b) => a.h - b.h || a.i - b.i).map((x) => x.p)
}

export interface ShareOutcome {
  shared: string[]
  /** the files not shared, each with the server's words */
  failed: { path: string; message: string }[]
}

/**
 * Share the paths with the same people and groups in one press (POST /api/files/shares/batch: each file under the Share
 * dialog's rules, one notice per person; docs/decisions/20261116-file-share-everyone.md). A 429 (the server's sending
 * budget) waits what the server says and tries again, three times at most. A press the server refused as a whole (no
 * network, a person who cannot be added): every file failed with those words (`words`).
 */
export async function shareBatch(paths: readonly string[], subjects: readonly ProjectParticipant[], o: {
  post: (paths: string[], add: ProjectParticipant[]) => Promise<ShareFilesBatchResult>
  words: (e: unknown) => string
  wait?: (ms: number) => Promise<void>
  live?: () => boolean
}): Promise<ShareOutcome> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)))
  const live = o.live ?? (() => true)
  for (let tries = 0; ; tries++) {
    try {
      const r = await o.post([...paths], [...subjects])
      return { shared: r.shared, failed: r.failed.map((f) => ({ path: f.path, message: f.message })) }
    } catch (e) {
      const after = e instanceof ApiError && e.status === 429 ? Math.min(30, Math.max(1, Number(e.body.retryAfter ?? 1))) : null
      if (after !== null && tries < 3 && live()) { await wait(after * 1000); continue }
      return { shared: [], failed: paths.map((path) => ({ path, message: o.words(e) })) }
    }
  }
}
