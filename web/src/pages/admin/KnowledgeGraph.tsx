// Admin › Team settings › Knowledge graph (#knowledge-graph; server/src/knowledge-graph/, docs/KNOWLEDGE-GRAPH.md): the
// code map the AI uses (knowledge_explore). On or off (off when CodeGraph is not installed on the server, with the hint
// to install it), the folders indexed with their file and symbol counts and last update, personal folders as a total
// only, other folders to index, disk use and Rebuild. Saves through its own endpoints, at once, like the AI groups above.
// While a folder waits or runs, the list looks again every few seconds.
import clsx from 'clsx'
import { Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type KnowledgeGraphRoot, type KnowledgeGraphStatus } from '@mycel/shared/api'
import { api, API, ApiError } from '../../lib/api'
import { formatRelative, formatSize } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, confirmDialog, IconButton, inputCls, Switch } from '../../components/ui'
import { Loadable, SettingRow, SettingsSection, useAction, useLoad } from './common'

const POLL_MS = 4000

export default function KnowledgeGraphSettings() {
  const t = useT()
  const state = useLoad(() => api.call(API.knowledgeGraphStatus))
  const busy = (state.data?.busy ?? 0) > 0 || !!state.data?.roots.some((r) => r.status === 'pending' || r.status === 'indexing')
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => void api.call(API.knowledgeGraphStatus).then(state.setData, () => {}), POLL_MS)
    return () => clearInterval(id)
  }, [busy, state.setData])
  return (
    <SettingsSection id="knowledge-graph" title={t('kg.title')} desc={t('kg.desc')} testId="knowledge-graph">
      <Loadable state={state} lines={2}>
        {(d) => <Body d={d} onData={state.setData} />}
      </Loadable>
    </SettingsSection>
  )
}

function Body({ d, onData }: { d: KnowledgeGraphStatus; onData: (d: KnowledgeGraphStatus) => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const [saving, setSaving] = useState(false)
  const toggle = async (on: boolean) => {
    if (!on && !(await confirmDialog({ title: t('kg.offTitle'), body: t('kg.offBody'), confirm: t('kg.offConfirm'), danger: true }))) return
    setSaving(true)
    const r = await act(() => api.call(API.updateKnowledgeGraph, { body: { enabled: on } }), on ? t('kg.onSaved') : t('kg.offSaved'))
    setSaving(false)
    if (r) onData(r)
  }
  const rebuild = async () => {
    if (!(await confirmDialog({ title: t('kg.rebuildTitle'), body: t('kg.rebuildBody'), confirm: t('kg.rebuild') }))) return
    const r = await act(() => api.call(API.rebuildKnowledgeGraph, { body: {} }), t('kg.rebuildStarted'))
    if (r) onData(r)
  }
  return (
    <>
      <SettingRow id="kg-enabled" title={t('kg.enable')}
        desc={d.available ? t('kg.enableDesc') : <span data-testid="kg-unavailable">{t('kg.unavailable')}</span>}
        more={d.available ? t('kg.enableMore') : t('kg.installMore')}
        testId="kg-enabled-row"
        control={<Switch id="kg-enabled" external checked={d.enabled} disabled={!d.available || saving} onChange={(v) => void toggle(v)} label={t('kg.enable')} describedBy="kg-enabled-desc" testId="kg-enabled" />} />
      {d.enabled && (
        <>
          <SettingRow heading title={t('kg.folders')} desc={t('kg.foldersDesc')} testId="kg-folders"
            below={<Folders d={d} />} />
          <Added d={d} onData={onData} />
          <SettingRow heading title={t('kg.storage')} testId="kg-storage"
            desc={<span data-testid="kg-disk">{t('kg.diskUsed', { size: formatSize(d.diskBytes, locale) })}{d.version ? ` · CodeGraph ${d.version}` : ''}</span>}
            control={<Button size="sm" onClick={() => void rebuild()} data-testid="kg-rebuild"><RotateCcw size={14} aria-hidden /> {t('kg.rebuild')}</Button>} />
        </>
      )}
    </>
  )
}

const STATUS: Record<KnowledgeGraphRoot['status'], { key: MessageKey; tone: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok' }> = {
  ready: { key: 'kg.status.ready', tone: 'ok' },
  indexing: { key: 'kg.status.indexing', tone: 'accent' },
  pending: { key: 'kg.status.pending', tone: 'neutral' },
  error: { key: 'kg.status.error', tone: 'danger' },
  too_big: { key: 'kg.status.tooBig', tone: 'warn' },
}

function Folders({ d }: { d: KnowledgeGraphStatus }) {
  const t = useT()
  const locale = useLocale()
  if (!d.roots.length && !d.personal.folders) {
    return <p className="mt-2 text-sm text-faint" data-testid="kg-empty">{d.busy ? t('kg.firstRun') : t('kg.none')}</p>
  }
  return (
    <ul className="mt-3 divide-y divide-line rounded-lg border border-line" data-testid="kg-roots">
      {d.roots.map((r) => (
        <li key={r.path} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3" data-testid="kg-root" data-path={r.path} data-status={r.status}>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm text-ink" title={r.path}>{r.path}</p>
            <p className="text-xs text-muted tabular-nums">
              {t('kg.counts', { files: r.files, symbols: r.symbols })}
              {r.lastSyncAt && r.status === 'ready' ? ` · ${t('kg.synced', { when: formatRelative(r.lastSyncAt, locale) })}` : ''}
              {r.source === 'added' ? ` · ${t('kg.addedByAdmin')}` : ''}
            </p>
          </div>
          <Badge tone={STATUS[r.status].tone} className="self-start sm:self-center">{t(STATUS[r.status].key)}</Badge>
        </li>
      ))}
      {d.personal.folders > 0 && (
        <li className="px-3 py-2.5" data-testid="kg-personal">
          <p className="text-sm text-ink">{t('kg.personal', { n: d.personal.folders })}</p>
          <p className="text-xs text-muted tabular-nums">{t('kg.counts', { files: d.personal.files, symbols: d.personal.symbols })} · {t('kg.personalNote')}</p>
        </li>
      )}
    </ul>
  )
}

const REASON: Record<string, MessageKey> = { personal: 'kg.added.personal', not_found: 'kg.added.notFound', root: 'kg.added.root' }

/** Other folders with code to index (tools/scripts): existing folders outside personal folders. */
function Added({ d, onData }: { d: KnowledgeGraphStatus; onData: (d: KnowledgeGraphStatus) => void }) {
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
                  <IconButton label={t('kg.removeAdded', { path: p })} disabled={busy} onClick={() => void save(d.added.filter((x) => x !== p))} className="p-0.5 max-sm:p-1"><X size={13} aria-hidden /></IconButton>
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
