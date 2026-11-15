// System: owner = storage, version and updates, health, connection, connected folders, backups, export; an admin =
// the plan, storage and (office mode) the automatic updates. Laid out like a settings document (Team settings): plain
// sections under headings, label / value rows, long explanations behind "Learn more"; no boxes. Update, restore and
// connection changes ask for the password again. Long work runs as a job with progress from the WebSocket.
// On a phone (below 768 px; QA TC-269) the page is a list of its parts, each its own page at /admin/system/<group>
// (systemGroups.ts), with a short state on each row; the parts stay mounted while another shows, so a backup or an
// export keeps its progress and the list its states. What needs the server computer (a folder path on it, the
// connection mode, an update by its command) says "컴퓨터에서 설정해요" there (QA TC-270). A backup is a list row there: the
// date and size, the kind under it, Restore on the right. Computers keep the one page.
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { CheckCircle2, CircleAlert, CircleHelp, CircleX, Download, FolderSync, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import clsx from 'clsx'
import { settingDesc, settingName } from '../../components/settings/SettingRow'
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import type { ConnectionMode, LastRestore, PlanStatus } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatRelative, formatSize } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, CopyButton, ErrorNote, Field, Modal, confirmDialog, inputCls, useMediaQuery } from '../../components/ui'
import { PhoneListGroup, PhoneListRow } from '../../components/phone/PhoneList'
import { AdminPageHeader, BarTitleProvider, Card, FlatCardsProvider, Loadable as CardLoadable, ReauthDialog, useAction, useActionOk, useLoad, useReauthCall } from './common'
import { systemGroup, systemGroups, type SystemGroupId } from './systemGroups'
import { forgetKeptChecks } from './overview'
import OfficeUpdate from './OfficeUpdate'
import { engineVersionChecks } from './plain'
import { JobLine, useJobRunner, useUpdateInstall } from './jobs'
import { ReleaseNotes } from '../../components/ReleaseNotes'
import { isOwner, useMeStrict } from '../../store/session'
import { safeHref } from '../../lib/safeLinks'
import { noPurchaseLinks } from '../../lib/desktop'
import { addressToTell, teamAddressShown } from '../../lib/team-address'
import { goBackOffered, releaseCannotRead, releasePaused } from '../../lib/updateOutcome'
import { Tooltip } from '../../components/Tooltip'

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

/** Label / value rows (a definition list): the label on the left, the value next to it, an action on the right. On a
 * phone (below 768 px) the value sits at the right end of the row, like a phone's Settings › About; a `long` one (an
 * address, a sentence, a state with its details) goes under the label instead. */
function Rows({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return <dl className={`divide-y divide-line text-sm ${className ?? ''}`} data-testid={testId}>{children}</dl>
}
function Row({ label, children, action, testId, long }: { label: ReactNode; children: ReactNode; action?: ReactNode; testId?: string; long?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 md:flex-nowrap md:gap-x-6" data-testid={testId}>
      <dt className={clsx('text-muted md:w-40 md:shrink-0', long ? 'max-md:basis-full' : 'max-md:max-w-[50%] max-md:shrink-0')}>{label}</dt>
      <dd className={clsx('min-w-0 flex-1', !long && 'max-md:text-right max-md:break-words')}>{children}</dd>
      {action && <dd className="shrink-0">{action}</dd>}
    </div>
  )
}

const PHONE = '(max-width: 767.98px)'

/** A group's state on a phone's list row: a short value on the right, or a badge when it needs a look. */
type RowNote = { value?: string; badge?: { text: string; tone: 'warn' | 'danger' | 'accent' } }
type SetNote = (id: SystemGroupId, note: RowNote | null) => void
/** The phone's list, told by each part what to say on its row (none on a computer: there is no list). */
const RowNotes = createContext<SetNote | null>(null)

/** Tell a phone's list what this group's row says (null: nothing yet). */
function useRowNote(id: SystemGroupId, note: RowNote | null) {
  const set = useContext(RowNotes)
  const key = note ? JSON.stringify(note) : null
  useEffect(() => {
    set?.(id, key ? (JSON.parse(key) as RowNote) : null)
  }, [set, id, key])
  useEffect(() => () => set?.(id, null), [set, id])
}

/** A phone in place of a computer's form (QA TC-270): "컴퓨터에서 설정해요" and what is done there. */
function OnComputer({ text, testId, className = 'mt-4' }: { text: string; testId: string; className?: string }) {
  const t = useT()
  return (
    <div className={className} data-testid={testId}>
      <p className={settingName}>{t('admin.onComputer')}</p>
      <p className={clsx('mt-0.5', settingDesc)}>{text}</p>
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
      <button type="button" aria-expanded={open} className="touch-hit font-medium whitespace-nowrap text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)}>
        {t(open ? 'common.less' : 'teamSettings.learnMore')}
      </button>
      <span hidden={!open} className="mt-2 block max-w-prose text-xs leading-relaxed text-faint">{long}</span>
    </>
  )
}

/** office mode: the installation's automatic updates (docs/OFFICE.md "자동 업데이트") instead of the production
 * updater's section; v null = not office mode, an error (older server) = the production section */
const useOffice = () => useLoad(async () => ({ v: await api.call(API.officeUpdateStatus) }))
type Office = ReturnType<typeof useOffice>

export default function System() {
  const t = useT()
  const me = useMeStrict()
  const loads = useLoadReport()
  const office = useOffice()
  // a phone: the list of the groups (no `sub`) or one group's page (systemGroups.ts); a computer: the one page
  const phone = useMediaQuery(PHONE)
  const sub = useParams().sub
  // an admin's updates are office mode's: known once its status has loaded
  const officeKnown = !!office.data || !!office.error
  const who = { owner: isOwner(me), features: me.server.features, office: officeKnown ? !!office.data?.v : undefined }
  const group = phone ? systemGroup(sub, who) : undefined
  // a computer opened at /admin/system/<group> lands at /admin/system#system-<group> (systemRedirect): that part in view
  const hash = useLocation().hash
  const hashPart = hash.startsWith('#system-') ? (hash.slice('#system-'.length) as SystemGroupId) : undefined
  const list = phone && !group
  const [notes, setNotes] = useState<Partial<Record<SystemGroupId, RowNote>>>({})
  const setNote = useCallback<SetNote>((id, note) => {
    setNotes((m) => {
      if (JSON.stringify(m[id] ?? null) === JSON.stringify(note)) return m
      const { [id]: _old, ...rest } = m
      return note ? { ...rest, [id]: note } : rest
    })
  }, [])
  // a group this person does not have (an admin's updates outside office mode): the list
  if (phone && sub && !group) return <Navigate to="/admin/system" replace />
  // the sections stay mounted while hidden, so they can report that they loaded again after a retry
  return (
    <LoadReport.Provider value={loads.report}>
      <RowNotes.Provider value={phone ? setNote : null}>
        <FlatCardsProvider value>
          {/* a phone's group says its name in the bar; its section keeps it for screen readers (BarTitle) */}
          <BarTitleProvider value={group ? t(group.label) : null}>
            {!group && <AdminPageHeader title={t('admin.system')} />}
            {loads.allFailed && <AllFailed detail={loads.firstError} onRetry={() => void loads.reloadAll()} />}
            {list && !loads.allFailed && (
              // the page's parts, each its own page, with its state on the right; the list reaches the screen's edges
              <div className="-mx-4 -mt-4" data-testid="system-list">
                <PhoneListGroup>
                  {systemGroups({ ...who, office: !!office.data?.v }).map((g) => {
                    const n = notes[g.id]
                    return (
                      <PhoneListRow key={g.id} icon={<g.icon size={16} />} title={t(g.label)} to={`/admin/system/${g.id}`} value={n?.value}
                        badge={n?.badge ? <Badge tone={n.badge.tone}>{n.badge.text}</Badge> : undefined} testId={`system-row-${g.id}`} />
                    )
                  })}
                </PhoneListGroup>
              </div>
            )}
            <div hidden={loads.allFailed || list} className="max-w-3xl" data-testid="system-page" data-group={group?.id}>
              <SystemSections office={office} shown={phone ? (group?.id ?? null) : undefined} focus={phone ? undefined : hashPart} />
            </div>
          </BarTitleProvider>
        </FlatCardsProvider>
      </RowNotes.Provider>
    </LoadReport.Provider>
  )
}

/** A computer's one page opened at /admin/system/<group> (a link such as the apps dialog's "Turn on connection"; it
 * arrives as #system-<group>, systemRedirect): that part scrolled to the top. The parts above it load on their own and change height, so it is put in view again while
 * they settle (about two seconds), unless the person scrolls first. */
function useScrollToPart(focus: SystemGroupId | undefined) {
  useEffect(() => {
    if (!focus) return
    let stop = false
    const go = () => {
      if (stop) return
      // the part's card carries the id system-<group> (Card's scroll-mt keeps it clear of the sticky header)
      document.getElementById(`system-${focus}`)?.scrollIntoView({ block: 'start' })
    }
    const timers = [0, 300, 800, 1600].map((ms) => setTimeout(go, ms))
    const off = () => { stop = true }
    window.addEventListener('wheel', off, { passive: true, once: true })
    window.addEventListener('touchstart', off, { passive: true, once: true })
    window.addEventListener('keydown', off, { once: true })
    return () => {
      stop = true
      timers.forEach(clearTimeout)
      window.removeEventListener('wheel', off)
      window.removeEventListener('touchstart', off)
      window.removeEventListener('keydown', off)
    }
  }, [focus])
}

/** `shown`: a phone's group on screen (null: the list, none shown); undefined: a computer's one page, as it was.
 * `focus`: a computer's page opened at one group's address: that part is scrolled into view. */
function SystemSections({ office, shown, focus }: { office: Office; shown: SystemGroupId | null | undefined; focus?: SystemGroupId }) {
  useScrollToPart(focus)
  const me = useMeStrict()
  // a finished backup changes the health section's "last backup" line
  const [rev, setRev] = useState(0)
  // what this deployment offers (server/src/system/deployment.ts; absent from older servers = everything)
  const features = me.server.features
  // a phone: each group in a box of its own, shown on its page only; a computer: the sections as they were
  const part = (id: SystemGroupId, node: ReactNode) =>
    shown === undefined ? node : <div hidden={shown !== id} data-testid={`system-group-${id}`}>{node}</div>
  // an admin: the plan, the storage use, and (office mode) the automatic updates
  if (!isOwner(me)) return (
    <>
      {part('storage', <><PlanCard /><Storage /></>)}
      {office.data?.v ? part('updates', <OfficeUpdate status={office.data.v} reload={office.reload} />) : null}
    </>
  )
  // the owner: what the team sees first (the plan, the space), then the version, the server's health, how the team
  // reaches it, and the tools (connected folders, backups, export)
  return (
    <>
      {part('storage', <><PlanCard /><Storage /></>)}
      {part('updates', office.data?.v ? <OfficeUpdate status={office.data.v} reload={office.reload} /> : (office.data || office.error) && <Update />)}
      {part('health', <Health rev={rev} />)}
      {part('connection', <Connection canChange={features?.connectionChange !== false} />)}
      {features?.connectedFolders !== false && part('connected', <ConnectedFolders />)}
      {part('backups', <Backups onChanged={() => setRev((r) => r + 1)} />)}
      {part('export', <Export />)}
    </>
  )
}

/** The server's checks (diagnostics): what needs attention first, each with its one line; the checks that passed fold
 * into one line with "Show details". The facts (server, queue, free space) as rows above. */
function Health({ rev }: { rev: number }) {
  const t = useT()
  const locale = useLocale()
  // with the engines whose version or lockdown test only shows here (Home and Providers leave it out, plain.ts); the
  // phone's Admin list keeps the checks for a minute (overview.tsx): this read makes those old
  const state = useLoad(async () => {
    const [d, e] = await Promise.all([api.call(API.diagnostics), api.call(API.engines).catch(() => null)])
    forgetKeptChecks()
    return e ? { ...d, checks: [...d.checks, ...engineVersionChecks(e.engines, t)] } : d
  }, [rev])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  // a phone's list: how many checks need a look (the ones listed first here), else that all passed
  const problems = state.data?.checks.filter((c) => c.status !== 'ok').length
  useRowNote('health', problems === undefined ? null : problems ? { badge: { text: t('adminHome.toFix', { count: problems }), tone: 'warn' } } : { value: t('system.check.ok') })
  return (
    <Card
      id="system-health"
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
                      <button type="button" aria-expanded={open} className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline max-md:min-h-11" onClick={() => setOpen(!open)} data-testid="health-details">
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
  // a phone's list: how full the disk is, as a warning past 80% or when writes stop (Admin's list says the same)
  const used = state.data ? `${Math.round(Math.min(100, Math.max(0, state.data.percent)))}%` : null
  const bad = !!state.data && (state.data.level !== 'ok' || state.data.writesRefused)
  useRowNote('storage', used === null ? null : bad ? { badge: { text: used, tone: state.data!.level === 'full' || state.data!.writesRefused ? 'danger' : 'warn' } } : { value: used })
  return (
    <Card id="system-storage" title={t('storage.title')}>
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
              {/* any kept bytes (KB under 1 MB): a small set-aside folder is still on the disk (QA TC-2284) */}
              {!!s.breakdown?.kept && s.breakdown.kept > 0 && <p className="text-xs text-faint" data-testid="storage-kept">{t('storage.kept', { size: formatSize(s.breakdown.kept, locale) })}</p>}
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
  const state = useLoad(() => api.call(API.plan))
  const p = state.data?.plan
  if (!p) return null
  return <PlanDetails plan={p} store={noPurchaseLinks()} />
}

/** The plan card's content. `store`: a store app (lib/desktop.ts noPurchaseLinks), which has no "Manage plan" link and
 * says a full plan as a fact, with no "change the plan"; the status and support links stay. */
export function PlanDetails({ plan: p, store }: { plan: NonNullable<PlanStatus['plan']>; store: boolean }) {
  const t = useT()
  const manage = store ? null : safeHref(p.links?.account)
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
        {p.maxActiveMembers !== null && p.activeMembers >= p.maxActiveMembers && <p className="text-xs text-warn" role="status">{t(store ? 'plan.membersFullStore' : 'plan.membersFull')}</p>}
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

/** The address the team reaches this server at, as far as the connection status knows it. */
const connAddress = (d: { address: string | null; publicAddress?: string | null } | null | undefined): string | null =>
  d?.address ?? (d?.publicAddress ? `https://${d.publicAddress}` : null)

function Connection({ canChange = true }: { canChange?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const state = useLoad(() => api.call(API.connection))
  const [change, setChange] = useState<{ mode: Mode; relayUrl: string; teamName: string; claimCode: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  // after a saved change that moves the team address (not a relay rename): the address to tell the team (QA TC-1232)
  // The new address is only known once the server has restarted and registered it, so the page waits for it: `waiting`
  // is the address before the change.
  const [tell, setTell] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)
  useEffect(() => {
    if (!waiting) return
    const stop = setTimeout(() => setWaiting(null), 5 * 60_000)
    // a failed read (the server is restarting) is ignored: the card keeps what it shows
    const poll = setInterval(() => { api.call(API.connection).then(state.setData, () => {}) }, 5000)
    return () => { clearTimeout(stop); clearInterval(poll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])
  useEffect(() => {
    const d = state.data
    const now = connAddress(d)
    if (!waiting || !teamAddressShown(now) || teamAddressShown(now) === teamAddressShown(waiting)) return
    setTell(addressToTell(waiting, now))
    setWaiting(null)
  }, [state.data, waiting])
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
  // the office network only: the address the team types, as Settings › 앱 shows it (GET /api/me team.address, the
  // office address with its port; QA TC-485)
  const me = useMeStrict()
  const officeAddress = state.data?.mode === 'direct-only' && !pub ? teamAddressShown(me.team.address) : null
  // a phone: the mode is changed on a computer (a relay's address, the claim code from the account console; QA TC-270)
  const phone = useMediaQuery(PHONE)
  const changes = canChange && modes.length > 1
  // a phone's list: the connection's state (none for the office network or a public address without the relay)
  const c0 = state.data
  useRowNote('connection', !c0 ? null : c0.mode === 'direct-only' ? { value: modeName(c0.mode) } : c0.state === 'connected' ? { value: t('system.conn.connected') } : { badge: { text: t(`system.conn.${c0.state}`), tone: c0.state === 'connecting' ? 'warn' : 'danger' } })
  return (
    // one mode only (office mode: the office network): nothing to change
    // the hosted cloud: the team address is managed by the hosting provider (no change button)
    <Card id="system-connection" title={t('system.connection')} actions={changes && !phone ? <Button size="sm" onClick={open}>{t('system.changeMode')}</Button> : undefined}>
      <Loadable state={state} lines={2}>
        {(c) => (
          <>
            <Rows>
              <Row label={t('system.mode')} long>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {/* no relay (the office network, or a public address): nothing is off for the team, so no "Off" badge
                      (QA TC-485) */}
                  {c.mode !== 'direct-only' && <Badge tone={c.state === 'connected' ? 'ok' : c.state === 'connecting' ? 'warn' : 'danger'}>{t(`system.conn.${c.state}`)}</Badge>}
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
              {(c.address ?? officeAddress) && (
                <Row label={t('system.address')} long>
                  <code className="break-all" data-testid="connection-address">{c.address ?? officeAddress}</code>
                </Row>
              )}
              {pub && (
                <Row label={t('system.publicAddress')} long>
                  <code className="break-all">https://{pub}</code>
                </Row>
              )}
            </Rows>
            {tell && (
              <div className="mt-3 flex min-w-0 items-center gap-2 border-l-2 border-warn pl-3 text-sm text-ink" role="status" data-testid="connection-tell-team">
                <span className="min-w-0 flex-1 break-words">{t('system.tellTeam', { address: tell })}</span>
                <CopyButton text={/^https?:\/\//.test(tell) ? tell : `https://${tell}`} showLabel className="shrink-0" />
              </div>
            )}
            {/* the server's own address has a country or network list, and an app posts in a room: services reach its
                /in/ addresses anyway (docs/DECISIONS.md "Apps posting in rooms", owner decision 8) */}
            {c.appsAnywhere && <p className="mt-2 text-xs text-muted" data-testid="connection-apps-anywhere">{t('roomApps.connectionAnywhere')}</p>}
            <p className="mt-2 text-xs text-faint">{c.direct.enabled ? t('system.directOn', { port: c.direct.port }) : t('system.directOff')}</p>
            {c.direct.fingerprintSha256 && <p className="font-mono text-code-sm break-all text-faint">SHA-256 {c.direct.fingerprintSha256}</p>}
            {changes && phone && <OnComputer text={t('admin.onComputerConnection')} testId="connection-on-computer" />}
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
              setTell(null)
              setWaiting(connAddress(state.data))
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
  // a phone: a new folder is a path on the server computer ("/Volumes/…", Finder), set up there (QA TC-270)
  const phone = useMediaQuery(PHONE)
  useRowNote('connected', state.data ? (state.data.some((c) => c.lastStatus === 'error') ? { badge: { text: String(state.data.length), tone: 'warn' } } : state.data.length ? { value: String(state.data.length) } : null) : null)
  const syncing = !!state.data?.some((c) => c.syncing)
  // while a sync runs, look again every few seconds
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => void state.reload(), 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing])
  return (
    <Card id="system-connected" title={t('connected.title')} desc={<LearnMore short={t('connected.descShort')} long={t('connected.desc')} />}>
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
                    <Tooltip label={t('connected.remove')}>
                      <button type="button" aria-label={t('connected.remove')} className="touch-hit rounded p-1 text-faint hover:bg-hover hover:text-danger"
                        onClick={async () => {
                          if (!(await confirmDialog({ title: t('connected.removeTitle'), body: t('connected.removeBody', { name: c.name }), confirm: t('connected.remove'), danger: true }))) return
                          await actOk(() => api.call(API.removeConnected, { params: { id: c.id } }))
                          void state.reload() // also after a failure: a folder someone else removed goes from the list
                        }}>
                        <Trash2 size={15} />
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
            {/* top-aligned, so the hint under the path does not push the name field down; the button gets a label-high
                spacer to line up with the inputs */}
            {phone ? <OnComputer text={t('admin.onComputerFolder')} testId="connected-on-computer" /> : (
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
            )}
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
  const install = useUpdateInstall({ version: state.data?.available?.version, previous: state.data?.previous, running: state.data?.running, onDone: () => void state.reload() })
  const setAsk = install.ask
  // a phone: what is done on the server computer (its command, its installer) says so, without the command (QA TC-270)
  const phone = useMediaQuery(PHONE)
  // a phone's list: the version, or the new one waiting
  const u0 = state.data
  useRowNote('updates', !u0 ? null : u0.available && !u0.managed && !releasePaused(u0) && !releaseCannotRead(u0) ? { badge: { text: t('system.available', { version: u0.available.version }), tone: 'accent' } } : { value: u0.current })
  return (
    <Card id="system-updates" title={t('system.updates')}>
      <Loadable state={state} lines={2}>
        {(u) => (
          <>
            <Rows testId="system-update">
              <Row label={t('system.version')}>
                {u.current} · {t(u.channel === 'beta' ? 'teamSettings.beta' : 'teamSettings.stable')}
                {u.lastCheckedAt && <span className="block text-xs text-faint">{t('system.checked', { date: formatDateTime(u.lastCheckedAt, locale) })}</span>}
              </Row>
              {u.waiting && (u.running ?? 0) > 0 && (
                // an update (this server's own, or root's `mycel-ctl update`) waits for running tasks before the restart;
                // this server's own can go on now
                <Row label={t('system.row.status')} long action={u.waiting.skippable ? (
                  <Button size="sm" variant="secondary" onClick={() => setAsk('anyway')} data-testid="update-waiting-anyway">{t('system.updateAnyway')}</Button>
                ) : undefined}>
                  <span className="font-medium" data-testid="update-waiting">{t('system.updateWaiting', { count: u.running ?? 0 })}</span>
                </Row>
              )}
              {u.managed ? (
                // the hosted cloud: the hosting provider installs updates during the maintenance window (no buttons here)
                <Row label={t('system.row.status')} long>
                  <span className="text-muted" data-testid="update-managed">{t('system.updateManaged')}</span>
                </Row>
              ) : u.available ? (
                <Row
                  label={t('system.row.status')}
                  long
                  action={
                    // a paused release, or one that cannot open this server's data: the server refuses it, so no
                    // button (Admin › Home says the same; QA TC-361)
                    u.needsRoot || releasePaused(u) || releaseCannotRead(u) ? undefined : (
                      <Button variant="primary" size="sm" disabled={!!install.jobId} onClick={() => setAsk('update')}>
                        <Upload size={14} aria-hidden /> {t('system.installUpdate')}
                      </Button>
                    )
                  }
                >
                  {releasePaused(u) ? <span className="font-medium" data-testid="update-paused">{t('adminHome.update.paused', { version: u.available.version })}</span>
                    : releaseCannotRead(u) ? <span className="font-medium" data-testid="update-cannot-read">{t('adminHome.update.cannotRead', { version: u.available.version })}</span>
                    : <span className="font-medium">{t('system.available', { version: u.available.version })}</span>}
                  <ReleaseNotes notes={u.available.notes} />
                  {u.available.needsBackupRestoreToRollBack && <span className="mt-1 block text-xs text-warn">{t('system.oneWay')}</span>}
                  {u.needsRoot && !releasePaused(u) && !releaseCannotRead(u) && (phone ? <OnComputer className="mt-2" text={t('admin.onComputerUpdate')} testId="update-on-computer" />
                    : <span className="mt-1 block text-xs text-warn" data-testid="update-needs-root">{t('system.updateNeedsRoot')}</span>)}
                </Row>
              ) : (
                <Row label={t('system.row.status')} long>
                  {u.feed === false ? (phone ? <><span className="text-muted">{t('system.noFeedShort')}</span><OnComputer className="mt-2" text={t('admin.onComputerNoFeed')} testId="update-on-computer" /></>
                    : <span className="text-muted"><LearnMore short={t('system.noFeedShort')} long={t('system.noFeed')} /></span>) : <span className="text-muted" data-testid={u.checkFailed ? 'update-check-failed' : undefined}>{t(u.checkFailed ? 'system.checkFailed' : 'system.upToDate')}</span>}
                </Row>
              )}
              {u.auto && !u.managed && (
                <Row label={t('system.row.auto')} long action={<Link to="/admin/settings#ts-time" className="text-xs font-medium text-accent-text underline-offset-2 hover:underline">{t('system.updateWindowLink')}</Link>}>
                  <span className="text-muted">{t('system.autoOn')}</span>
                </Row>
              )}
              {u.previous && !u.managed && (
                // no Go back to a version that cannot read the database this one migrated: it would only bounce back
                // (QA TC-336); the row says how to go back instead
                <Row
                  label={t('system.row.previous')}
                  long={!!u.previousNeedsRestore}
                  action={
                    !goBackOffered(u) ? undefined : (
                      <Button size="sm" variant="ghost" disabled={!!install.jobId} onClick={() => setAsk('rollback')}>
                        <RotateCcw size={14} aria-hidden /> {t('system.rollbackShort')}
                      </Button>
                    )
                  }
                >
                  {u.previous}
                  {u.previousNeedsRestore && (
                    <span className="mt-1 block text-xs text-muted" data-testid="previous-needs-restore">
                      {t('system.previousNeedsRestore', { version: u.previous })}
                    </span>
                  )}
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

/** The last restore in one line: which backup (by when it was made), when it was put back and by whom, or that it failed
 * and the data was kept. */
function LastRestoreLine({ last }: { last: LastRestore }) {
  const t = useT()
  const locale = useLocale()
  const vars = { at: formatDateTime(last.at, locale), backup: last.backupCreatedAt ? formatDateTime(last.backupCreatedAt, locale) : last.backupId, name: last.by?.name ?? '' }
  const text = !last.ok ? t('system.lastRestoreFailed', vars) : last.by ? t('system.lastRestore', vars) : t('system.lastRestoreNoName', vars)
  return (
    <p className={`mb-2 flex items-start gap-1.5 text-sm ${last.ok ? 'text-muted' : 'text-warn'}`} data-testid="last-restore">
      <RotateCcw size={14} className="mt-0.5 shrink-0" aria-hidden /> {text}
    </p>
  )
}

function Backups({ onChanged }: { onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const reauth = useReauthCall()
  // the backups, and the last restore said once the server is back (which backup, when, by whom; QA TC-208)
  const state = useLoad(() => api.call(API.listBackups))
  const runner = useJobRunner()
  const [restore, setRestore] = useState<{ id: string; createdAt: string } | null>(null)
  const phone = useMediaQuery(PHONE)
  // a phone's list: when the last backup was made
  const latest = state.data?.items.reduce<string | null>((m, b) => (!m || b.createdAt > m ? b.createdAt : m), null)
  useRowNote('backups', latest ? { value: formatRelative(latest, locale) } : null)
  return (
    <Card
      id="system-backups"
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
      {state.data?.lastRestore && <LastRestoreLine last={state.data.lastRestore} />}
      <Loadable state={state}>
        {({ items: list }) =>
          !list.length ? (
            <p className="text-sm text-faint">{t('system.noBackups')}</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line text-sm" data-testid="backup-list">
              {list.map((b) => phone ? (
                // a phone: a list row, the date and size on the first line, what kind of backup under it, Restore on the
                // right (in one line the badges and the button left the date one word per line)
                <li key={b.id} className="flex items-center gap-3 py-2.5" data-testid="backup-row">
                  <div className="min-w-0 flex-1">
                    <p data-testid="backup-when">
                      {formatDateTime(b.createdAt, locale)} <span className="text-xs whitespace-nowrap text-faint">· {formatSize(b.size, locale)}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap gap-1.5" data-testid="backup-badges">
                      <Badge>{t(`system.backupKind.${b.kind}`)}</Badge>
                      <Badge tone="neutral">{t(`system.backupScope.${b.scope}`)}</Badge>
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" className="shrink-0" disabled={!!runner.jobId} onClick={() => setRestore({ id: b.id, createdAt: b.createdAt })}>
                    {t('system.restore')}
                  </Button>
                </li>
              ) : (
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
            // a wrong password stays in the dialog, under the field (QA TC-221); it closes once the restore started
            const r = await reauth(() => api.call(API.startRestore, { body: { password, backupId: restore.id } }))
            if (r && 'refused' in r) return r.refused
            setRestore(null)
            if (!r) return
            await runner.run(
              async () => r.value,
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
    <Card id="system-export" title={t('system.export')} desc={t('system.exportDesc')}>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
        <legend className="sr-only">{t('system.export')}</legend>
        {(['chats', 'memories', 'files'] as const).map((w) => (
          <label key={w} className="inline-flex items-center gap-1.5 text-sm max-md:min-h-11">
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
