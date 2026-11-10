// Admin's list on a phone (/admin below 768 px; docs/DECISIONS.md "Admin and Settings on phones: a list you tap into"),
// in place of Home's cards and the menu: whose admin this is (the team's logo and "<team> admin", the line that it
// applies to everyone), what needs attention (Home's rows, overview.tsx), the owner's setup steps folded into one row,
// then the menu's groups as rows with a short value or a "N to fix" badge, each opening its page with a push (Back
// returns here, to the same place). The values are what Home reads already (no new requests); a source that could not
// be read shows "—". Nothing is said when nothing needs attention: no badge and no rows is that.
import { AlertTriangle, Building2, Lock } from 'lucide-react'
import { teamIconUrl } from '@mycel/shared'
import { formatRelative, formatUsd } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { Badge } from '../../components/ui'
import { PhoneListGroup, PhoneListRow } from '../../components/phone/PhoneList'
import { JobLine } from './jobs'
import { OwnerSetup } from './OwnerChecklist'
import { useAdminOverview } from './overview'

export interface PhoneMenuGroup {
  label: MessageKey
  items: { id: string; label: MessageKey; icon: typeof Lock }[]
}

export default function PhoneRoot({ groups }: { groups: PhoneMenuGroup[] }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const o = useAdminOverview()
  const unavailable = <span aria-label={t('adminHome.unavailable')}>—</span>
  /** the short value on the right of a page's row: what Home says first about it, when there is something to say */
  const value = (id: string) => {
    switch (id) {
      case 'members':
        return o.users.error ? unavailable : o.users.data ? String(o.active.length) : null
      case 'providers':
        return o.engines.error ? unavailable : (o.defaultEngine ?? null)
      case 'connectors':
        return o.services.error ? unavailable : o.services.data?.length ? String(o.services.data.length) : null
      case 'plugins':
        return o.plugins.error ? unavailable : o.plugins.data?.length ? String(o.plugins.data.length) : null
      case 'usage':
        return o.usage.error ? unavailable : o.usage.data ? formatUsd(o.usage.data.totals.costUsd, locale) : null
      case 'audit':
        return o.audit.error ? unavailable : o.audit.data?.[0] ? formatRelative(o.audit.data[0].at, locale) : null
      default:
        return null
    }
  }
  return (
    <div className="pb-8" data-testid="admin-phone-root">
      <header className="px-4 pt-4">
        <h1 className="flex items-start gap-2.5 text-xl leading-7 font-semibold tracking-tight" data-testid="admin-title">
          <img src={me.team.iconVersion ? teamIconUrl(me.team.iconVersion) : '/favicon.svg'} alt="" aria-hidden className="mt-0.5 size-7 shrink-0 rounded-md object-cover" data-testid="admin-team-logo" />
          <span className="line-clamp-2 min-w-0 break-words">{t('admin.teamTitle', { team: me.team.name })}</span>
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-faint" data-testid="page-scope">
          <Building2 size={13} className="shrink-0" aria-hidden /> <span className="truncate">{t('scope.teamName', { team: me.team.name })}</span>
        </p>
      </header>

      {/* until the sources answer: one quiet row, so the groups do not jump far when the rows come in */}
      {!o.ready ? (
        <PhoneListGroup title={t('adminHome.attention')} labelId="admin-phone-attention" testId="admin-attention-loading">
          <li className="flex min-h-12 items-center px-4" aria-busy="true">
            <span className="h-3 w-40 animate-pulse rounded bg-subtle" />
          </li>
        </PhoneListGroup>
      ) : o.attention.length || o.unchecked ? (
        <PhoneListGroup
          title={t('adminHome.attention')}
          labelId="admin-phone-attention"
          testId="admin-attention"
          footer={o.unchecked ? <span className="text-warn" data-testid="admin-not-all-checked">{t(o.attention.length ? 'adminHome.notAllChecked.more' : 'adminHome.notAllChecked')}</span> : undefined}
        >
          {o.attention.map((a) => (
            <PhoneListRow
              key={a.key}
              icon={<AlertTriangle size={16} className="text-warn" />}
              title={a.text}
              to={a.to}
              wrap
              below={a.actions ? <>{a.actions}{a.job && <div className="basis-full"><JobLine jobId={a.job} /></div>}</> : undefined}
              testId={`attention-${a.key}`}
            />
          ))}
        </PhoneListGroup>
      ) : null}

      {o.owner && <OwnerSetup compact />}

      {groups.map((g) => (
        <PhoneListGroup key={g.label} title={t(g.label)} labelId={`admin-phone-${g.label}`} testId={`admin-group-${g.label.split('.').pop()}`}>
          {g.items.map((s) => {
            const n = o.toFix(s.id)
            return (
              <PhoneListRow
                key={s.id}
                icon={<s.icon size={16} />}
                title={t(s.label)}
                to={`/admin/${s.id}`}
                value={value(s.id)}
                badge={n > 0 ? <Badge tone="warn">{t('adminHome.toFix', { count: n })}</Badge> : undefined}
                testId={`admin-row-${s.id}`}
              />
            )
          })}
        </PhoneListGroup>
      ))}

      <p className="mt-6 flex items-center gap-2 px-4 text-xs text-faint">
        <Lock size={13} className="shrink-0" aria-hidden /> {t('admin.privacy')}
      </p>
      {o.install.dialog}
    </div>
  )
}
