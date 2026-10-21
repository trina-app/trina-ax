// 팀 스킬 (docs/DECISIONS.md "팀 스킬 관리"): suggestions to review for the folders I manage ([등록] writes the skill under
// skills/, [거절] turns it down), my own suggestions with their status, and for the owner and admins every recent change
// under skills/ with a link to its version history (where the previous version can be restored).
import { Bot, History, Lightbulb } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SkillChange, SkillSuggestion, SkillsOverview } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { navigateTo } from '../lib/nav'
import { useLocale, useT } from '../i18n'
import { skillsChanged } from '../store/live'
import { isAdmin, useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { Markdown } from '../components/Markdown'
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, PageHeader, Skeleton, Tabs, inputCls, promptDialog } from '../components/ui'

type Tab = 'review' | 'mine' | 'changes'

const historyLink = (c: SkillChange) => {
  if (c.change === 'delete') return '/trash'
  const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''
  if (c.kind === 'folder') return `/files?path=${encodeURIComponent(c.path)}`
  return `/files?path=${encodeURIComponent(dir)}&select=${encodeURIComponent(c.path)}&history=${encodeURIComponent(c.path)}`
}

export default function Skills() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const [params, setParams] = useSearchParams()
  const [overview, setOverview] = useState<SkillsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manages = !!overview?.managedFolders.length
  const [tab, setTab] = useState<Tab>(params.get('mine') ? 'mine' : params.get('review') ? 'review' : 'mine')
  const [review, setReview] = useState<SkillSuggestion[] | null>(null)
  const [mine, setMine] = useState<SkillSuggestion[] | null>(null)
  const [changes, setChanges] = useState<SkillChange[] | null>(null)
  const [open, setOpen] = useState<SkillSuggestion | null>(null)

  const load = useCallback(async () => {
    try {
      const o = await api.call(API.skillsOverview)
      setOverview(o)
      setMine((await api.call(API.listSkillSuggestions, { query: { scope: 'mine', limit: 100 } })).items)
      if (o.managedFolders.length) setReview((await api.call(API.listSkillSuggestions, { query: { scope: 'review', limit: 100 } })).items)
      if (isAdmin(me)) setChanges((await api.call(API.listSkillChanges, { query: { limit: 100 } })).items)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me])
  useEffect(() => {
    void load()
    return skillsChanged.on(() => void load())
  }, [load])
  // first visit: managers land on what waits for them
  useEffect(() => {
    if (overview && !params.get('mine') && overview.pendingReview > 0) setTab('review')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview === null])
  // a banner's link: /skills?review=<id> opens that suggestion
  useEffect(() => {
    const id = params.get('review')
    if (!id || !review) return
    const s = review.find((x) => x.id === id)
    if (s) setOpen(s)
    else api.call(API.getSkillSuggestion, { params: { id } }).then((x) => x.canReview && setOpen(x), () => {})
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review])

  const tabs: { id: Tab; label: string }[] = [
    ...(manages ? [{ id: 'review' as const, label: `${t('skills.tabReview')}${overview!.pendingReview ? ` (${overview!.pendingReview})` : ''}` }] : []),
    { id: 'mine', label: t('skills.tabMine') },
    ...(isAdmin(me) ? [{ id: 'changes' as const, label: t('skills.tabChanges') }] : []),
  ]
  const current = tabs.some((x) => x.id === tab) ? tab : 'mine'

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('skills.title')} desc={t('skills.desc')} />
      <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!overview && !error && <Skeleton lines={5} />}
        {overview && (
          <>
            {manages && <p className="mb-3 text-xs text-muted">{t('skills.managedHint', { folders: overview.managedFolders.map((f) => f + '/').join(', ') })}</p>}
            <Tabs value={current} onChange={setTab} items={tabs} label={t('skills.title')} />
            <div className="mt-4">
              {current === 'review' && <SuggestionList items={review} empty={t('skills.noReview')} onOpen={setOpen} testId="review-list" />}
              {current === 'mine' && <SuggestionList items={mine} empty={t('skills.noMine')} testId="mine-list" />}
              {current === 'changes' && <ChangeList items={changes} />}
            </div>
          </>
        )}
      </div>
      {open && overview && (
        <ReviewDialog
          s={open}
          folders={overview.suggestFolders.filter((f) => overview.managedFolders.some((m) => f === m || f.startsWith(m + '/')))}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null)
            skillsChanged.emit()
          }}
        />
      )}
    </div>
  )
}

function StatusBadge({ s }: { s: SkillSuggestion }) {
  const t = useT()
  return <Badge tone={s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'danger' : 'warn'}>{t(`skills.status.${s.status}`)}</Badge>
}

function SuggestionList({ items, empty, onOpen, testId }: { items: SkillSuggestion[] | null; empty: string; onOpen?: (s: SkillSuggestion) => void; testId: string }) {
  const t = useT()
  const locale = useLocale()
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<Lightbulb size={22} />} title={empty} />
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" data-testid={testId}>
      {items.map((s) => (
        <li key={s.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm" data-testid="suggestion" data-status={s.status}>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <StatusBadge s={s} />
            </span>
            {s.description && <span className="block text-xs text-muted">{s.description}</span>}
            <span className="block text-xs text-faint">
              {t('skills.into', { folder: s.targetFolder + '/' })} · {t('skills.by', { name: s.suggester.name, time: formatDateTime(s.createdAt, locale) })} ·{' '}
              {s.source.kind === 'file' && s.source.path ? t('skills.source.file', { path: s.source.path }) : t('skills.source.message')}
            </span>
            {s.reviewer && <span className="block text-xs text-faint">{t('skills.reviewedBy', { name: s.reviewer.name })}</span>}
            {s.reviewNote && <span className="block text-xs text-muted" data-testid="review-note">{t('skills.reviewNote', { note: s.reviewNote })}</span>}
            {s.resultPath && (
              <button type="button" className="block text-xs text-accent-text hover:underline" onClick={() => navigateTo(`/files?path=${encodeURIComponent(s.resultPath!.slice(0, s.resultPath!.lastIndexOf('/')))}&select=${encodeURIComponent(s.resultPath!)}`)}>
                {t('skills.resultAt', { path: s.resultPath })}
              </button>
            )}
          </span>
          {onOpen && s.status === 'pending' && s.canReview && (
            <Button size="sm" variant="primary" onClick={() => onOpen(s)} data-testid="review-open">
              {t('skills.review')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

function ChangeList({ items }: { items: SkillChange[] | null }) {
  const t = useT()
  const locale = useLocale()
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<History size={22} />} title={t('skills.noChanges')} />
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" data-testid="change-list">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm" data-testid="skill-change">
          <Badge tone={c.change === 'delete' ? 'danger' : 'neutral'}>{t(`skills.change.${c.change}`)}</Badge>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs" title={c.path}>
              {c.path}
              {c.kind === 'skill' || c.kind === 'rule' ? <span className="ml-1 font-sans text-faint">({t(`skills.kind.${c.kind}`)})</span> : null}
            </span>
            <span className="block text-xs text-faint">
              {c.actor?.name ?? '—'} · {formatDateTime(c.at, locale)}
              {c.from ? ` · ${t('skills.change.from', { path: c.from })}` : ''}
            </span>
          </span>
          {c.byAi && (
            <Badge tone="accent">
              <Bot size={12} className="mr-0.5 inline" aria-hidden />
              {t('skills.change.ai')}
            </Badge>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigateTo(historyLink(c))}>
            <History size={13} aria-hidden /> {c.change === 'delete' ? t('sidebar.trash') : t('skills.change.history')}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function ReviewDialog({ s, folders, onClose, onDone }: { s: SkillSuggestion; folders: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [folder, setFolder] = useState(folders.includes(s.targetFolder) ? s.targetFolder : (folders[0] ?? s.targetFolder))
  const [name, setName] = useState(s.name)
  const [description, setDescription] = useState(s.description)
  const [fileName, setFileName] = useState('')
  const [content, setContent] = useState(s.content)
  const [preview, setPreview] = useState(true)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = !!name.trim() && !name.includes('/') && !!content.trim()
  const run = async (what: 'approve' | 'reject') => {
    let note: string | null = null
    if (what === 'reject') {
      note = await promptDialog({ title: t('skills.reject'), label: t('skills.rejectNote'), confirm: t('skills.reject') })
      if (note === null) return
    }
    setBusy(what)
    setError(null)
    try {
      if (what === 'approve') {
        const r = await api.call(API.approveSkillSuggestion, { params: { id: s.id }, body: { targetFolder: folder, name: name.trim(), description: description.trim(), content, ...(fileName.trim() ? { fileName: fileName.trim() } : {}) } })
        toast({ level: 'success', text: t('skills.registered', { path: r.resultPath ?? '' }) })
      } else {
        await api.call(API.rejectSkillSuggestion, { params: { id: s.id }, body: note ? { note } : {} })
        toast({ level: 'success', text: t('skills.rejectedToast') })
      }
      onDone()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(null)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={t('skills.reviewTitle')}
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-danger" busy={busy === 'reject'} disabled={!!busy} onClick={() => run('reject')} data-testid="review-reject">
            {t('skills.reject')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy === 'approve'} disabled={!ready || !!busy} onClick={() => run('approve')} data-testid="review-approve">
            {t('skills.register')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="review-dialog">
        <p className="text-xs text-faint">
          {t('skills.by', { name: s.suggester.name, time: formatDateTime(s.createdAt, locale) })} ·{' '}
          {s.source.kind === 'file' && s.source.path ? t('skills.source.file', { path: s.source.path }) : t('skills.source.message')}
        </p>
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {t('skills.registerWarn')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('suggest.folder')}>
            <select className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="review-folder">
              {(folders.length ? folders : [s.targetFolder]).map((f) => (
                <option key={f} value={f}>
                  {f}/
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('skills.fileName')} hint={`${folder}/${fileName.trim() || name.trim().replace(/\s+/g, '-') || '…'}.md`}>
            <input className={inputCls} value={fileName} onChange={(e) => setFileName(e.target.value)} maxLength={80} placeholder={name.trim().replace(/\s+/g, '-')} data-testid="review-file-name" />
          </Field>
        </div>
        <Field label={t('suggest.name')} error={name.includes('/') ? t('suggest.nameSlash') : null}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="review-name" />
        </Field>
        <Field label={t('suggest.description')}>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} data-testid="review-description" />
        </Field>
        <div>
          <Tabs value={preview ? 'preview' : 'edit'} onChange={(v) => setPreview(v === 'preview')} items={[{ id: 'preview', label: t('skills.preview') }, { id: 'edit', label: t('skills.edit') }]} label={t('suggest.content')} />
          {preview ? (
            <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line px-3 py-2 text-sm" data-testid="review-preview">
              <Markdown text={content} />
            </div>
          ) : (
            <textarea className={`${inputCls} mt-2 h-auto min-h-60 resize-y py-2 font-mono text-[13px]`} value={content} onChange={(e) => setContent(e.target.value)} maxLength={16000} data-testid="review-content" />
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
