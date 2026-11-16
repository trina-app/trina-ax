// Find work files' share step (docs/decisions/20261116-find-files-share-step.md): which of the files just
// added get the small "Good to share" hint, and the share itself, one file at a time through the file Share dialog's own
// call (PUT /api/files/shares: the same owner rule, team switch, 50 people and groups and refusals). Nothing new on the
// server: the step is a list of Share dialogs pressed at once.
import { ApiError, nameReason, type ProjectParticipant, type TeamFileReason } from '@mycel/shared/api'

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
  failed: { path: string; error: unknown }[]
}

/**
 * Share each path with the same people and groups, one call each. A 429 (the server's sending budget: 20 at once, then
 * one a second) waits what the server says and tries that file again, three times at most; any other refusal is that
 * file's (the server's words). `live()` false: stop (the dialog closed); what went stays shared.
 */
export async function shareEach(paths: readonly string[], subjects: readonly ProjectParticipant[], o: {
  put: (path: string, add: ProjectParticipant[]) => Promise<unknown>
  wait?: (ms: number) => Promise<void>
  live?: () => boolean
  onStep?: (done: number) => void
}): Promise<ShareOutcome> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)))
  const live = o.live ?? (() => true)
  const out: ShareOutcome = { shared: [], failed: [] }
  for (const path of paths) {
    if (!live()) break
    for (let tries = 0; ; tries++) {
      try {
        await o.put(path, [...subjects])
        out.shared.push(path)
        break
      } catch (e) {
        const after = e instanceof ApiError && e.status === 429 ? Math.min(30, Math.max(1, Number(e.body.retryAfter ?? 1))) : null
        if (after !== null && tries < 3 && live()) { await wait(after * 1000); continue }
        out.failed.push({ path, error: e })
        break
      }
    }
    o.onStep?.(out.shared.length + out.failed.length)
  }
  return out
}
