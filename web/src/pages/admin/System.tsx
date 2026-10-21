// System (owner only): diagnostics, connection, update, backup / restore, export. Update, restore and connection
// changes ask for the password again. Long work runs as a job with progress from the WebSocket.
import { CheckCircle2, CircleAlert, CircleHelp, CircleX, Download, FolderSync, HardDrive, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConnectionMode, Job } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatSize } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { useJobs, waitForJob } from '../../store/jobs'
import { toast } from '../../store/ui'
import { Badge, Button, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'
import OfficeUpdate from './OfficeUpdate'
import { isOwner, useMeStrict } from '../../store/session'

const STATUS_ICON = { ok: CheckCircle2, warn: CircleAlert, fail: CircleX, unknown: CircleHelp } as const
const STATUS_CLS = { ok: 'text-ok', warn: 'text-warn', fail: 'text-danger', unknown: 'text-faint' } as const

/** Progress line of a running job. */
function JobLine({ jobId }: { jobId: string }) {
  const t = useT()
  const job = useJobs((s) => s.jobs[jobId])
  const pct = job?.progress !== null && job?.progress !== undefined ? Math.round(job.progress * 100) : null
  return (
    <div className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs" role="status">
      <span className="font-medium">{job?.message ?? t('system.working')}</span>
      {pct !== null && ` · ${pct}%`}
      {pct !== null && (
        <div className="mt-1 h-1 rounded bg-line" aria-hidden>
          <div className="h-full rounded bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function useJobRunner() {
  const t = useT()
  const [jobId, setJobId] = useState<string | null>(null)
  const run = async (start: () => Promise<{ jobId: string } | undefined>, done: (j: Job) => void) => {
    const r = await start()
    if (!r) return
    setJobId(r.jobId)
    try {
      const j = await waitForJob(r.jobId)
      if (j.status === 'done') done(j)
      else toast({ level: 'error', text: j.error?.message ?? t('system.jobFailed') })
    } finally {
      setJobId(null)
    }
  }
  return { jobId, run }
}

/** Ask for the owner's password again (update / restore / connection). */
function ReauthDialog({ title, body, confirm, danger, onClose, onConfirm }: { title: string; body: React.ReactNode; confirm: string; danger?: boolean; onClose: () => void; onConfirm: (password: string) => Promise<void> }) {
  const t = useT()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={!pw}
            onClick={async () => {
              setBusy(true)
              await onConfirm(pw)
              setBusy(false)
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{body}</div>
      <Field label={t('system.passwordAgain')}>
        <input data-autofocus className={inputCls} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
    </Modal>
  )
}

export default function System() {
  // office mode: the installation's automatic updates (docs/OFFICE.md "자동 업데이트") instead of the production
  // updater's card; v null = not office mode, an error (older server) = the production card
  const office = useLoad(async () => ({ v: await api.call(API.officeUpdateStatus) }))
  const me = useMeStrict()
  // a finished backup changes the diagnostics card's "last backup" line
  const [rev, setRev] = useState(0)
  // an admin (office mode): the automatic update card only
  if (!isOwner(me)) return office.data?.v ? <OfficeUpdate status={office.data.v} reload={office.reload} /> : null
  return (
    <>
      <Diagnostics rev={rev} />
      <Connection />
      <ConnectedFolders />
      {office.data?.v ? <OfficeUpdate status={office.data.v} reload={office.reload} /> : (office.data || office.error) && <Update />}
      <Backups onChanged={() => setRev((r) => r + 1)} />
      <Export />
    </>
  )
}

function Diagnostics({ rev }: { rev: number }) {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.diagnostics), [rev])
  const [busy, setBusy] = useState(false)
  return (
    <Card
      title={t('system.diagnostics')}
      actions={
        <Button
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true)
            await state.reload()
            setBusy(false)
          }}
        >
          <RefreshCw size={14} aria-hidden /> {t('common.refresh')}
        </Button>
      }
    >
      <Loadable state={state}>
        {(d) => (
          <>
            <div className="mb-3 grid gap-2 text-sm sm:grid-cols-3">
              <p>
                <span className="text-faint">{t('system.version')}</span> {d.version}
              </p>
              <p>
                <span className="text-faint">{t('system.host')}</span> {d.host.hostname} ({d.host.os}/{d.host.arch})
              </p>
              <p>
                <span className="text-faint">{t('system.queue')}</span> {t('system.queueLine', { running: d.queue.running, queued: d.queue.queued, max: d.queue.concurrency })}
              </p>
              <p className="flex items-center gap-1">
                <HardDrive size={13} className="text-faint" aria-hidden /> {t('system.diskFree', { team: formatSize(d.disk.teamFolderFreeBytes, locale), data: formatSize(d.disk.dataFreeBytes, locale) })}
              </p>
            </div>
            <ul className="divide-y divide-line text-sm" data-testid="diagnostics">
              {d.checks.map((c) => {
                const Icon = STATUS_ICON[c.status]
                return (
                  <li key={c.id} className="flex items-start gap-2 py-2">
                    <Icon size={16} className={`mt-0.5 shrink-0 ${STATUS_CLS[c.status]}`} aria-label={t(`system.check.${c.status}`)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{c.label}</span>
                      {c.detail && <span className="block text-xs text-muted">{c.detail}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-xs text-faint">{t('system.generatedAt', { date: formatDateTime(d.generatedAt, locale) })}</p>
          </>
        )}
      </Loadable>
    </Card>
  )
}

type Mode = ConnectionMode
/** Offered when an older server does not say (the official relay is not running yet; tunnels are not in v1). */
const FALLBACK_MODES: Mode[] = ['self-relay', 'direct-only']
/** Team name at a relay: <name>.<relay domain> (same rule as the server's RelayTeamName). */
const TEAM_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const needsTeamName = (m: Mode) => m === 'relay' || m === 'self-relay'

function Connection() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(() => api.call(API.connection))
  const [change, setChange] = useState<{ mode: Mode; relayUrl: string; teamName: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const modes = state.data?.availableModes ?? FALLBACK_MODES
  const teamNameOk = (n: string) => n.length >= 2 && n.length <= 40 && TEAM_NAME_RE.test(n)
  const open = () => {
    const c = state.data
    if (!c) return
    setChange({ mode: modes.includes(c.mode) ? c.mode : modes[0]!, relayUrl: '', teamName: c.teamName ?? '' })
  }
  return (
    // one mode only (office mode: the office network): nothing to change
    <Card title={t('system.connection')} actions={modes.length > 1 ? <Button size="sm" onClick={open}>{t('system.changeMode')}</Button> : undefined}>
      <Loadable state={state} lines={2}>
        {(c) => (
          <div className="space-y-1 text-sm">
            <p>
              <Badge tone={c.state === 'connected' ? 'ok' : c.state === 'connecting' ? 'warn' : 'danger'}>{t(`system.conn.${c.state}`)}</Badge> <span className="ml-1">{t(`system.mode.${c.mode}`)}</span>
            </p>
            {c.teamName && c.mode !== 'direct-only' && (
              <p>
                <span className="text-faint">{t('system.teamName')}</span> <code>{c.teamName}</code>
              </p>
            )}
            {c.address && (
              <p>
                <span className="text-faint">{t('system.address')}</span> <code>{c.address}</code>
              </p>
            )}
            {c.connectedSince && <p className="text-xs text-faint">{t('system.since', { date: formatDateTime(c.connectedSince, locale) })}</p>}
            {c.detail && <p className="text-xs text-muted">{c.detail}</p>}
            <p className="text-xs text-faint">{c.direct.enabled ? t('system.directOn', { port: c.direct.port }) : t('system.directOff')}</p>
            {c.direct.fingerprintSha256 && <p className="font-mono text-[11px] break-all text-faint">SHA-256 {c.direct.fingerprintSha256}</p>}
          </div>
        )}
      </Loadable>
      {change && !confirming && (
        <Modal
          open
          onClose={() => setChange(null)}
          title={t('system.changeMode')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setChange(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={(change.mode === 'self-relay' && !/^wss?:\/\/|^https?:\/\//.test(change.relayUrl)) || (needsTeamName(change.mode) && !teamNameOk(change.teamName))}
                onClick={() => setConfirming(true)}
              >
                {t('common.continue')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label={t('system.mode')}>
              <select className={inputCls} value={change.mode} onChange={(e) => setChange({ ...change, mode: e.target.value as Mode })} data-testid="connection-mode">
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {t(`system.mode.${m}`)}
                  </option>
                ))}
              </select>
            </Field>
            {change.mode === 'self-relay' && (
              <Field label={t('system.relayUrl')}>
                <input className={inputCls} value={change.relayUrl} onChange={(e) => setChange({ ...change, relayUrl: e.target.value })} placeholder="wss://relay.example.com/connect" />
              </Field>
            )}
            {needsTeamName(change.mode) && (
              <Field label={t('system.teamName')} hint={t('system.teamNameHint')} error={change.teamName && !teamNameOk(change.teamName) ? t('system.teamNameInvalid') : null}>
                <input
                  className={inputCls}
                  value={change.teamName}
                  onChange={(e) => setChange({ ...change, teamName: e.target.value.trim().toLowerCase() })}
                  placeholder="acme"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="relay-team-name"
                />
              </Field>
            )}
            <p className="text-xs text-warn">{t('system.modeWarning')}</p>
          </div>
        </Modal>
      )}
      {change && confirming && (
        <ReauthDialog
          title={t('system.changeMode')}
          body={t(`system.mode.${change.mode}`)}
          confirm={t('common.save')}
          onClose={() => setConfirming(false)}
          onConfirm={async (password) => {
            const r = await act(
              () =>
                api.call(API.updateConnection, {
                  body: { mode: change.mode, relayUrl: change.mode === 'self-relay' ? change.relayUrl : undefined, teamName: needsTeamName(change.mode) ? change.teamName : undefined, password },
                }),
              t('common.saved'),
            )
            if (r) {
              state.setData(r)
              setChange(null)
              setConfirming(false)
            }
          }}
        />
      )}
    </Card>
  )
}

/** Connected folders (team-files/connected.ts): a NAS share / Google Drive / folder of this Mac mirrored into connected/. */
function ConnectedFolders() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(async () => (await api.call(API.listConnected)).items)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [asking, setAsking] = useState(false)
  const syncing = !!state.data?.some((c) => c.syncing)
  // while a sync runs, look again every few seconds
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => void state.reload(), 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing])
  return (
    <Card title={t('connected.title')} desc={t('connected.desc')}>
      <Loadable state={state}>
        {(list) => (
          <>
            {!list.length ? <p className="text-sm text-faint">{t('connected.empty')}</p> : (
              <ul className="divide-y divide-line rounded-xl border border-line" data-testid="connected-list">
                {list.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <FolderSync size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 font-medium">
                        {c.path}
                        {c.syncing ? <Badge tone="accent">{t('connected.syncing')}</Badge> : c.lastStatus === 'error' ? <Badge tone="danger">!</Badge> : null}
                      </span>
                      <span className="block truncate text-xs text-muted" title={c.source}>{c.source}</span>
                      <span className="mt-0.5 block text-xs text-faint">
                        {c.lastSyncAt ? t('connected.last', { time: formatDateTime(c.lastSyncAt, locale), files: String(c.files), size: formatSize(c.bytes, locale) }) : t('connected.never')}
                        {c.lastStatus === 'partial' && ` · ${t('connected.partial')}`}
                      </span>
                      {c.lastStatus === 'error' && c.lastError && <span className="mt-1 block text-xs text-danger">{c.lastError}</span>}
                    </span>
                    <Button size="sm" disabled={c.syncing} onClick={() => void act(() => api.call(API.syncConnected, { params: { id: c.id } })).then(() => state.reload())}>
                      <RefreshCw size={13} aria-hidden /> {t('connected.syncNow')}
                    </Button>
                    <button type="button" aria-label={t('connected.remove')} title={t('connected.remove')} className="rounded p-1 text-faint hover:bg-hover hover:text-danger"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: t('connected.removeTitle'), body: t('connected.removeBody', { name: c.name }), confirm: t('connected.remove'), danger: true }))) return
                        await act(() => api.call(API.removeConnected, { params: { id: c.id } }))
                        void state.reload()
                      }}>
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* top-aligned, so the hint under the path does not push the name field down; the button gets a label-high
                spacer to line up with the inputs */}
            <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
              <Field label={t('connected.name')}>
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="connected-name" />
              </Field>
              <Field label={t('connected.source')} hint={t('connected.sourceHint')}>
                <input className={inputCls} value={source} onChange={(e) => setSource(e.target.value)} placeholder="/Volumes/…" data-testid="connected-source" />
              </Field>
              <div>
                <span className="mb-1.5 hidden text-[13px] sm:block" aria-hidden>&nbsp;</span>
                <Button disabled={!name.trim() || !source.trim()} onClick={() => setAsking(true)}>{t('connected.add')}</Button>
              </div>
            </div>
          </>
        )}
      </Loadable>
      {asking && (
        <ReauthDialog
          title={t('connected.addTitle')}
          body={t('connected.addBody', { source: source.trim(), name: name.trim() })}
          confirm={t('connected.add')}
          onClose={() => setAsking(false)}
          onConfirm={async (password) => {
            const r = await act(() => api.call(API.addConnected, { body: { name: name.trim(), source: source.trim(), password } }))
            if (r) {
              setAsking(false)
              setName('')
              setSource('')
              void state.reload()
            }
          }}
        />
      )}
    </Card>
  )
}

function Update() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(() => api.call(API.updateStatus))
  const runner = useJobRunner()
  const [ask, setAsk] = useState<'update' | 'rollback' | null>(null)
  return (
    <Card title={t('system.update')}>
      <Loadable state={state} lines={2}>
        {(u) => (
          <div className="space-y-2 text-sm">
            <p>
              {t('system.current', { version: u.current })} · {t(u.channel === 'beta' ? 'teamSettings.beta' : 'teamSettings.stable')}
              {u.lastCheckedAt && <span className="text-xs text-faint"> · {t('system.checked', { date: formatDateTime(u.lastCheckedAt, locale) })}</span>}
            </p>
            {u.available ? (
              <div className="rounded-lg border border-line p-3">
                <p className="font-medium">{t('system.available', { version: u.available.version })}</p>
                <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{u.available.notes}</p>
                {u.available.needsBackupRestoreToRollBack && <p className="mt-1 text-xs text-warn">{t('system.oneWay')}</p>}
                <Button variant="primary" size="sm" className="mt-2" disabled={!!runner.jobId} onClick={() => setAsk('update')}>
                  <Upload size={14} aria-hidden /> {t('system.installUpdate')}
                </Button>
              </div>
            ) : u.feed === false ? (
              <p className="text-muted">{t('system.noFeed')}</p>
            ) : (
              <p className="text-muted">{t('system.upToDate')}</p>
            )}
            {u.previous && (
              <Button size="sm" variant="ghost" disabled={!!runner.jobId} onClick={() => setAsk('rollback')}>
                <RotateCcw size={14} aria-hidden /> {t('system.rollback', { version: u.previous })}
              </Button>
            )}
            {runner.jobId && <JobLine jobId={runner.jobId} />}
          </div>
        )}
      </Loadable>
      {ask && (
        <ReauthDialog
          title={ask === 'update' ? t('system.installUpdate') : t('system.rollback', { version: state.data?.previous ?? '' })}
          body={t('system.updateNote')}
          confirm={t('common.continue')}
          onClose={() => setAsk(null)}
          onConfirm={async (password) => {
            const kind = ask
            setAsk(null)
            await runner.run(
              () => act(() => api.call(API.startUpdate, { body: kind === 'rollback' ? { password, rollback: true } : { password, version: state.data?.available?.version } })),
              () => {
                toast({ level: 'success', text: t('system.updateDone') })
                void state.reload()
              },
            )
          }}
        />
      )}
    </Card>
  )
}

function Backups({ onChanged }: { onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(async () => (await api.call(API.listBackups)).items)
  const runner = useJobRunner()
  const [restore, setRestore] = useState<{ id: string; createdAt: string } | null>(null)
  return (
    <Card
      title={t('system.backups')}
      desc={t('system.backupsDesc')}
      actions={
        <Button
          size="sm"
          disabled={!!runner.jobId}
          onClick={() =>
            void runner.run(
              () => act(() => api.call(API.startBackup, { body: { scope: 'full' } })),
              () => {
                toast({ level: 'success', text: t('system.backupDone') })
                void state.reload()
                onChanged()
              },
            )
          }
          data-testid="backup-now"
        >
          {t('system.backupNow')}
        </Button>
      }
    >
      {runner.jobId && <JobLine jobId={runner.jobId} />}
      <Loadable state={state}>
        {(list) =>
          !list.length ? (
            <p className="text-sm text-faint">{t('system.noBackups')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {list.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    {formatDateTime(b.createdAt, locale)} <span className="text-xs text-faint">· {formatSize(b.size, locale)}</span>
                  </span>
                  <Badge>{t(`system.backupKind.${b.kind}`)}</Badge>
                  <Badge tone="neutral">{t(`system.backupScope.${b.scope}`)}</Badge>
                  <Button size="sm" variant="ghost" disabled={!!runner.jobId} onClick={() => setRestore({ id: b.id, createdAt: b.createdAt })}>
                    {t('system.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {restore && (
        <ReauthDialog
          danger
          title={t('system.restoreTitle')}
          body={t('system.restoreBody', { date: formatDateTime(restore.createdAt, locale) })}
          confirm={t('system.restore')}
          onClose={() => setRestore(null)}
          onConfirm={async (password) => {
            const id = restore.id
            setRestore(null)
            await runner.run(
              () => act(() => api.call(API.startRestore, { body: { password, backupId: id } })),
              () => toast({ level: 'success', text: t('system.restoreDone'), sticky: true, action: { label: t('update.reload'), run: () => location.reload() } }),
            )
          }}
        />
      )}
    </Card>
  )
}

function Export() {
  const t = useT()
  const act = useAction()
  const runner = useJobRunner()
  const [what, setWhat] = useState<('chats' | 'memories' | 'files')[]>(['chats', 'memories'])
  const [pw, setPw] = useState('')
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => setResult(null), [what])
  return (
    <Card title={t('system.export')} desc={t('system.exportDesc')}>
      <div className="flex flex-wrap gap-3">
        {(['chats', 'memories', 'files'] as const).map((w) => (
          <label key={w} className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={what.includes(w)} onChange={(e) => setWhat(e.target.checked ? [...what, w] : what.filter((x) => x !== w))} />
            {t(`system.exportWhat.${w}`)}
          </label>
        ))}
      </div>
      <Field label={t('system.exportPassword')} hint={t('system.exportPasswordHint')}>
        <input className={`${inputCls} mt-1 max-w-xs`} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
      <Button
        className="mt-3"
        variant="primary"
        disabled={!what.length || !!runner.jobId || (pw.length > 0 && pw.length < 8)}
        onClick={() =>
          void runner.run(
            () => act(() => api.call(API.startExport, { body: { what, password: pw || undefined } })),
            (j) => setResult(j.result && 'path' in j.result ? j.result.path : null),
          )
        }
      >
        <Download size={14} aria-hidden /> {t('system.exportStart')}
      </Button>
      {runner.jobId && <JobLine jobId={runner.jobId} />}
      {result && <p className="mt-2 text-sm text-ok">{t('system.exportDone', { path: result })}</p>}
    </Card>
  )
}
