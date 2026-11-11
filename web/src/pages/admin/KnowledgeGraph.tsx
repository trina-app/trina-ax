// Admin › Team settings › Knowledge graph (#knowledge-graph; server/src/knowledge-graph/, docs/KNOWLEDGE-GRAPH.md): what
// the AI uses to find things in the team's files (knowledge_explore). Two parts, each with its own switch: documents
// (the text of PDF, Word, HWP, Excel, slides and so on; built in, on by default) and the code map (CodeGraph, an optional
// tool on the server; off with the hint to install it when missing). Below them one list of the indexed folders: per
// folder its documents, code files, files that could not be read, last update and state; personal folders only as a
// total. Then the files that could not be read (a dialog with the reason for each), other folders with code to index,
// disk use, what is updating now, and Rebuild (documents, code or both). Saves through its own endpoints, at once, like
// the AI groups above. While a folder waits or runs, the list looks again every few seconds.
import clsx from 'clsx'
import { Loader2, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type KnowledgeGraphDocFolder, type KnowledgeGraphDocuments, type KnowledgeGraphRoot, type KnowledgeGraphStatus } from '@mycel/shared/api'
import { api, API, ApiError } from '../../lib/api'
import { formatRelative, formatSize } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, confirmDialog, IconButton, inputCls, Modal, PhoneTargets, Switch } from '../../components/ui'
import { Loadable, SettingRow, SettingsSection, useAction, useLoad } from './common'

const POLL_MS = 4000

type State = KnowledgeGraphRoot['status']

type DocFolder = KnowledgeGraphDocFolder
type DocsPart = KnowledgeGraphDocuments
type Status = KnowledgeGraphStatus
type Part = 'code' | 'documents'

/** a server from before documents answers without them: the page then shows the code part only */
const docsOf = (d: Status): DocsPart | null => d.documents ?? null
const waiting = (s: State) => s === 'pending' || s === 'indexing'

export default function KnowledgeGraphSettings() {
  const t = useT()
  const state = useLoad(() => api.call(API.knowledgeGraphStatus))
  const d = state.data
  const docs = d ? docsOf(d) : null
  const busy = !!d && (d.busy > 0 || d.roots.some((r) => waiting(r.status)) || (!!docs && (docs.busy > 0 || docs.folders.some((f) => waiting(f.status)))))
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => void api.call(API.knowledgeGraphStatus).then(state.setData, () => {}), POLL_MS)
    return () => clearInterval(id)
  }, [busy, state.setData])
  return (
    <SettingsSection id="knowledge-graph" title={t('kg.title')} desc={t('kg.desc')} testId="knowledge-graph">
      <Loadable state={state} lines={2}>
        {(data) => <Body d={data} onData={state.setData} />}
      </Loadable>
    </SettingsSection>
  )
}

function Body({ d, onData }: { d: Status; onData: (d: Status) => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const docs = docsOf(d)
  const [saving, setSaving] = useState<Part | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const toggle = async (part: Part, on: boolean) => {
    const k = part === 'documents' ? 'kg.docs' : 'kg'
    if (!on && !(await confirmDialog({ title: t(`${k}.offTitle` as MessageKey), body: t(`${k}.offBody` as MessageKey), confirm: t('kg.offConfirm'), danger: true }))) return
    setSaving(part)
    const body = part === 'documents' ? { documents: on } : { enabled: on }
    const r = await act(() => api.call(API.updateKnowledgeGraph, { body }), t(`${k}.${on ? 'onSaved' : 'offSaved'}` as MessageKey))
    setSaving(null)
    if (r) onData(r)
  }
  const codeOn = d.enabled
  const docsOn = !!docs?.enabled
  const anyOn = codeOn || docsOn
  const updating = (docs?.busy ?? 0) + d.busy
  const disk = d.diskBytes + (docs?.diskBytes ?? 0)
  return (
    <>
      {docs && (
        <SettingRow id="kg-docs-enabled" inline title={t('kg.docs.enable')} desc={t('kg.docs.enableDesc')} more={t('kg.docs.enableMore')} testId="kg-docs-row"
          control={<Switch id="kg-docs-enabled" external checked={docs.enabled} disabled={saving !== null} onChange={(v) => void toggle('documents', v)} label={t('kg.docs.enable')} describedBy="kg-docs-enabled-desc" testId="kg-docs-enabled" />} />
      )}
      <SettingRow id="kg-enabled" inline title={t('kg.enable')}
        desc={d.available ? t('kg.enableDesc') : <span data-testid="kg-unavailable">{t('kg.unavailable')}</span>}
        more={d.available ? t('kg.enableMore') : t('kg.installMore')}
        testId="kg-enabled-row"
        control={<Switch id="kg-enabled" external checked={codeOn} disabled={!d.available || saving !== null} onChange={(v) => void toggle('code', v)} label={t('kg.enable')} describedBy="kg-enabled-desc" testId="kg-enabled" />} />
      {anyOn && (
        <>
          <SettingRow heading title={t('kg.folders')} desc={t('kg.foldersDesc')} testId="kg-folders"
            below={<Folders d={d} docs={docsOn ? docs : null} />} />
          {docsOn && docs!.failedCount > 0 && <Failed docs={docs!} />}
          {codeOn && <Added d={d} onData={onData} />}
          <SettingRow heading title={t('kg.storage')} testId="kg-storage"
            desc={
              <>
                <span data-testid="kg-disk">{t('kg.diskUsed', { size: formatSize(disk, locale) })}{d.version ? ` · CodeGraph ${d.version}` : ''}</span>
                {updating > 0 && (
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted" role="status" data-testid="kg-busy">
                    <Loader2 size={13} className="animate-spin" aria-hidden /> {t('kg.busy', { n: updating })}
                  </span>
                )}
              </>
            }
            control={<Button size="sm" onClick={() => setRebuilding(true)} data-testid="kg-rebuild"><RotateCcw size={14} aria-hidden /> {t('kg.rebuild')}</Button>} />
          {rebuilding && <Rebuild codeOn={codeOn} docsOn={docsOn} onClose={() => setRebuilding(false)} onData={onData} />}
        </>
      )}
    </>
  )
}

const STATUS: Record<State, { key: MessageKey; tone: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok' }> = {
  ready: { key: 'kg.status.ready', tone: 'ok' },
  indexing: { key: 'kg.status.indexing', tone: 'accent' },
  pending: { key: 'kg.status.pending', tone: 'neutral' },
  error: { key: 'kg.status.error', tone: 'danger' },
  too_big: { key: 'kg.status.tooBig', tone: 'warn' },
}
/** One badge for a folder with both parts: the one that needs a look first. */
const RANK: Record<State, number> = { error: 0, indexing: 1, pending: 2, too_big: 3, ready: 4 }
const worst = (a: State | undefined, b: State | undefined): State => (!a ? b! : !b ? a : RANK[a] <= RANK[b] ? a : b)

type Row = { path: string; added: boolean; code?: KnowledgeGraphRoot; docs?: DocFolder }

function rowsOf(d: Status, docs: DocsPart | null): Row[] {
  const m = new Map<string, Row>()
  const row = (path: string) => m.get(path) ?? m.set(path, { path, added: false }).get(path)!
  if (docs) for (const f of docs.folders) Object.assign(row(f.path), { docs: f, added: row(f.path).added || f.source === 'added' })
  if (d.enabled) for (const r of d.roots) Object.assign(row(r.path), { code: r, added: row(r.path).added || r.source === 'added' })
  return [...m.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const later = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : a > b ? a : b)

function Folders({ d, docs }: { d: Status; docs: DocsPart | null }) {
  const t = useT()
  const locale = useLocale()
  const rows = rowsOf(d, docs)
  const personal = { folders: Math.max(docs?.personal.folders ?? 0, d.enabled ? d.personal.folders : 0) }
  if (!rows.length && !personal.folders) {
    const busy = d.busy > 0 || (docs?.busy ?? 0) > 0
    return <p className="mt-2 text-sm text-faint" data-testid="kg-empty">{busy ? t('kg.firstRun') : t('kg.none')}</p>
  }
  return (
    <ul className="mt-3 divide-y divide-line rounded-lg border border-line" data-testid="kg-roots">
      {rows.map((r) => {
        const status = worst(r.docs?.status, r.code?.status)
        const updated = later(r.docs?.lastUpdatedAt, r.code?.lastSyncAt)
        const failed = r.docs?.failed ?? 0
        return (
          <li key={r.path} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3" data-testid="kg-root" data-path={r.path} data-status={status}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm text-ink" title={r.path}>{r.path}</p>
              <p className="text-xs text-muted tabular-nums">
                {[
                  r.docs && <span key="d" data-testid="kg-root-docs">{t('kg.docCount', { n: r.docs.documents })}</span>,
                  r.code && <span key="c" data-testid="kg-root-code">{t('kg.counts', { files: r.code.files, symbols: r.code.symbols })}</span>,
                  failed > 0 && <span key="f" className="text-warn" data-testid="kg-root-failed">{t('kg.failedCount', { n: failed })}</span>,
                  updated && status === 'ready' && <span key="u">{t('kg.synced', { when: formatRelative(updated, locale) })}</span>,
                  r.added && <span key="a">{t('kg.addedByAdmin')}</span>,
                ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))}
              </p>
            </div>
            <Badge tone={STATUS[status].tone} className="self-start sm:self-center">{t(STATUS[status].key)}</Badge>
          </li>
        )
      })}
      {personal.folders > 0 && (
        <li className="px-3 py-2.5" data-testid="kg-personal">
          <p className="text-sm text-ink">{t('kg.personal', { n: personal.folders })}</p>
          <p className="text-xs text-muted tabular-nums">
            {[
              docs && t('kg.docCount', { n: docs.personal.documents }),
              d.enabled && d.personal.folders > 0 && t('kg.counts', { files: d.personal.files, symbols: d.personal.symbols }),
              docs && docs.personal.failed > 0 && t('kg.failedCount', { n: docs.personal.failed }),
              t('kg.personalNote'),
            ].filter(Boolean).join(' · ')}
          </p>
        </li>
      )}
    </ul>
  )
}

const REASONS: Record<string, MessageKey> = {
  too_big: 'kg.reason.too_big', timeout: 'kg.reason.timeout', unreadable: 'kg.reason.unreadable', unsupported: 'kg.reason.unsupported', empty: 'kg.reason.empty',
}

/** The documents that could not be read (outside personal folders), with the reason for each, in a dialog. */
function Failed({ docs }: { docs: DocsPart }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <SettingRow heading title={t('kg.failed')} desc={t('kg.failedDesc', { n: docs.failedCount })} testId="kg-failed"
      control={docs.failed.length > 0 ? <Button size="sm" onClick={() => setOpen(true)} data-testid="kg-failed-show">{t('kg.failedShow')}</Button> : undefined}
      below={
        <Modal open={open} onClose={() => setOpen(false)} title={t('kg.failedTitle')} width={560}
          footer={<Button variant="ghost" onClick={() => setOpen(false)}>{t('common.close')}</Button>}>
          <ul className="divide-y divide-line text-sm" data-testid="kg-failed-list">
            {docs.failed.map((f) => (
              <li key={f.path} className="py-2" data-testid="kg-failed-item" data-reason={f.reason}>
                <p className="font-mono text-sm break-all text-ink">{f.path}</p>
                <p className="text-xs text-muted">{t(REASONS[f.reason] ?? 'kg.reason.other')}</p>
              </li>
            ))}
          </ul>
          {docs.failedCount > docs.failed.length && (
            <p className="mt-2 text-xs text-faint" data-testid="kg-failed-more">{t('kg.failedMore', { shown: docs.failed.length, total: docs.failedCount })}</p>
          )}
        </Modal>
      } />
  )
}

/** Rebuild: documents, code or both (only the parts that are on). */
function Rebuild({ codeOn, docsOn, onClose, onData }: { codeOn: boolean; docsOn: boolean; onClose: () => void; onData: (d: Status) => void }) {
  const t = useT()
  const act = useAction()
  const choices: ('both' | Part)[] = codeOn && docsOn ? ['both', 'documents', 'code'] : docsOn ? ['documents'] : ['code']
  const [pick, setPick] = useState<'both' | Part>(choices[0]!)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    const body = pick === 'both' ? {} : { part: pick }
    const r = await act(() => api.call(API.rebuildKnowledgeGraph, { body }), t('kg.rebuildStarted'))
    setBusy(false)
    if (r) { onData(r); onClose() }
  }
  return (
    <Modal open onClose={onClose} title={t('kg.rebuildTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void go()} data-testid="kg-rebuild-confirm">{t('kg.rebuild')}</Button>
        </>
      }>
      <p className="text-sm text-muted">{t('kg.rebuildBody')}</p>
      {choices.length > 1 && (
        <fieldset className="mt-4 space-y-2" data-testid="kg-rebuild-parts">
          <legend className="mb-1 text-sm font-medium text-ink">{t('kg.rebuildPick')}</legend>
          {choices.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="radio" name="kg-rebuild-part" value={c} checked={pick === c} onChange={() => setPick(c)} className="accent-[var(--c-accent)]" data-testid={`kg-rebuild-${c}`} />
              {t(`kg.part.${c}` as MessageKey)}
            </label>
          ))}
        </fieldset>
      )}
    </Modal>
  )
}

const REASON: Record<string, MessageKey> = { personal: 'kg.added.personal', not_found: 'kg.added.notFound', root: 'kg.added.root' }

/** Other folders with code to index (tools/scripts): existing folders outside personal folders. */
function Added({ d, onData }: { d: Status; onData: (d: Status) => void }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (list: string[]) => {
    setBusy(true)
    try {
      onData(await api.call(API.updateKnowledgeGraph, { body: { added: list } }))
      setError(null)
      return true
    } catch (e) {
      const reason = e instanceof ApiError ? String(e.body.params?.reason ?? '') : ''
      if (REASON[reason]) setError(t(REASON[reason]))
      else toast({ level: 'error', text: t('error.network') })
      return false
    } finally { setBusy(false) }
  }
  const add = async () => {
    const p = value.trim().replace(/^\/+|\/+$/g, '')
    if (!p) return
    if (d.added.includes(p)) { setValue(''); return }
    if (await save([...d.added, p])) setValue('')
  }
  return (
    <SettingRow id="kg-add" title={t('kg.addTitle')} desc={t('kg.addDesc')} testId="kg-added"
      below={
        <div className="mt-2 space-y-2">
          {d.added.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" data-testid="kg-added-list">
              {d.added.map((p) => (
                <li key={p} className="inline-flex items-center gap-1 rounded-md border border-line bg-subtle py-0.5 pr-0.5 pl-2 font-mono text-xs text-ink" data-testid="kg-added-item">
                  {p}
                  {/* inside a chip: its look stays small, a phone gets a 44 px box to tap around it */}
                  <PhoneTargets.Provider value={false}>
                    <IconButton label={t('kg.removeAdded', { path: p })} disabled={busy} onClick={() => void save(d.added.filter((x) => x !== p))} className="touch-hit p-0.5 max-sm:p-1"><X size={13} aria-hidden /></IconButton>
                  </PhoneTargets.Provider>
                </li>
              ))}
            </ul>
          )}
          <div className="flex max-w-md gap-2">
            <input id="kg-add" aria-describedby={clsx('kg-add-desc', error && 'kg-add-error')} aria-invalid={!!error} className={clsx(inputCls, 'font-mono')} placeholder="tools/scripts" spellCheck={false} autoCapitalize="off" value={value}
              onChange={(e) => { setValue(e.target.value); setError(null) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} data-testid="kg-add-input" />
            <Button size="md" busy={busy} disabled={!value.trim()} onClick={() => void add()} data-testid="kg-add-button"><Plus size={14} aria-hidden /> {t('kg.add')}</Button>
          </div>
          {error && <p id="kg-add-error" role="alert" className="text-xs text-danger" data-testid="kg-add-error">{error}</p>}
        </div>
      } />
  )
}
