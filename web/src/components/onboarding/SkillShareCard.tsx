// "이 방식대로 팀 스킬로 만들까요?" → this card (docs/DECISIONS.md "S — The lead's way becomes a team skill"). The
// server drafts a team skill from the lead's answer in a draft chat of theirs (POST /api/onboarding/skill-draft, a turn
// without tools; server/src/onboarding/skill-draft.ts) and the card shows only six things: the title (tap to change
// it), one line, what teammates are asked ("팀원에게 물어볼 것: 고객사 · 품목", read only; a choice as its chips), the
// team files it uses, [팀에 공유] and "나중에", with one quiet line under them. No steps, no Markdown or YAML, no folder
// name, no folder picker. [팀에 공유] is the owner's or admin's own save of the skill file; the invite comes next (the
// caller shows it). On a phone the dialog is a bottom sheet (Modal). Its entry is the one suggestion under an owner's
// or admin's answer that used team files and ran no team skill, "이 방식대로 팀 스킬로 만들까요?" [팀 스킬로 만들기]
// (ResultSuggestion, docs/DECISIONS.md "W3"; the bar under the welcome steps' first result shares the pack's skill
// itself since "W2").
import { Loader2, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NOTES_FOLDER, SKILL_DRAFT_TITLE_MAX, isChoice, type SavedSkillDraft, type SkillDraft, type SkillDraftFile, type SkillDraftState } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, inputCls } from '../ui'

/** How often the card asks for the draft while it is written. */
export const SKILL_DRAFT_POLL_MS = 2000

/** a draft started for this answer in this page load: the card opened again reads the same one */
const started = new Map<string, string>()
/** test hook */
export const forgetSkillDrafts = () => started.clear()

const notesNames = new Set((Object.values(NOTES_FOLDER) as string[]).map((n) => n.normalize('NFC')))

/** "견적서_양식.xlsx", or for a folder "Acme 회의록 폴더의 가장 최근 회의록" (a team folder named with its team, joined as
 * each language reads it: "Acme Marketing › Meeting notes"; the kind is the words of the file's name when it had any
 * besides its date: "가장 최근 월간보고"; in the notes folder, the language's own words for meeting notes). */
export function fileLabel(f: SkillDraftFile, t: ReturnType<typeof useT>): string {
  const parts = f.path.split('/')
  const name = parts.at(-1) ?? f.path
  const folder = parts[0] === 'groups' && parts.length >= 3 ? t('skillShare.teamFolder', { team: parts[1]!, name }) : name
  // a folder of pictures, all of it (the brand images folder: docs/DECISIONS.md "N")
  if (!f.latest) return /\.[a-z0-9]{1,6}$/i.test(name) ? name : t('skillShare.folder', { folder })
  if (!f.like && notesNames.has(name.normalize('NFC'))) return t('skillShare.latestNotes', { folder })
  return t('skillShare.latest', { folder, kind: f.like || t('skillShare.latestFile') })
}

/** `answerId`: the answer the card was opened under (a chat has several; the server drafts from the chat's newest one),
 * so a later answer of the same chat starts its own draft instead of showing the earlier one's. */
export function SkillShareCard({ chatId, answerId, onShared, onLater }: { chatId: string; answerId?: string; onShared: (saved: SavedSkillDraft) => void; onLater: () => void }) {
  const cacheKey = answerId ? `${chatId}:${answerId}` : chatId
  const t = useT()
  const locale = useLocale()
  const [draftChat, setDraftChat] = useState<string | null>(started.get(cacheKey) ?? null)
  const [state, setState] = useState<SkillDraftState | null>(null)
  // the start refused (a confidential chat, outside content, files the team cannot open: the server says which), or
  // failed; `again`: trying again may help (a network failure, not a refusal)
  const [failed, setFailed] = useState<{ text: string; again: boolean } | null>(null)
  const [title, setTitle] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)

  // the draft: started once per answer, then read until it is no longer being written
  useEffect(() => {
    if (draftChat) return
    let live = true
    api.call(API.startSkillDraft, { body: { chatId } }).then(
      (r) => { started.set(cacheKey, r.draftChatId); if (live) setDraftChat(r.draftChatId) },
      (e) => live && setFailed({ text: errorText(e, locale, t('skillShare.failed')), again: !isApiError(e, 'conflict') }),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, draftChat])
  useEffect(() => {
    if (!draftChat) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = () => api.call(API.getSkillDraft, { params: { chatId: draftChat } }).then(
      (s) => {
        if (!live) return
        setState(s)
        if (s.draft) setTitle((cur) => cur || s.draft!.title)
        // the first answer did not pass: starting again asks for its one rewrite (reading never queues anything)
        if (s.rewrite) void api.call(API.startSkillDraft, { body: { chatId } }).catch(() => {})
        if (s.status === 'running') timer = setTimeout(() => void read(), SKILL_DRAFT_POLL_MS)
      },
      () => { if (live) timer = setTimeout(() => void read(), SKILL_DRAFT_POLL_MS * 2) },
    )
    void read()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [draftChat])
  useEffect(() => {
    if (!editing) return
    const el = titleInput.current
    el?.focus()
    if (typeof el?.select === 'function') el.select()
  }, [editing])

  // shared before (the card opened again after a reload of the draft): straight on
  useEffect(() => { if (state?.saved) onShared(state.saved) }, [state?.saved?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const share = async (d: SkillDraft) => {
    setSaving(true)
    setSaveError(null)
    try {
      onShared(await api.call(API.saveSkillDraft, { params: { chatId: draftChat! }, body: { title: title.trim() || d.title } }))
    } catch (e) {
      setSaveError(errorText(e, locale, t('error.network')))
      setSaving(false)
    }
  }

  /** 다시 정리하기: a new draft (the server never reuses a failed one) */
  const retry = () => {
    started.delete(cacheKey)
    setFailed(null)
    setState(null)
    setTitle('')
    setDraftChat(null)
  }
  if (failed || state?.status === 'failed') {
    const again = failed ? failed.again : true
    return (
      <div className="space-y-4" data-testid="skill-share" data-state="failed">
        <p className="text-sm text-ink" data-testid="skill-share-failed">{failed?.text ?? t('skillShare.failed')}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onLater} className="max-sm:order-2 max-sm:w-full" data-testid="skill-share-later">{t('skillShare.later')}</Button>
          {again && <Button variant="primary" onClick={retry} className="max-sm:w-full" data-testid="skill-share-retry">{t('skillShare.retry')}</Button>}
        </div>
      </div>
    )
  }
  const d = state?.status === 'done' ? state.draft : null
  if (!d)
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status" data-testid="skill-share" data-state="drafting">
        <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden /> {t('skillShare.drafting')}
      </p>
    )
  const asks = d.inputs.filter((i) => !isChoice(i)).map((i) => i.label)
  const choices = d.inputs.filter(isChoice)
  const done = () => { setTitle((v) => v.trim() || d.title); setEditing(false) }
  return (
    <div className="space-y-4" data-testid="skill-share" data-state="ready">
      <div className="space-y-1">
        {editing ? (
          <input
            ref={titleInput}
            value={title}
            maxLength={SKILL_DRAFT_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={done}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done() } }}
            aria-label={t('skillShare.editTitle')}
            className={`${inputCls} text-lg font-semibold`}
            data-testid="skill-share-title-input"
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="group -ml-1 flex max-w-full items-center gap-2 rounded px-1 text-left text-lg font-semibold text-ink hover:bg-hover" aria-label={t('skillShare.editTitleOf', { title })} data-testid="skill-share-title">
            <span className="min-w-0 break-words">{title}</span>
            <Pencil size={14} className="shrink-0 text-faint group-hover:text-ink" aria-hidden />
          </button>
        )}
        {d.description && <p className="text-sm text-muted" data-testid="skill-share-description">{d.description}</p>}
      </div>
      <dl className="space-y-2 text-sm">
        {asks.length > 0 && (
          <div className="flex flex-wrap gap-x-1.5" data-testid="skill-share-asks">
            <dt className="text-muted">{t('skillShare.asks')}</dt>
            <dd className="text-ink">{asks.join(' · ')}</dd>
          </div>
        )}
        {choices.map((c) => (
          <div key={c.name} className="flex flex-wrap gap-1.5" data-testid="skill-share-choice">
            <dt className="sr-only">{c.label}</dt>
            {c.options.map((o) => (
              <dd key={o.value} className={o.value === (c.default ?? c.options[0]!.value) ? 'rounded-full bg-accent-soft px-2.5 py-0.5 text-[13px] font-medium text-accent-text' : 'rounded-full border border-line px-2.5 py-0.5 text-[13px] text-muted'}>
                {o.label}
              </dd>
            ))}
          </div>
        ))}
        {d.files.length > 0 && (
          <div className="flex flex-wrap gap-x-1.5" data-testid="skill-share-files">
            <dt className="text-muted">{t('skillShare.files')}</dt>
            <dd className="min-w-0 break-words text-ink">{d.files.map((f) => fileLabel(f, t)).join(', ')}</dd>
          </div>
        )}
      </dl>
      {saveError && <ErrorNote>{saveError}</ErrorNote>}
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onLater} disabled={saving} className="max-sm:order-2 max-sm:w-full" data-testid="skill-share-later">{t('skillShare.later')}</Button>
          <Button variant="primary" busy={saving} onClick={() => void share(d)} className="max-sm:w-full" data-testid="skill-share-share">{t('skillShare.share')}</Button>
        </div>
        <p className="text-center text-xs text-faint sm:text-right" data-testid="skill-share-note">{t('skillShare.note')}</p>
      </div>
    </div>
  )
}

export default SkillShareCard
