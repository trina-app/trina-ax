// 팀 스킬 (docs/DECISIONS.md "팀 스킬 관리"): the skills I can use (everyone, read-only: components/AvailableSkills.tsx),
// suggestions to review for the folders I manage ([등록] writes the skill under skills/, [거절] turns it down), my own
// suggestions with their status, and for the owner and admins every recent change under skills/ with a link to its
// version history (where the previous version can be restored). Quiet on purpose: rows keep to a line or two, the
// details open on demand. /skills?run=<path> opens that skill's form (components/skills/SkillForm.tsx; the invite
// link and the welcome steps link here).
// Members contribute (docs/DECISIONS.md "MC"): 검토 groups the suggestions by person, so three members give three
// groups; a skill folder from a member's computer reads as such (its app, its files, a path on their computer, a team
// skill of the same name) and is registered as skills/<folder name>/ with its files. /skills?batch=<id> (the Inbox
// line of a batch) opens 검토 at that person.
import clsx from 'clsx'
import { Bot, History, Lightbulb, Search } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { skillLabel, type SkillChange, type SkillSuggestion, type SkillsOverview } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { navigateTo } from '../lib/nav'
import { useLocale, useT } from '../i18n'
import { skillsChanged } from '../store/live'
import { isAdmin, useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { AvailableSkills } from '../components/AvailableSkills'
import { Markdown } from '../components/Markdown'
import { SkillIssues } from '../components/SkillIssues'
import { SkillListNote } from '../components/SkillListNote'
import { SkillFormDialog } from '../components/skills/SkillForm'
import { Badge, Button, EmptyState, ErrorNote, Field, Modal, Skeleton, StickyHeader, TabPanel, Tabs, inputCls, pageColumn, promptDialog } from '../components/ui'

type Tab = 'skills' | 'review' | 'mine' | 'changes'

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
  const [tab, setTab] = useState<Tab>(params.get('mine') ? 'mine' : params.get('review') || params.get('batch') ? 'review' : 'skills')
  // ?batch=<id>: the person whose batch the Inbox line named, once the review list is in
  const [batch, setBatch] = useState<string | null>(params.get('batch'))
  const [query, setQuery] = useState('')
  const [review, setReview] = useState<SkillSuggestion[] | null>(null)
  const [mine, setMine] = useState<SkillSuggestion[] | null>(null)
  const [changes, setChanges] = useState<SkillChange[] | null>(null)
  const [open, setOpen] = useState<SkillSuggestion | null>(null)
  // ?run=<path>: that skill's form, on top of the page; closing it takes the parameter out of the address
  const run = params.get('run')
  const closeRun = () => {
    const next = new URLSearchParams(params)
    next.delete('run')
    setParams(next, { replace: true })
  }

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
  // a link to "my suggestions" chose the tab (its ?mine= is gone from the address by then)
  const linkedMine = useRef(!!params.get('mine'))
  // first visit: managers land on what waits for them
  useEffect(() => {
    if (overview && !linkedMine.current && overview.pendingReview > 0) setTab('review')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview === null])
  // a banner's link while already on this page; ?mine= goes once applied, like ?review=, so the same link works again
  useEffect(() => {
    if (params.get('mine')) {
      linkedMine.current = true
      setTab('mine')
      const next = new URLSearchParams(params)
      next.delete('mine')
      setParams(next, { replace: true })
    } else if (params.get('review')) setTab('review')
    else if (params.get('batch')) {
      setTab('review')
      setBatch(params.get('batch'))
      const next = new URLSearchParams(params)
      next.delete('batch')
      setParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  // a banner's link: /skills?review=<id> opens that suggestion
  useEffect(() => {
    const id = params.get('review')
    if (!id || !review) return
    const s = review.find((x) => x.id === id)
    if (s) setOpen(s)
    else api.call(API.getSkillSuggestion, { params: { id } }).then((x) => x.canReview && setOpen(x), () => {})
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, params])

  const tabs: { id: Tab; label: string }[] = [
    // what everyone can use, members included (before: a member's page listed no skill at all)
    { id: 'skills', label: t('skills.tabSkills') },
    ...(manages ? [{ id: 'review' as const, label: `${t('skills.tabReview')}${overview!.pendingReview ? ` (${overview!.pendingReview})` : ''}` }] : []),
    { id: 'mine', label: t('skills.tabMine') },
    ...(isAdmin(me) ? [{ id: 'changes' as const, label: t('skills.tabChanges') }] : []),
  ]
  const current = tabs.some((x) => x.id === tab) ? tab : 'skills'
  const panels = useId()

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className={clsx(pageColumn, 'p-4 sm:p-6')}>
        <StickyHeader className="-mt-3 mb-2 flex flex-wrap items-center gap-x-4 gap-y-3 py-3" testId="skills-header">
          <h1 className="text-xl font-semibold tracking-tight">{t('skills.title')}</h1>
          {overview && <Tabs segmented value={current} onChange={setTab} items={tabs} label={t('skills.title')} panels={panels} />}
          {overview && current === 'skills' && (
            <div className="relative w-full sm:ml-auto sm:w-56">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('skills.search')} aria-label={t('skills.search')} className={`${inputCls} pl-9`} data-testid="skill-search" />
            </div>
          )}
        </StickyHeader>
        <SkillIssues key={`issues-${me.user.id}`} className="mb-5" />
        <SkillListNote list={overview?.aiList} className="mb-5" />
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!overview && !error && <Skeleton lines={5} />}
        {overview && (
          <TabPanel base={panels} value={current}>
            {current === 'skills' && <AvailableSkills key={`skills-${me.user.id}`} query={query} />}
            {current === 'review' && (
              <>
                {/* phones: each row already says the folder it goes into */}
                <p className="mb-3 text-xs text-muted max-md:hidden">{t('skills.managedHint', { folders: overview.managedFolders.map((f) => f + '/').join(', ') })}</p>
                <SuggestionList items={review} empty={t('skills.noReview')} onOpen={setOpen} testId="review-list" grouped focusBatch={batch} />
              </>
            )}
            {current === 'mine' && <SuggestionList items={mine} empty={t('skills.noMine')} testId="mine-list" />}
            {current === 'changes' && <ChangeList items={changes} />}
          </TabPanel>
        )}
      </div>
      {run && <SkillFormDialog key={run} path={run} onClose={closeRun} />}
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

/** A skill folder's app by its own name. */
const appName = (app: 'claude' | 'codex') => (app === 'codex' ? 'Codex' : 'Claude')
/** The name a person reads: a skill folder's title (else its folder name as words); another suggestion's name. */
const suggestionTitle = (s: SkillSuggestion) => (s.source.kind === 'folder' ? skillLabel({ name: s.name, title: s.folder?.title }) : s.name)

/** The suggestions in groups by who sent them, in the order the list has them (waiting first). */
export function byPerson(items: readonly SkillSuggestion[]): { id: string; name: string; items: SkillSuggestion[] }[] {
  const groups = new Map<string, { id: string; name: string; items: SkillSuggestion[] }>()
  for (const s of items) {
    const g = groups.get(s.suggester.id) ?? { id: s.suggester.id, name: s.suggester.name, items: [] }
    g.items.push(s)
    groups.set(s.suggester.id, g)
  }
  return [...groups.values()]
}

function SuggestionList({ items, empty, onOpen, testId, grouped, focusBatch }: { items: SkillSuggestion[] | null; empty: string; onOpen?: (s: SkillSuggestion) => void; testId: string; grouped?: boolean; focusBatch?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const list = useRef<HTMLDivElement>(null)
  // the Inbox line of a batch: its person's group comes into view
  const focusPerson = focusBatch ? items?.find((s) => s.batchId === focusBatch)?.suggester.id ?? null : null
  useEffect(() => {
    if (!focusPerson) return
    const el = [...(list.current?.querySelectorAll<HTMLElement>('[data-person]') ?? [])].find((x) => x.getAttribute('data-person') === focusPerson)
    el?.scrollIntoView?.({ block: 'start' })
  }, [focusPerson])
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<Lightbulb size={22} />} title={empty} />
  const meta = (s: SkillSuggestion) => [
    s.folder ? t('skills.folderMeta', { app: appName(s.folder.app), n: s.folder.files.length }) : t('skills.into', { folder: s.targetFolder + '/' }),
    // grouped: the group's heading names the person
    grouped ? formatDateTime(s.createdAt, locale) : t('skills.by', { name: s.suggester.name, time: formatDateTime(s.createdAt, locale) }),
    ...(s.reviewer ? [t('skills.reviewedBy', { name: s.reviewer.name })] : []),
  ].join(' · ')
  const rows = (group: SkillSuggestion[]) => (
    <ul className="divide-y divide-line" data-testid={grouped ? undefined : testId}>
      {group.map((s) => (
        <li key={s.id} className="flex flex-wrap items-start gap-3 py-3 text-sm" data-testid="suggestion" data-status={s.status} data-kind={s.source.kind}>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{suggestionTitle(s)}</span>
              {s.folder && <span className="font-mono text-xs text-faint">/{s.name}</span>}
              {/* in the review tab ("검토 대기") a waiting row needs no badge saying so; decided ones keep theirs */}
              {!(onOpen && s.status === 'pending') && <StatusBadge s={s} />}
            </span>
            {s.description && <span className="mt-0.5 block truncate text-xs text-muted" title={s.description}>{s.description}</span>}
            <span className="block truncate text-xs text-faint" title={meta(s)}>{meta(s)}</span>
            {s.status === 'pending' && s.folder?.sameName && <span className="block text-xs text-warn" data-testid="suggestion-same-name">{t('skills.folderSameName', { title: s.folder.sameName.title })}</span>}
            {s.status === 'pending' && s.folder?.personalPath && <span className="block text-xs text-warn">{t('skills.folderPersonalPath')}</span>}
            {s.reviewNote && <span className="block text-xs text-muted" data-testid="review-note">{t('skills.reviewNote', { note: s.reviewNote })}</span>}
            {s.resultPath && (
              <button type="button" className="block text-xs text-accent-text hover:underline" onClick={() => navigateTo(`/files?path=${encodeURIComponent(s.resultPath!.slice(0, s.resultPath!.lastIndexOf('/')))}&select=${encodeURIComponent(s.resultPath!)}`)}>
                {t('skills.resultAt', { path: s.resultPath })}
              </button>
            )}
          </span>
          {onOpen && s.status === 'pending' && s.canReview && (
            // one per waiting row: quiet, so a list of several is not a column of primaries (the dialog has the primary)
            <Button size="sm" onClick={() => onOpen(s)} data-testid="review-open">
              {t('skills.review')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
  if (!grouped) return rows(items)
  return (
    <div ref={list} className="space-y-5" data-testid={testId}>
      {byPerson(items).map((g) => (
        <section key={g.id} data-testid="review-group" data-person={g.id} className="scroll-mt-20">
          <h3 className={clsx('border-b border-line pb-1.5 text-xs font-semibold text-muted', g.id === focusPerson && 'text-ink')}>
            {t('skills.groupBy', { name: g.name, n: g.items.length })}
          </h3>
          {rows(g.items)}
        </section>
      ))}
    </div>
  )
}

function ChangeList({ items }: { items: SkillChange[] | null }) {
  const t = useT()
  const locale = useLocale()
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<History size={22} />} title={t('skills.noChanges')} />
  return (
    <ul className="divide-y divide-line" data-testid="change-list">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-testid="skill-change">
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

/** A skill folder's name as the server takes it (skills/<name>/SKILL.md): lowercase letters, digits and hyphens. */
export const FOLDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function ReviewDialog({ s, folders, onClose, onDone }: { s: SkillSuggestion; folders: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const isDir = s.source.kind === 'folder'
  // a skill folder: the files that go with it, with their text (GET …/:id gives it to its reviewer), so the owner reads
  // everything the team's AI would read, not only SKILL.md
  const [full, setFull] = useState<SkillSuggestion['folder'] | null>(null)
  useEffect(() => {
    if (!isDir) return
    let live = true
    api.call(API.getSkillSuggestion, { params: { id: s.id } }).then((x) => live && setFull(x.folder ?? null), () => {})
    return () => { live = false }
  }, [isDir, s.id])
  const dir = isDir ? full ?? s.folder ?? null : null
  // a skill folder goes into a folder of skills, never into another skill's folder (the server refuses that too)
  const [skillDirs, setSkillDirs] = useState<string[] | null>(null)
  useEffect(() => {
    if (!isDir) return
    let live = true
    api.call(API.listSkills).then((r) => live && setSkillDirs(r.items.filter((x) => /\/SKILL\.md$/i.test(x.path)).map((x) => x.path.slice(0, x.path.lastIndexOf('/')))), () => live && setSkillDirs([]))
    return () => { live = false }
  }, [isDir])
  const places = isDir ? folders.filter((f) => !(skillDirs ?? []).some((d) => f === d || f.startsWith(d + '/'))) : folders
  const [folder, setFolder] = useState(folders.includes(s.targetFolder) ? s.targetFolder : (folders[0] ?? s.targetFolder))
  const [name, setName] = useState(s.name)
  const [description, setDescription] = useState(s.description)
  const [fileName, setFileName] = useState('')
  const [content, setContent] = useState(s.content)
  const [preview, setPreview] = useState(true)
  const contentTabs = useId()
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameBad = isDir ? !!name.trim() && !(FOLDER_NAME.test(name.trim()) && name.trim().length <= 64) : name.includes('/')
  const ready = !!name.trim() && !nameBad && !!content.trim()
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
        const r = await api.call(API.approveSkillSuggestion, { params: { id: s.id }, body: { targetFolder: folder, name: name.trim(), description: description.trim(), content, ...(!isDir && fileName.trim() ? { fileName: fileName.trim() } : {}) } })
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
          <Button variant="ghost" className="mr-auto" busy={busy === 'reject'} disabled={!!busy} onClick={() => run('reject')} data-testid="review-reject">
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
          {dir ? t('skills.folderMeta', { app: appName(dir.app), n: dir.files.length }) : s.source.kind === 'file' && s.source.path ? t('skills.source.file', { path: s.source.path }) : t('skills.source.message')}
        </p>
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {t('skills.registerWarn')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('suggest.folder')}>
            <select className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="review-folder">
              {(places.length ? places : [s.targetFolder]).map((f) => (
                <option key={f} value={f}>
                  {f}/
                </option>
              ))}
            </select>
          </Field>
          {isDir ? (
            // a skill folder: its folder name is its name (/name runs it); the title stays as the member wrote it
            <Field label={t('skills.folderName')} hint={`${folder}/${name.trim() || '…'}/SKILL.md`} error={nameBad ? t('skills.folderNameRule') : null}>
              <input className={`${inputCls} font-mono`} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} spellCheck={false} autoCapitalize="off" data-testid="review-name" />
            </Field>
          ) : (
            <Field label={t('skills.fileName')} hint={`${folder}/${fileName.trim() || name.trim().replace(/\s+/g, '-') || '…'}.md`}>
              <input className={inputCls} value={fileName} onChange={(e) => setFileName(e.target.value)} maxLength={80} placeholder={name.trim().replace(/\s+/g, '-')} data-testid="review-file-name" />
            </Field>
          )}
        </div>
        {dir?.sameName && name.trim() === s.name && <p className="text-xs text-warn" role="note">{t('skills.folderSameName', { title: dir.sameName.title })}</p>}
        {dir?.personalPath && <p className="text-xs text-warn" role="note">{t('skills.folderPersonalPath')}</p>}
        {!isDir && (
          <Field label={t('suggest.name')} error={name.includes('/') ? t('suggest.nameSlash') : null}>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="review-name" />
          </Field>
        )}
        <Field label={t('suggest.description')}>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={isDir ? 1024 : 300} data-testid="review-description" />
        </Field>
        {dir && dir.files.some((f) => f.path !== 'SKILL.md') && (
          <div className="space-y-1" data-testid="review-files">
            <p className="text-label font-medium text-ink">{t('skills.folderFiles')}</p>
            <ul className="space-y-1 text-xs text-muted">
              {dir.files.filter((f) => f.path !== 'SKILL.md').map((f) => (
                <li key={f.path} data-testid="review-file">
                  {f.text === undefined ? (
                    <span className="font-mono break-all">{f.path} <span className="font-sans text-faint">· {formatSize(f.bytes, locale)}</span></span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer font-mono break-all hover:text-ink">{f.path} <span className="font-sans text-faint">· {formatSize(f.bytes, locale)}</span></summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-ink" data-testid="review-file-text">{f.text}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {dir && dir.scriptsDropped > 0 && <p className="text-xs text-muted">{t('skills.folderScripts', { n: dir.scriptsDropped })}</p>}
        <div>
          <Tabs value={preview ? 'preview' : 'edit'} onChange={(v) => setPreview(v === 'preview')} items={[{ id: 'preview', label: t('skills.preview') }, { id: 'edit', label: t('skills.edit') }]} label={t('suggest.content')} panels={contentTabs} />
          <TabPanel base={contentTabs} value={preview ? 'preview' : 'edit'}>
            {preview ? (
              <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line px-3 py-2 text-sm" data-testid="review-preview">
                <Markdown text={content} />
              </div>
            ) : (
              <textarea className={`${inputCls} mt-2 h-auto min-h-60 resize-y py-2 font-mono text-label`} value={content} onChange={(e) => setContent(e.target.value)} maxLength={isDir ? 128 * 1024 : 16000} aria-label={t('suggest.content')} data-testid="review-content" />
            )}
          </TabPanel>
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
