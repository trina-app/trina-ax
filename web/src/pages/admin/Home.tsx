// Admin Home (/admin): what needs attention first (an engine that is on but broken, or not set up while it is the
// team default; one line when no engine is set up; an engine at its limit when no people line says so; people who cannot use AI, an
// AI connection or a service to sign in again, a disk filling up, a failed server check), then one card per area with
// its state in a few words, each opening its page. It reads only what the admin pages already read, with the same
// ranges (Usage: the last 30 days, as Admin > Usage opens); an area that cannot be read says so on its card and the
// others still show. Diagnostics are the owner's (Admin > System), so only the owner's Home asks for them. The owner
// also gets the setup steps still to do (OwnerChecklist; it was on the chat Home before), or, while the welcome steps
// are unfinished, only "시작 설정 다시 보기" when the setup row was hidden (OwnerSetup, docs/DECISIONS.md "W5").
import { Activity, AlertTriangle, Cable, CheckCircle2, ChevronRight, Cpu, Gauge, Lock, Puzzle, ScrollText, Users, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { CredentialState, EngineStatus, Locale, UpdateStatus } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatRelative, formatShortDateTime, formatUsd, intlTag, localDay, localDayRange } from '../../lib/format'
import { turnWhen } from '../../lib/updateTurn'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { Badge, Button } from '../../components/ui'
import { actionLabel } from './Audit'
import { AdminPageHeader, useAction, useLoad } from './common'
import { JobLine, useUpdateInstall } from './jobs'
import { OwnerSetup } from './OwnerChecklist'
import { homeCheck, technicalEngineState } from './plain'

/** AI connection states an admin should act on (a member's own connection is theirs to fix, so team ones only) */
const CREDENTIAL_PROBLEMS: CredentialState[] = ['expiring', 'expired', 'invalid', 'needs_reconnect', 'over_limit']
/** an engine nobody set up: no program or API settings, or no sign-in or AI connection of its kind (the API engine's
 * not_logged_in is its key refused: set up, and broken) */
const notSetUp = (e: EngineStatus) => e.status === 'not_installed' || (e.status === 'not_logged_in' && e.id !== 'api')

const names = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '')

/** After-update to-dos this client has text for (server/src/system/after-update.ts sends ids; unknown ones are not shown) */
const AFTER_UPDATE_IDS = ['hwp-plugin']

/** Where in the day a window starts, for the words: dawn (before 06:00), night (18:00 on), else the day. */
const partOfDay = (window: string) => {
  const h = +window.slice(0, 2)
  return h < 6 ? 'dawn' : h >= 18 ? 'night' : 'day'
}

/** When a release waiting for this server's turn in its staged roll-out installs (turnAt), in the day words of an
 * ordinary automatic update, with the date when it is further away than tomorrow; null when it cannot be said. */
function turnLine(t: (k: MessageKey, v?: Record<string, string | number>) => string, locale: Locale, u: UpdateStatus): string | null {
  if (!u.turnAt || !u.window || !u.timeZone) return null
  const w = turnWhen(u.turnAt, u.window, u.timeZone)
  if (!w) return null
  const window = u.window.replace('-', '–')
  const date = new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(w.date)
  return t(`adminHome.when.${w.day}.${partOfDay(u.window)}` as MessageKey, { window, date })
}

/** What the Home item says about a new version: when it installs by itself, that the timer does it, or that nothing will. */
function updateLine(t: (k: MessageKey, v?: Record<string, string | number>) => string, locale: Locale, u: UpdateStatus, version: string) {
  if (u.needsRoot) {
    if (u.hold === 'root_failed') return t('adminHome.update.rootFailed', { version })
    // the update timer keeps the staged roll-out too (turnAt): on this server's turn, or never by itself (null: the
    // command then)
    if (!u.auto || u.turnAt === null) return t('adminHome.update.rootManual', { version })
    const when = turnLine(t, locale, u)
    return when ? t('adminHome.update.rootAt', { version, when }) : t('adminHome.update.root', { version })
  }
  if (!u.auto || u.nextWindow === null) return t('adminHome.update.off', { version })
  if (u.hold === 'rollout') {
    // this server's turn in the staged roll-out (server/src/system/rollout.ts), when the server says when; null: this
    // release's roll-out never reaches this server by itself (Install now still does)
    if (u.turnAt === null) return t('adminHome.update.rolloutNever', { version })
    const when = turnLine(t, locale, u)
    return when ? t('adminHome.update.rolloutAt', { version, when }) : t('adminHome.update.rollout', { version })
  }
  if (u.hold === 'failed' || u.hold === 'root_failed') return t('adminHome.update.failed', { version })
  const n = u.nextWindow
  const window = u.window ? u.window.replace('-', '–') : ''
  const when = !u.window || !n ? t('adminHome.when.window')
    : n.day === 'now' ? t('adminHome.when.now')
    : t(`adminHome.when.${n.day}.${partOfDay(u.window)}` as MessageKey, { window })
  return t('adminHome.update.auto', { version, when })
}

type State<T> = { data: T | null; error: string | null }
const settled = (...s: State<unknown>[]) => s.every((x) => x.data !== null || x.error !== null)

export default function Home() {
  const t = useT()
  const locale = useLocale()
  const owner = isOwner(useMeStrict())
  // "No AI": the people who cannot use any AI connection now (the same list as Admin › Members)
  const users = useLoad(() => api.call(API.listUsers, { query: { noAi: '1' } }))
  const invites = useLoad(async () => (await api.call(API.listInvites)).items)
  const engines = useLoad(() => api.call(API.engines))
  const credentials = useLoad(async () => (await api.call(API.listCredentials)).items.filter((c) => c.scope === 'team'))
  const services = useLoad(async () => (await api.call(API.listTeamIntegrations)).items)
  const plugins = useLoad(async () => (await api.call(API.listPlugins)).installed)
  const usage = useLoad(() => api.call(API.usage, { query: { groupBy: 'user', ...localDayRange(localDay(new Date(Date.now() - 29 * 86400_000)), localDay(new Date())) } }))
  const audit = useLoad(async () => (await api.call(API.audit, { query: { limit: 3 } })).items)
  const storage = useLoad(() => api.call(API.storage))
  const diagnostics = useLoad(async () => (owner ? (await api.call(API.diagnostics)).checks : []), [owner])
  // A new version (the owner's; Admin > System installs it). Never blocks Home: no `settled`, and an error is no item.
  // Office mode has its own banner and update card, so it is skipped there (the office status is null outside it).
  const update = useLoad(async () => (owner ? { u: await api.call(API.updateStatus) } : { u: null }), [owner])
  const office = useLoad(async () => (owner ? { v: await api.call(API.officeUpdateStatus) } : { v: null }), [owner])

  // What a release left for an admin to do (server/src/system/after-update.ts); not needed for Home to show.
  const after = useLoad(async () => (await api.call(API.afterUpdateActions)).items)
  const navigate = useNavigate()
  const act = useAction()

  const item = (name: string, state: string) => t('adminHome.item', { name, state })
  const active = users.data?.items.filter((u) => u.status === 'active') ?? []
  const noAiPeople = users.data ? users.data.items.filter((u) => users.data?.noAi?.includes(u.id)) : []
  const noAi = noAiPeople.map((u) => u.name)
  // every one of them only waits for a limit to end (noAiUntil): the line says until when (the last end: all have AI then)
  const noAiEnds = noAiPeople.map((u) => users.data?.noAiUntil?.[u.id])
  const noAiEnd = noAiEnds.length && noAiEnds.every(Boolean) ? (noAiEnds as string[]).sort().at(-1) : undefined
  const openInvites = invites.data?.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > Date.now()).length ?? 0
  // An engine that is on but never set up (notSetUp) is not a problem while another engine is set up (answers, or only
  // waits for a limit to end): a team on Claude alone has nothing to fix. It is when it is the team default; when no
  // engine is set up at all, one line says so instead of one per engine. A broken engine (error, a refused API key)
  // always has its own line. A connection that stopped working has its own line
  // below (badCredentials).
  const onEngines = engines.data?.engines.filter((e) => e.enabled) ?? []
  // an untested version or a failed lockdown test still answers: Diagnostics says it (plain.ts), Home does not
  const anyEngineSetUp = onEngines.some((e) => e.status === 'ok' || e.status === 'limited' || technicalEngineState(e.status))
  const badEngines = onEngines.filter((e) => e.status !== 'ok' && e.status !== 'limited' && !technicalEngineState(e.status)
    && (notSetUp(e) ? anyEngineSetUp && e.id === engines.data?.defaultEngine : true))
  const noEngine = !!engines.data && !anyEngineSetUp && onEngines.some(notSetUp)
  // An engine at its limit: the people line (or a credential over its limit) already says it; else one line of its own.
  const limitCovered = noAi.length > 0 || (credentials.data ?? []).some((c) => !c.disabled && c.state === 'over_limit')
  const limitedEngines = limitCovered ? [] : onEngines.filter((e) => e.status === 'limited')
  const badCredentials = credentials.data?.filter((c) => !c.disabled && CREDENTIAL_PROBLEMS.includes(c.state)) ?? []
  const badServices = services.data?.filter((s) => s.status !== 'connected') ?? []
  const storageBad = !!storage.data && (storage.data.level !== 'ok' || storage.data.writesRefused)
  // only the checks an admin can act on (plain.ts homeCheck); the server's internals are in Diagnostics alone
  const failedChecks = diagnostics.data?.filter((c) => c.status === 'fail' && homeCheck(c)) ?? []
  const checksToLook = diagnostics.data?.filter((c) => (c.status === 'fail' || c.status === 'warn') && homeCheck(c)) ?? []
  const allChecksOk = !!diagnostics.data?.every((c) => c.status !== 'fail' && c.status !== 'warn')

  const upd = update.data?.u
  const newVersion = upd && !upd.managed && office.data && !office.data.v ? upd.available?.version : undefined
  // "Install now" is the same install as Admin > System's (jobs.tsx); not when the release needs root (the timer does it)
  const install = useUpdateInstall({ version: newVersion, onDone: () => void update.reload() })
  // by hand it works when automatic updates are off or will not install it (a window that never opens, not this server's turn, on hold)
  const canInstall = !!newVersion && !upd?.needsRoot && (!upd?.auto || upd.nextWindow === null || upd.hold === 'rollout' || upd.hold === 'failed')

  const attention: { key: string; text: string; to: string; actions?: ReactNode; job?: string | null }[] = [
    ...badEngines.map((e) => ({ key: `engine-${e.id}`, text: item(e.label, t(`engines.status.${e.status}`)), to: '/admin/providers' })),
    ...(noEngine ? [{ key: 'no-engine', text: t('adminHome.noEngine'), to: '/admin/providers' }] : []),
    ...limitedEngines.map((e) => ({ key: `engine-${e.id}`, to: '/admin/providers', text: e.limitedUntil
      ? t('adminHome.engineLimit', { name: e.label, time: formatShortDateTime(e.limitedUntil, locale) })
      : t('adminHome.engineLimitNoTime', { name: e.label }) })),
    ...(noAi.length ? [{ key: 'no-ai', to: '/admin/providers', text: noAiEnd
      ? t('adminHome.noAiLimit', { count: noAi.length, names: names(noAi), time: formatShortDateTime(noAiEnd, locale) })
      : t('adminHome.noAi', { count: noAi.length, names: names(noAi) }) }] : []),
    ...badCredentials.map((c) => ({ key: `credential-${c.id}`, text: item(c.label, t(`credentials.state.${c.state}`)), to: '/admin/providers?engine=claude-code' })),
    ...badServices.map((s) => ({ key: `service-${s.id}`, text: item(s.name, t(`integrations.status.${s.status}`)), to: '/admin/connectors' })),
    ...(storageBad && storage.data ? [{ key: 'storage', text: t('adminHome.storage', { percent: Math.round(storage.data.percent) }), to: '/admin/system' }] : []),
    ...failedChecks.map((c) => ({ key: `check-${c.id}`, text: c.label, to: '/admin/system' })),
    ...(newVersion && upd ? [{
      key: 'update', text: updateLine(t, locale, upd, newVersion), to: '/admin/system', job: install.jobId,
      actions: canInstall ? <Button size="sm" variant="primary" disabled={!!install.jobId} onClick={() => install.ask('update')} data-testid="home-update-install">{t('adminHome.update.install')}</Button> : undefined,
    }] : []),
    ...(after.data ?? []).filter((a) => AFTER_UPDATE_IDS.includes(a.id)).map((a) => ({
      key: `after-${a.id}`, text: t(`adminHome.after.${a.id}` as MessageKey), to: a.to,
      actions: (
        <>
          <Button size="sm" variant="primary" onClick={() => navigate(a.to)} data-testid={`home-after-${a.id}-go`}>{t(`adminHome.after.${a.id}.go` as MessageKey)}</Button>
          <Button size="sm" variant="ghost" onClick={() => void act(async () => { await api.call(API.dismissAfterUpdate, { params: { id: a.id }, body: {} }); return null }).then((r) => { if (r !== undefined) void after.reload() })} aria-label={t('adminHome.after.dismiss.label', { todo: t(`adminHome.after.${a.id}` as MessageKey) })} data-testid={`home-after-${a.id}-dismiss`}>{t('adminHome.after.dismiss')}</Button>
        </>
      ),
    })),
  ]
  const ready = settled(users, engines, credentials, services, storage, diagnostics)
  // A source of the list above that did not load: the list may miss something, so Home never says all is well then
  const unchecked = [users, engines, credentials, services, storage, diagnostics].some((s) => s.error !== null)
  const defaultEngine = engines.data?.engines.find((e) => e.id === engines.data?.defaultEngine)?.label
  const latest = audit.data?.[0]

  return (
    <div className="space-y-8" data-testid="admin-home">
      <AdminPageHeader title={t('admin.home')} className="!mb-0" still />
      {ready && (
        <section aria-labelledby="admin-home-attention">
          {attention.length ? (
            <>
              <h2 id="admin-home-attention" className="mb-2 text-sm font-semibold">
                {t('adminHome.attention')}
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" data-testid="admin-attention">
                {attention.map((a) => (
                  <li key={a.key}>
                    {a.actions ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm" data-testid={`attention-${a.key}`}>
                        <AlertTriangle size={15} className="shrink-0 text-warn" aria-hidden />
                        <Link to={a.to} className="min-w-0 flex-1 basis-60 rounded hover:underline">{a.text}</Link>
                        <span className="flex shrink-0 items-center gap-2">{a.actions}</span>
                        {a.job && <div className="basis-full"><JobLine jobId={a.job} /></div>}
                      </div>
                    ) : (
                      <Link to={a.to} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover focus-visible:-outline-offset-2" data-testid={`attention-${a.key}`}>
                        <AlertTriangle size={15} className="shrink-0 text-warn" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{a.text}</span>
                        <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              {unchecked && <p className="mt-2 text-xs text-muted" data-testid="admin-not-all-checked">{t('adminHome.notAllChecked.more')}</p>}
            </>
          ) : unchecked ? (
            <h2 id="admin-home-attention" className="flex items-center gap-2 text-sm text-warn" data-testid="admin-not-all-checked">
              <AlertTriangle size={16} aria-hidden /> {t('adminHome.notAllChecked')}
            </h2>
          ) : (
            <h2 id="admin-home-attention" className="flex items-center gap-2 text-sm text-muted" data-testid="admin-all-good">
              <CheckCircle2 size={16} className="text-ok" aria-hidden /> {t('adminHome.allGood')}
            </h2>
          )}
        </section>
      )}

      {owner && <OwnerSetup />}

      <section aria-labelledby="admin-home-areas">
        <h2 id="admin-home-areas" className="mb-2 text-sm font-semibold">
          {t('adminHome.areas')}
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Area id="members" to="/admin/members" icon={Users} title={t('admin.members')} state={users}
            line={t('adminHome.members', { count: active.length }) + (openInvites ? ` · ${t('adminHome.invites', { count: openInvites })}` : '')}
            meta={names(active.map((u) => u.name))}
          />
          {/* the engines and the accounts they use are one page (AI providers) */}
          <Area id="providers" to="/admin/providers" icon={Cpu} title={t('admin.providers')} state={engines} problems={badEngines.length + (noEngine ? 1 : 0) + limitedEngines.length + badCredentials.length + (noAi.length ? 1 : 0)}
            line={[defaultEngine && t('adminHome.default', { engine: defaultEngine }), t('adminHome.connections', { count: credentials.data?.length ?? 0 })].filter(Boolean).join(' · ')}
            meta={names(engines.data?.engines.filter((e) => e.enabled).map((e) => e.label) ?? [])}
          />
          <Area id="integrations" to="/admin/connectors" icon={Cable} title={t('admin.integrations')} state={services} problems={badServices.length}
            line={t('adminHome.services', { count: services.data?.length ?? 0 })}
            meta={names(services.data?.map((s) => s.name) ?? [])}
          />
          <Area id="plugins" to="/admin/plugins" icon={Puzzle} title={t('admin.plugins')} state={plugins}
            line={t('adminHome.plugins', { count: plugins.data?.length ?? 0 })}
            meta={names(plugins.data?.filter((p) => p.enabled).map((p) => p.name) ?? [])}
          />
          <Area id="usage" to="/admin/usage" icon={Gauge} title={t('admin.usage')} state={usage}
            line={usage.data ? `${t('adminHome.answers', { count: usage.data.totals.turns })} · ${formatUsd(usage.data.totals.costUsd, locale)}` : ''}
            meta={t('adminHome.last30')}
          />
          <Area id="audit" to="/admin/audit" icon={ScrollText} title={t('admin.audit')} state={audit}
            line={latest ? [latest.actor?.name, actionLabel(t, latest)].filter(Boolean).join(' · ') : t('adminHome.noActivity')}
            meta={latest ? formatRelative(latest.at, locale) : ''}
          />
          <Area id="system" to="/admin/system" icon={Activity} title={t('admin.system')} state={storage} problems={(storageBad ? 1 : 0) + checksToLook.length}
            line={storage.data ? t('adminHome.storage', { percent: Math.round(storage.data.percent) }) : ''}
            meta={owner && diagnostics.data ? (checksToLook.length ? names(checksToLook.map((c) => c.label)) : allChecksOk ? t('adminHome.checksOk') : '') : ''}
          />
        </div>
      </section>

      <p className="flex items-center gap-2 text-xs text-faint">
        <Lock size={13} aria-hidden /> {t('admin.privacy')}
      </p>
      {install.dialog}
    </div>
  )
}

/** One area: icon, name, its state in one line and a quieter second one; a chip when something there needs attention. */
function Area({ id, to, icon: Icon, title, state, line, meta, problems = 0 }: { id: string; to: string; icon: LucideIcon; title: string; state: State<unknown>; line: ReactNode; meta?: ReactNode; problems?: number }) {
  const t = useT()
  return (
    <Link to={to} className="group flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-4 transition hover:bg-hover" data-testid={`admin-home-${id}`}>
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-muted group-hover:text-ink" aria-hidden>
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {problems > 0 && <Badge tone="warn">{t('adminHome.toFix', { count: problems })}</Badge>}
        </span>
        {state.error ? (
          <span className="mt-0.5 block truncate text-sm text-faint">{t('adminHome.unavailable')}</span>
        ) : state.data === null ? (
          <span className="mt-1.5 block h-3 w-32 animate-pulse rounded bg-subtle" />
        ) : (
          <>
            {line && <span className="mt-0.5 block truncate text-sm text-muted">{line}</span>}
            {meta && <span className="mt-0.5 block truncate text-xs text-faint">{meta}</span>}
          </>
        )}
      </span>
      <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
    </Link>
  )
}
