// System: owner = storage, version and updates, health, connection, connected folders, backups, export; an admin =
// the plan, storage and (office mode) the automatic updates. Laid out like a settings document (Team settings): plain
// sections under headings, label / value rows, long explanations behind "Learn more"; no boxes. Update, restore and
// connection changes ask for the password again. Long work runs as a job with progress from the WebSocket.
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { CheckCircle2, CircleAlert, CircleHelp, CircleX, Download, FolderSync, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ConnectionMode } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatSize } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, ErrorNote, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { AdminPageHeader, Card, FlatCardsProvider, Loadable as CardLoadable, ReauthDialog, useAction, useActionOk, useLoad } from './common'
import OfficeUpdate from './OfficeUpdate'
import { JobLine, useJobRunner, useUpdateInstall } from './jobs'
import { ReleaseNotes } from '../../components/ReleaseNotes'
import { isOwner, useMeStrict } from '../../store/session'
import { safeHref } from '../../lib/safeLinks'

const STATUS_ICON = { ok: CheckCircle2, warn: CircleAlert, fail: CircleX, unknown: CircleHelp } as const
const STATUS_CLS = { ok: 'text-ok', warn: 'text-warn', fail: 'text-danger', unknown: 'text-faint' } as const
/** problems first: a failed check, then a warning, then one that could not be checked */
const STATUS_ORDER = { fail: 0, warn: 1, unknown: 2, ok: 3 } as const

type LoadState<T> = { data: T | null; error: string | null; reload: () => Promise<void> }
type Report = (id: string, entry: { error: string | null; reload: () => Promise<void> } | null) => void
/** Each section tells the page whether its load failed, so a page where every one failed shows one message, not one per section. */
const LoadReport = createContext<Report | null>(null)

/** The sections' Loadable: the same, and it reports its load error (or none) to the page. */
function Loadable<T>({ state, children, lines }: { state: LoadState<T>; children: (d: T) => ReactNode; lines?: number }) {
  const report = useContext(LoadReport)
  const id = useId()
  useEffect(() => {
    report?.(id, { error: state.error, reload: state.reload })
  }, [report, id, state.error, state.reload])
  useEffect(() => () => report?.(id, null), [report, id])
  return <CardLoadable state={state} lines={lines}>{children}</CardLoadable>
}

/** The failures the sections reported; allFailed when 2 or more report and every one failed (the server did not answer). */
function useLoadReport() {
  const [entries, setEntries] = useState<Record<string, { error: string | null; reload: () => Promise<void> }>>({})
  const report = useCallback<Report>((id, entry) => {
    setEntries((m) => {
      if (entry === null) {
        if (!(id in m)) return m
        const { [id]: _gone, ...rest } = m
        return rest
      }
      if (m[id]?.error === entry.error && m[id]?.reload === entry.reload) return m
      return { ...m, [id]: entry }
    })
  }, [])
  const list = Object.values(entries)
  const allFailed = list.length >= 2 && list.every((e) => e.error !== null)
  return { report, allFailed, firstError: list[0]?.error ?? null, reloadAll: () => Promise.all(list.map((e) => e.reload())) }
}

/** One message for the whole page when no section could load, with one retry for all of them. */
function AllFailed({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  const t = useT()
  return (
    <div className="mb-6" data-testid="system-all-failed">
      <ErrorNote detail={detail} onRetry={onRetry}>{t('system.allFailed')}</ErrorNote>
    </div>
  )
}

/** Label / value rows (a definition list): the label on the left, the value next to it, an action on the right; on a
 * phone the label goes above the value. */
function Rows({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return <dl className={`divide-y divide-line text-sm ${className ?? ''}`} data-testid={testId}>{children}</dl>
}
function Row({ label, children, action, testId }: { label: ReactNode; children: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-1 py-2.5 sm:flex-nowrap" data-testid={testId}>
      <dt className="text-muted max-sm:basis-full sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
      {action && <dd className="shrink-0">{action}</dd>}
    </div>
  )
}

/** A short line with its longer explanation behind "Learn more" (kept in the page, hidden, so the line reads short). */
function LearnMore({ short, long }: { short: ReactNode; long: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      {short}{' '}
      <button type="button" aria-expanded={open} className="font-medium whitespace-nowrap text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)}>
        {t(open ? 'common.less' : 'teamSettings.learnMore')}
      </button>
      <span hidden={!open} className="mt-2 block max-w-prose text-xs leading-relaxed text-faint">{long}</span>
    </>
  )
}

export default function System() {
  const t = useT()
  const loads = useLoadReport()
  // the sections stay mounted while hidden, so they can report that they loaded again after a retry
  return (
    <LoadReport.Provider value={loads.report}>
      <FlatCardsProvider value>
        <AdminPageHeader title={t('admin.system')} />
        {loads.allFailed && <AllFailed detail={loads.firstError} onRetry={() => void loads.reloadAll()} />}
        <div hidden={loads.allFailed} className="max-w-3xl" data-testid="system-page">
          <SystemSections />
        </div>
      </FlatCardsProvider>
    </LoadReport.Provider>
  )
}

function SystemSections() {
  // office mode: the installation's automatic updates (docs/OFFICE.md "자동 업데이트") instead of the production
  // updater's section; v null = not office mode, an error (older server) = the production section
  const office = useLoad(async () => ({ v: await api.call(API.officeUpdateStatus) }))
  const me = useMeStrict()
  // a finished backup changes the health section's "last backup" line
  const [rev, setRev] = useState(0)
  // what this deployment offers (server/src/system/deployment.ts; absent from older servers = everything)
  const features = me.server.features
  // an admin: the plan, the storage use, and (office mode) the automatic updates
  if (!isOwner(me)) return (
    <>
      <PlanCard />
      <Storage />
      {office.data?.v ? <OfficeUpdate status={office.data.v} reload={office.reload} /> : null}
    </>
  )
  // the owner: what the team sees first (the plan, the space), then the version, the server's health, how the team
  // reaches it, and the tools (connected folders, backups, export)
  return (
    <>
      <PlanCard />
      <Storage />
      {office.data?.v ? <OfficeUpdate status={office.data.v} reload={office.reload} /> : (office.data || office.error) && <Update />}
      <Health rev={rev} />
      <Connection canChange={features?.connectionChange !== false} />
      {features?.connectedFolders !== false && <ConnectedFolders />}
      <Backups onChanged={() => setRev((r) => r + 1)} />
      <Export />
    </>
  )
}

/** The server's checks (diagnostics): what needs attention first, each with its one line; the checks that passed fold
 * into one line with "Show details". The facts (server, queue, free space) as rows above. */
function Health({ rev }: { rev: number }) {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.diagnostics), [rev])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <Card
      title={t('system.health')}
      testId="system-health"
      actions={
        <Button
          size="sm"
          variant="ghost"
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
        {(d) => {
          const problems = d.checks.filter((c) => c.status !== 'ok').sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
          const passed = d.checks.filter((c) => c.status === 'ok')
          const check = (c: (typeof d.checks)[number]) => {
            const Icon = STATUS_ICON[c.status]
            return (
              <li key={c.id} className="flex items-start gap-2.5 py-2.5" data-status={c.status}>
                <Icon size={16} className={`mt-0.5 shrink-0 ${STATUS_CLS[c.status]}`} aria-label={t(`system.check.${c.status}`)} />
                <span className="min-w-0 flex-1">
                  {/* the disk check is the server's free space, not the team's storage use (Storage above, and Home):
                      the label says so, so the two do not read as two answers to one question */}
                  <span className="block">{c.id === 'disk' ? t('adminux.system.diskCheck') : c.label}</span>
                  {c.detail && <span className="block text-xs text-muted">{c.detail}</span>}
                </span>
              </li>
            )
          }
          return (
            <>
              <ul className="divide-y divide-line text-sm" data-testid="diagnostics">
                {problems.map(check)}
                {passed.length > 0 && (
                  <li className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      <CheckCircle2 size={16} className="shrink-0 text-ok" aria-hidden />
                      <span className="min-w-0 flex-1">{t('system.healthPassed', { n: passed.length })}</span>
                      <button type="button" aria-expanded={open} className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)} data-testid="health-details">
                        {t(open ? 'system.hideDetails' : 'system.showDetails')}
                      </button>
                    </div>
                    <ul hidden={!open} className="mt-1 divide-y divide-line pl-6">{passed.map(check)}</ul>
                  </li>
                )}
              </ul>
              <Rows testId="system-facts" className="mt-3 border-t border-line">
                <Row label={t('system.host')}>{d.host.hostname} ({d.host.os}/{d.host.arch})</Row>
                <Row label={t('system.queue')}>{t('system.queueLine', { running: d.queue.running, queued: d.queue.queued, max: d.queue.concurrency })}</Row>
                <Row label={t('system.freeSpace')}>{t('system.freeSpaceValue', { team: formatSize(d.disk.teamFolderFreeBytes, locale), data: formatSize(d.disk.dataFreeBytes, locale) })}</Row>
              </Rows>
              <p className="mt-2 text-xs text-faint">{t('system.generatedAt', { date: formatDateTime(d.generatedAt, locale) })}</p>
            </>
          )
        }}
      </Loadable>
    </Card>
  )
}

const STORAGE_PARTS = ['team', 'history', 'trash', 'backups', 'models', 'data', 'app', 'other'] as const
const LEVEL_TONE = { ok: 'ok', warn: 'warn', high: 'warn', full: 'danger' } as const

/** Storage use of the team disk (system/storage.ts): one line with the state, a thin bar, then what uses the space. */
function Storage() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.storage))
  return (
    <Card title={t('storage.title')}>
      <Loadable state={state} lines={2}>
        {(s) => {
          const pct = Math.min(100, Math.max(0, s.percent))
          const bar = s.level === 'full' ? 'bg-danger' : s.level === 'ok' ? 'bg-accent' : 'bg-warn'
          return (
            <div className="space-y-3 text-sm" data-testid="storage">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t('storage.used', { used: formatSize(s.usedBytes, locale), total: formatSize(s.totalBytes, locale), pct: Math.round(pct) })}
                    <span className="text-muted"> · {t('storage.free', { free: formatSize(s.freeBytes, locale) })}</span>
                  </span>
                  <Badge tone={LEVEL_TONE[s.level]}>{t(`storage.level.${s.level}`)}</Badge>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t('storage.title')}>
                  <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} data-testid="storage-bar" />
                </div>
              </div>
              {s.writesRefused && <p className="text-xs text-danger" role="alert">{t(s.graceEndsAt ? 'storage.overRefused' : 'storage.refused')}</p>}
              {s.graceEndsAt && !s.writesRefused && <p className="text-xs text-warn" role="status">{t('storage.grace', { date: formatDateTime(s.graceEndsAt, locale) })}</p>}
              {s.level !== 'ok' && <p className="text-xs text-warn">{t('storage.howToFree')}</p>}
              {s.breakdown && (
                // two columns of quiet rows; a wide gap, so one column's size does not run into the next column's name
                <ul className="grid gap-x-10 sm:grid-cols-2" data-testid="storage-breakdown">
                  {STORAGE_PARTS.map((k) => (
                    <li key={k} className="flex justify-between gap-4 border-b border-line py-1.5">
                      <span className="min-w-0 text-muted">{t(`storage.part.${k}`)}</span>
                      <span className="shrink-0 tabular-nums">{formatSize(s.breakdown![k], locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(s.measuredAt || s.planDiskGiB !== null) && (
                <p className="text-xs text-faint">
                  {s.measuredAt && t('storage.measured', { date: formatDateTime(s.measuredAt, locale) })}
                  {s.measuredAt && s.planDiskGiB !== null && ' · '}
                  {s.planDiskGiB !== null && t('storage.planDisk', { gb: s.planDiskGiB })}
                </p>
              )}
            </div>
          )
        }}
      </Loadable>
    </Card>
  )
}

/** a support contact from plan.json: a URL as is, a mail address as mailto: */
const supportHref = (v: string) => (/^[^\s@/]+@[^\s@/]+$/.test(v) ? `mailto:${v}` : safeHref(v))

/** The plan (plan.json; the hosted service or a self-hosted plan file): "Plan: Team · up to 3 answers at the same time ·
 * 7 of 12 members · 50 GB storage · [Manage plan]". Nothing without a plan file (GET /api/admin/plan answers null). */
function PlanCard() {
  const t = useT()
  const state = useLoad(() => api.call(API.plan))
  const p = state.data?.plan
  if (!p) return null
  const manage = safeHref(p.links?.account)
  const status = safeHref(p.links?.status)
  const support = p.links ? supportHref(p.links.support) : null
  return (
    <Card title={t('plan.title')}>
      <div className="space-y-2 text-sm" data-testid="plan-card">
        <p>
          <span className="font-medium">{p.name}</span>
          {' · '}
          {t('plan.concurrency', { max: p.maxConcurrency })}
          {' · '}
          {p.maxActiveMembers !== null ? t('plan.members', { used: p.activeMembers, max: p.maxActiveMembers }) : t('plan.membersUnlimited', { used: p.activeMembers })}
          {' · '}
          {t('plan.disk', { gb: p.diskGiB })}
        </p>
        <p className="text-xs text-faint">{t('plan.details', { days: p.localBackupRetentionDays })}</p>
        {p.maxActiveMembers !== null && p.activeMembers >= p.maxActiveMembers && <p className="text-xs text-warn" role="status">{t('plan.membersFull')}</p>}
        {(manage || status || support) && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {manage && <a className="font-medium text-accent-text underline" href={manage} target="_blank" rel="noreferrer">{t('plan.manage')}</a>}
            {status && <a className="text-accent-text underline" href={status} target="_blank" rel="noreferrer">{t('plan.status')}</a>}
            {support && <a className="text-accent-text underline" href={support} target="_blank" rel="noreferrer">{t('plan.support')}</a>}
          </p>
        )}
      </div>
    </Card>
  )
}

type Mode = ConnectionMode
/** Offered when an older server does not say (the official relay is not running yet; tunnels are not in v1). */
const FALLBACK_MODES: Mode[] = ['self-relay', 'direct-only']
/** Team name at a relay: <name>.<relay domain> (same rule as the server's RelayTeamName). */
const TEAM_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const needsTeamName = (m: Mode) => m === 'relay' || m === 'self-relay'
/** relay registration details the server reports as codes (relay-client/index.ts) that have words of their own */
const DETAIL_TEXT: Record<string, MessageKey> = {
  registration_closed: 'system.detail.registration_closed',
  bad_claim: 'system.detail.bad_claim',
  awaiting_operator: 'system.detail.awaiting_operator',
}
/** claim codes as the account console shows them: groups of four letters / digits */
const claimCodeOk = (c: string) => c === '' || /^[A-Za-z0-9 -]{16,64}$/.test(c.trim())

function Connection({ canChange = true }: { canChange?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(() => api.call(API.connection))
  const [change, setChange] = useState<{ mode: Mode; relayUrl: string; teamName: string; claimCode: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const modes = state.data?.availableModes ?? FALLBACK_MODES
  const teamNameOk = (n: string) => n.length >= 2 && n.length <= 40 && TEAM_NAME_RE.test(n)
  const open = () => {
    const c = state.data
    if (!c) return
    setChange({ mode: modes.includes(c.mode) ? c.mode : modes[0]!, relayUrl: '', teamName: c.teamName ?? '', claimCode: '' })
  }
  // without the relay: the office network only, or the public address the server has (tunnel.host, its own domain;
  // the Health relay line says the same, server/src/system/ops.ts)
  const pub = state.data?.publicAddress ?? null
  const modeName = (m: Mode) => t(m === 'direct-only' && pub ? 'system.mode.direct-public' : `system.mode.${m}`)
  return (
    // one mode only (office mode: the office network): nothing to change
    // the hosted cloud: the team address is managed by the hosting provider (no change button)
    <Card title={t('system.connection')} actions={canChange && modes.length > 1 ? <Button size="sm" onClick={open}>{t('system.changeMode')}</Button> : undefined}>
      <Loadable state={state} lines={2}>
        {(c) => (
          <>
            <Rows>
              <Row label={t('system.mode')}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {/* no relay and a public address: nothing is off for the team, so no "Off" badge */}
                  {!(c.mode === 'direct-only' && pub) && <Badge tone={c.state === 'connected' ? 'ok' : c.state === 'connecting' ? 'warn' : 'danger'}>{t(`system.conn.${c.state}`)}</Badge>}
                  <span data-testid="connection-mode-name">{modeName(c.mode)}</span>
                </span>
                {c.connectedSince && <span className="block text-xs text-faint">{t('system.since', { date: formatDateTime(c.connectedSince, locale) })}</span>}
                {c.detail && <span className="block text-xs text-muted">{DETAIL_TEXT[c.detail] ? t(DETAIL_TEXT[c.detail]!) : c.detail}</span>}
              </Row>
              {c.teamName && c.mode !== 'direct-only' && (
                <Row label={t('system.teamName')}>
                  <code>{c.teamName}</code>
                </Row>
              )}
              {c.address && (
                <Row label={t('system.address')}>
                  <code className="break-all">{c.address}</code>
                </Row>
              )}
              {pub && (
                <Row label={t('system.publicAddress')}>
                  <code className="break-all">https://{pub}</code>
                </Row>
              )}
            </Rows>
            <p className="mt-2 text-xs text-faint">{c.direct.enabled ? t('system.directOn', { port: c.direct.port }) : t('system.directOff')}</p>
            {c.direct.fingerprintSha256 && <p className="font-mono text-[11px] break-all text-faint">SHA-256 {c.direct.fingerprintSha256}</p>}
          </>
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
                disabled={(change.mode === 'self-relay' && !/^wss?:\/\/|^https?:\/\//.test(change.relayUrl)) || (needsTeamName(change.mode) && !teamNameOk(change.teamName)) || !claimCodeOk(change.claimCode)}
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
                    {modeName(m)}
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
            {needsTeamName(change.mode) && (
              <Field label={t('system.claimCode')} hint={t('system.claimCodeHint', { host: SERVICE_HOSTS.accountHost })} error={!claimCodeOk(change.claimCode) ? t('system.detail.bad_claim') : null}>
                <input
                  className={inputCls}
                  value={change.claimCode}
                  onChange={(e) => setChange({ ...change, claimCode: e.target.value.toUpperCase() })}
                  placeholder="ABCD-EFGH-JKLM-NPQR-STUV"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="relay-claim-code"
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
          body={modeName(change.mode)}
          confirm={t('common.save')}
          onClose={() => setConfirming(false)}
          onConfirm={async (password) => {
            const r = await act(
              () =>
                api.call(API.updateConnection, {
                  body: {
                    mode: change.mode, relayUrl: change.mode === 'self-relay' ? change.relayUrl : undefined, teamName: needsTeamName(change.mode) ? change.teamName : undefined,
                    claimCode: needsTeamName(change.mode) && change.claimCode.trim() ? change.claimCode.trim() : undefined, password,
                  },
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
  const actOk = useActionOk()
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
    <Card title={t('connected.title')} desc={<LearnMore short={t('connected.descShort')} long={t('connected.desc')} />}>
      <Loadable state={state}>
        {(list) => (
          <>
            {!list.length ? <p className="text-sm text-faint">{t('connected.empty')}</p> : (
              <ul className="divide-y divide-line border-y border-line" data-testid="connected-list">
                {list.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 py-3 text-sm">
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
                    <Button size="sm" variant="ghost" disabled={c.syncing} onClick={() => void act(() => api.call(API.syncConnected, { params: { id: c.id } })).then(() => state.reload())}>
                      <RefreshCw size={13} aria-hidden /> {t('connected.syncNow')}
                    </Button>
                    <button type="button" aria-label={t('connected.remove')} title={t('connected.remove')} className="rounded p-1 text-faint hover:bg-hover hover:text-danger"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: t('connected.removeTitle'), body: t('connected.removeBody', { name: c.name }), confirm: t('connected.remove'), danger: true }))) return
                        await actOk(() => api.call(API.removeConnected, { params: { id: c.id } }))
                        void state.reload() // also after a failure: a folder someone else removed goes from the list
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
                <span className="mb-1.5 hidden text-label sm:block" aria-hidden>&nbsp;</span>
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

/** Version and updates (production): the version and channel, the state with its action on the right, automatic
 * updates (the window lives in Team settings) and going back to the previous version. */
function Update() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.updateStatus))
  const install = useUpdateInstall({ version: state.data?.available?.version, previous: state.data?.previous, onDone: () => void state.reload() })
  const setAsk = install.ask
  return (
    <Card title={t('system.updates')}>
      <Loadable state={state} lines={2}>
        {(u) => (
          <>
            <Rows testId="system-update">
              <Row label={t('system.version')}>
                {u.current} · {t(u.channel === 'beta' ? 'teamSettings.beta' : 'teamSettings.stable')}
                {u.lastCheckedAt && <span className="block text-xs text-faint">{t('system.checked', { date: formatDateTime(u.lastCheckedAt, locale) })}</span>}
              </Row>
              {u.managed ? (
                // the hosted cloud: the hosting provider installs updates during the maintenance window (no buttons here)
                <Row label={t('system.row.status')}>
                  <span className="text-muted" data-testid="update-managed">{t('system.updateManaged')}</span>
                </Row>
              ) : u.available ? (
                <Row
                  label={t('system.row.status')}
                  action={
                    u.needsRoot ? undefined : (
                      <Button variant="primary" size="sm" disabled={!!install.jobId} onClick={() => setAsk('update')}>
                        <Upload size={14} aria-hidden /> {t('system.installUpdate')}
                      </Button>
                    )
                  }
                >
                  <span className="font-medium">{t('system.available', { version: u.available.version })}</span>
                  <ReleaseNotes notes={u.available.notes} />
                  {u.available.needsBackupRestoreToRollBack && <span className="mt-1 block text-xs text-warn">{t('system.oneWay')}</span>}
                  {u.needsRoot && <span className="mt-1 block text-xs text-warn" data-testid="update-needs-root">{t('system.updateNeedsRoot')}</span>}
                </Row>
              ) : (
                <Row label={t('system.row.status')}>
                  {u.feed === false ? <span className="text-muted"><LearnMore short={t('system.noFeedShort')} long={t('system.noFeed')} /></span> : <span className="text-muted">{t('system.upToDate')}</span>}
                </Row>
              )}
              {u.auto && !u.managed && (
                <Row label={t('system.row.auto')} action={<Link to="/admin/settings#ts-time" className="text-xs font-medium text-accent-text underline-offset-2 hover:underline">{t('system.updateWindowLink')}</Link>}>
                  <span className="text-muted">{t('system.autoOn')}</span>
                </Row>
              )}
              {u.previous && !u.managed && (
                <Row
                  label={t('system.row.previous')}
                  action={
                    <Button size="sm" variant="ghost" disabled={!!install.jobId} onClick={() => setAsk('rollback')}>
                      <RotateCcw size={14} aria-hidden /> {t('system.rollbackShort')}
                    </Button>
                  }
                >
                  {u.previous}
                </Row>
              )}
            </Rows>
            {install.jobId && <JobLine jobId={install.jobId} />}
          </>
        )}
      </Loadable>
      {install.dialog}
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
            <ul className="divide-y divide-line border-y border-line text-sm" data-testid="backup-list">
              {list.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-2.5">
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
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
        <legend className="sr-only">{t('system.export')}</legend>
        {(['chats', 'memories', 'files'] as const).map((w) => (
          <label key={w} className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={what.includes(w)} onChange={(e) => setWhat(e.target.checked ? [...what, w] : what.filter((x) => x !== w))} />
            {t(`system.exportWhat.${w}`)}
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label={t('system.exportPassword')} hint={t('system.exportPasswordHint')}>
          <input className={`${inputCls} max-w-xs`} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
      </div>
      <Button
        className="mt-3"
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
