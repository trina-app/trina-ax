// Admin Home (/admin): what needs attention first (an engine that is on but not working, people who cannot use AI, an
// AI connection or a service to sign in again, a disk filling up, a failed server check), then one card per area with
// its state in a few words, each opening its page. It reads only what the admin pages already read, with the same
// ranges (Usage: the last 30 days, as Admin > Usage opens); an area that cannot be read says so on its card and the
// others still show. Diagnostics are the owner's (Admin > System), so only the owner's Home asks for them.
import { Activity, AlertTriangle, Cable, CheckCircle2, ChevronRight, Cpu, Gauge, KeyRound, Lock, Puzzle, ScrollText, Users, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CredentialState } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatRelative, formatUsd, localDay, localDayRange } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { Badge } from '../../components/ui'
import { actionLabel } from './Audit'
import { useLoad } from './common'

/** AI connection states an admin should act on (a member's own connection is theirs to fix, so team ones only) */
const CREDENTIAL_PROBLEMS: CredentialState[] = ['expiring', 'expired', 'invalid', 'needs_reconnect', 'over_limit']

const names = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '')

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

  const item = (name: string, state: string) => t('adminHome.item', { name, state })
  const active = users.data?.items.filter((u) => u.status === 'active') ?? []
  const noAi = users.data ? users.data.items.filter((u) => users.data?.noAi?.includes(u.id)).map((u) => u.name) : []
  const openInvites = invites.data?.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > Date.now()).length ?? 0
  const badEngines = engines.data?.engines.filter((e) => e.enabled && e.status !== 'ok') ?? []
  const badCredentials = credentials.data?.filter((c) => !c.disabled && CREDENTIAL_PROBLEMS.includes(c.state)) ?? []
  const badServices = services.data?.filter((s) => s.status !== 'connected') ?? []
  const storageBad = !!storage.data && (storage.data.level !== 'ok' || storage.data.writesRefused)
  const failedChecks = diagnostics.data?.filter((c) => c.status === 'fail') ?? []
  const checksToLook = diagnostics.data?.filter((c) => c.status === 'fail' || c.status === 'warn') ?? []

  const newVersion = update.data?.u && !update.data.u.managed && office.data && !office.data.v ? update.data.u.available?.version : undefined

  const attention: { key: string; text: string; to: string }[] = [
    ...badEngines.map((e) => ({ key: `engine-${e.id}`, text: item(e.label, t(`engines.status.${e.status}`)), to: '/admin/engines' })),
    ...(noAi.length ? [{ key: 'no-ai', text: t('adminHome.noAi', { count: noAi.length, names: names(noAi) }), to: '/admin/credentials' }] : []),
    ...badCredentials.map((c) => ({ key: `credential-${c.id}`, text: item(c.label, t(`credentials.state.${c.state}`)), to: '/admin/credentials' })),
    ...badServices.map((s) => ({ key: `service-${s.id}`, text: item(s.name, t(`integrations.status.${s.status}`)), to: '/admin/integrations' })),
    ...(storageBad && storage.data ? [{ key: 'storage', text: t('adminHome.storage', { percent: Math.round(storage.data.percent) }), to: '/admin/system' }] : []),
    ...failedChecks.map((c) => ({ key: `check-${c.id}`, text: c.label, to: '/admin/system' })),
    ...(newVersion ? [{ key: 'update', text: t('adminHome.newVersion', { version: newVersion }), to: '/admin/system' }] : []),
  ]
  const ready = settled(users, engines, credentials, services, storage, diagnostics)
  const defaultEngine = engines.data?.engines.find((e) => e.id === engines.data?.defaultEngine)?.label
  const latest = audit.data?.[0]

  return (
    <div className="space-y-8" data-testid="admin-home">
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
                    <Link to={a.to} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover focus-visible:-outline-offset-2">
                      <AlertTriangle size={15} className="shrink-0 text-warn" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{a.text}</span>
                      <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <h2 id="admin-home-attention" className="flex items-center gap-2 text-sm text-muted" data-testid="admin-all-good">
              <CheckCircle2 size={16} className="text-ok" aria-hidden /> {t('adminHome.allGood')}
            </h2>
          )}
        </section>
      )}

      <section aria-labelledby="admin-home-areas">
        <h2 id="admin-home-areas" className="mb-2 text-sm font-semibold">
          {t('adminHome.areas')}
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Area id="members" to="/admin/members" icon={Users} title={t('admin.members')} state={users}
            line={t('adminHome.members', { count: active.length }) + (openInvites ? ` · ${t('adminHome.invites', { count: openInvites })}` : '')}
            meta={names(active.map((u) => u.name))}
          />
          <Area id="engines" to="/admin/engines" icon={Cpu} title={t('admin.engines')} state={engines} problems={badEngines.length}
            line={defaultEngine ? t('adminHome.default', { engine: defaultEngine }) : ''}
            meta={names(engines.data?.engines.filter((e) => e.enabled).map((e) => e.label) ?? [])}
          />
          <Area id="credentials" to="/admin/credentials" icon={KeyRound} title={t('admin.credentials')} state={credentials} problems={badCredentials.length + (noAi.length ? 1 : 0)}
            line={t('adminHome.connections', { count: credentials.data?.length ?? 0 })}
            meta={credentials.data?.length ? t('adminHome.thisMonth', { amount: formatUsd(credentials.data.reduce((s, c) => s + c.month.usd, 0), locale) }) : ''}
          />
          <Area id="integrations" to="/admin/integrations" icon={Cable} title={t('admin.integrations')} state={services} problems={badServices.length}
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
            meta={owner && diagnostics.data ? (checksToLook.length ? names(checksToLook.map((c) => c.label)) : t('adminHome.checksOk')) : ''}
          />
        </div>
      </section>

      <p className="flex items-center gap-2 text-xs text-faint">
        <Lock size={13} aria-hidden /> {t('admin.privacy')}
      </p>
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
