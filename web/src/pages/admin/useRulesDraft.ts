// One folder's rules being changed, shared by Admin › Folder permissions' edit panel (AccessEdit.tsx) and the Files
// page's "Who can open it" panel (FolderSharing.tsx): the draft, the server's answer for it (POST
// /api/admin/access/edit-preview, server/src/admin/access-edit.ts: the permission function itself), the hash of the
// rules it started from, another admin's change seen in an answer, and the save (PUT /api/admin/folders/:id/rules, or
// POST /api/admin/folders for a folder without a rule row) with that hash, so a save over another admin's change is
// refused (409) instead of undoing it unseen. Mount it once per folder (`key={path}`): the draft, the hash and the
// answer belong to one folder, and an answer is kept by the path and the rules it was asked for.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, FolderEditPreview } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { basicChoices, draftKey, draftOf, rootNoneRow, rulesKey, rulesOf, sameRules, type Draft, type RuleLike } from '../../lib/access-edit'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'

/** How long the panel waits after a change before it asks the server (a choice clicked quickly asks once). */
export const PREVIEW_DEBOUNCE_MS = 250

type Answer = { key: string; attempt: number; data: FolderEditPreview }

/** The server's answer for the draft on screen: asked after PREVIEW_DEBOUNCE_MS (at once the first time), the request
 * before aborted, so an older answer never replaces a newer one. `key` names the folder and the rules: an answer for
 * another folder or other rules is never ready. `attempt` asks again (a retry, a 409): until that answer comes, the one
 * before does not count as ready. `put` keeps an answer asked outside the timer (Save's fresh ask). */
export function useEditPreview(path: string, rules: unknown, key: string, attempt: number) {
  const t = useT()
  const locale = useLocale()
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [error, setError] = useState<{ key: string; attempt: number; text: string } | null>(null)
  const first = useRef(true)
  useEffect(() => {
    const ctl = new AbortController()
    const delay = first.current ? 0 : PREVIEW_DEBOUNCE_MS
    first.current = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await api.call(API.previewFolderEdit, { body: { path, rules: rules as never }, signal: ctl.signal })
          if (ctl.signal.aborted) return
          setAnswer({ key, attempt, data })
          setError(null)
        } catch (e) {
          if (ctl.signal.aborted) return
          setError({ key, attempt, text: errorText(e, locale, t('error.network')) })
        }
      })()
    }, delay)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
    // the key stands for the folder and the rules
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, attempt])
  return {
    answer,
    error: error?.key === key && error.attempt === attempt ? error.text : null,
    ready: answer?.key === key && answer.attempt === attempt,
    put: (data: FolderEditPreview) => setAnswer({ key, attempt, data }),
  }
}

export interface RulesDraftOptions {
  path: string
  /** the folder's rule row (rules, rulesHash, keep), or null when it has none yet */
  folder: Folder | null
  /** the order the people and groups named are shown in */
  sort: (d: Draft) => Draft
  /** another admin changed the rules: the caller reads its rule rows again */
  onStale: () => void
}

export function useRulesDraft({ path, folder, sort, onStale }: RulesDraftOptions) {
  const t = useT()
  const locale = useLocale()
  const root = path === ''
  /** the rules the draft started from and their hash (null: not known yet, a folder without a row) */
  const [base, setBase] = useState<{ rules: RuleLike[]; hash: string | null }>(() => ({ rules: folder?.rules ?? [], hash: folder?.rulesHash ?? null }))
  const [initial, setInitial] = useState(() => sort(draftOf(base.rules, root).draft))
  /** a folder without rules gets them "set", one with rules "changed" */
  const [hadRules] = useState(() => (folder?.rules.length ?? 0) > 0)
  const [draft, setDraft] = useState<Draft>(initial)
  /** another admin changed the rules while this was open: 'kept' the draft, or 'loaded' theirs (nothing was changed here) */
  const [stale, setStale] = useState<'kept' | 'loaded' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const converted = draftOf(base.rules, root).converted
  const rules = useMemo(() => rulesOf(draft, { root, rootNoneRow: rootNoneRow(base.rules) }), [draft, root, base.rules])
  // the answer is kept by the folder and the rules it was asked for
  const key = `${path}\u0003${rulesKey(rules)}`
  const preview = useEditPreview(path, rules, key, attempt)
  const data = preview.answer?.data ?? null
  const edited = draftKey(draft) !== draftKey(initial)
  const saveable = !sameRules(rules, base.rules)
  // shared/ and skills/ keep at least one rule (stage 1): said here, before the server refuses it
  const keepsOne = folder?.keep === 'team' && rules.length === 0
  const connected = !!data?.connected
  const choices = basicChoices({ root, connected, current: initial.basic })
  // a connected folder is known from the first answer: "everyone reads and writes" picked before it came goes back to
  // what was saved (its choice is not offered there), unless it was saved that way
  useEffect(() => {
    if (connected && initial.basic !== 'write') setDraft((d) => (d.basic === 'write' ? { ...d, basic: initial.basic } : d))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  // the answer brings the rules as they are now: another admin's change shows here before Save does
  useEffect(() => {
    const p = preview.answer?.data
    if (!p) return
    if (base.hash === null && sameRules(p.current, base.rules)) {
      setBase({ rules: base.rules, hash: p.hash })
      return
    }
    if (p.hash === base.hash) return
    setBase({ rules: p.current, hash: p.hash })
    if (edited) setStale('kept')
    else {
      // nothing changed here: their rules are the draft now
      const next = sort(draftOf(p.current, root).draft)
      setInitial(next)
      setDraft(next)
      setStale('loaded')
    }
    onStale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.answer])

  /** their rules, in place of this draft (after "kept") */
  const loadTheirs = () => {
    const next = sort(draftOf(base.rules, root).draft)
    setInitial(next)
    setDraft(next)
    setStale('loaded')
  }

  const ready = preview.ready && !!data
  // why Save cannot save now: shared/ and skills/ need a rule, nothing to save, or the answer is not in
  const why = keepsOne ? 'keep' : !saveable ? 'same' : !ready ? (preview.error ? 'failed' : 'waits') : null

  /** Ask the server again now, for exactly this draft (no wait), and keep the answer: Save decides from it. Null when
   * the ask failed (the error shows as the preview's). `live`: false once the caller dropped this draft meanwhile (a
   * Discard): the answer and a failure are then not kept, so they never stand for the draft on screen. */
  const askNow = async (o: { live?: () => boolean } = {}): Promise<FolderEditPreview | null> => {
    const live = () => o.live?.() ?? true
    try {
      const fresh = await api.call(API.previewFolderEdit, { body: { path, rules } })
      if (live()) preview.put(fresh)
      return fresh
    } catch (e) {
      if (live()) setRefused(errorText(e, locale, t('error.network')))
      return null
    }
  }

  /** Save the draft with the hash it started from. Null when nothing was saved: another admin's change (asked again,
   * said, the draft kept), or a refusal (said in `refused`). */
  const save = async (): Promise<Folder | null> => {
    if (why || saving) return null
    setSaving(true)
    setRefused(null)
    try {
      const expectedHash = base.hash ?? data?.hash
      const saved = folder
        ? await api.call(API.putFolderRules, { params: { id: folder.id }, body: { rules, ...(expectedHash ? { expectedHash } : {}) } })
        : await api.call(API.createFolder, { body: { path, create: false, rules, ...(expectedHash ? { expectedHash } : {}) } })
      toast({ level: 'success', text: t('common.saved') })
      return saved
    } catch (e) {
      // another admin's rules came first (their change, or a rule row made meanwhile): asked again, said, draft kept
      const reason = isApiError(e, 'conflict') ? e.body.params?.reason : undefined
      if (reason === 'rules_changed' || reason === 'folder_exists') {
        setAttempt((n) => n + 1)
        onStale()
        return null
      }
      setRefused(errorText(e, locale, t('error.network')))
      return null
    } finally {
      setSaving(false)
    }
  }

  return {
    root, base, initial, hadRules, draft, setDraft, stale, loadTheirs, attempt, retry: () => setAttempt((n) => n + 1),
    saving, refused, converted, rules, preview, data, ready, edited, saveable, keepsOne, connected, choices, why, askNow, save,
  }
}
