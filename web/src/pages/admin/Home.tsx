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
import { Link } from 'react-router-dom'
import { formatRelative, formatUsd } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Badge } from '../../components/ui'
import { actionLabel } from './Audit'
import { AdminPageHeader } from './common'
import { JobLine } from './jobs'
import { OwnerSetup } from './OwnerChecklist'
import { names, useAdminOverview, type AttentionItem, type State } from './overview'

export default function Home() {
  const t = useT()
  const locale = useLocale()
  // what it reads and the "needs attention" rows: overview.tsx (the phone's Admin list reads the same)
  const {
    owner, users, engines, credentials, services, plugins, usage, audit, storage, diagnostics,
    active, openInvites, noAi, badEngines, noEngine, limitedEngines, badCredentials, badServices, storageBad, checksToLook,
    attention, ready, unchecked, defaultEngine, latest, install,
  } = useAdminOverview()

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
              <AttentionList items={attention} />
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
            meta={owner && diagnostics.data ? (checksToLook.length ? names(checksToLook.map((c) => c.label)) : t('adminHome.checksOk')) : ''}
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

/** The "needs attention" rows: a warning, the sentence (a link to the page that fixes it) and, for a row that can be
 * acted on here, its buttons and the job's progress. */
function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" data-testid="admin-attention">
      {items.map((a) => (
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
