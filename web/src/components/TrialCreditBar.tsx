// The hosting service's trial AI credit (GET /api/admin/trial-credit; docs/DECISIONS.md "B — Hosted trial AI credit"),
// read-only: what was used of it, until when, and that an AI the team connects is used first. Admin › AI connections;
// the start goal card can show the same.
import clsx from 'clsx'
import type { TrialCredit } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { formatUsd, intlTag } from '../lib/format'
import { UsageBar } from './UsageBar'

export function TrialCreditBar({ credit, className }: { credit: TrialCredit; className?: string }) {
  const t = useT()
  const locale = useLocale()
  const used = formatUsd(credit.usedUsd, locale), cap = formatUsd(credit.capUsd, locale)
  // the last day it works: an end at midnight belongs to the day before
  const date = new Intl.DateTimeFormat(intlTag(locale), { month: 'long', day: 'numeric' }).format(new Date(Date.parse(credit.endsAt) - 1))
  const pct = credit.capUsd > 0 ? (credit.usedUsd / credit.capUsd) * 100 : 100
  const text = credit.state === 'active' ? t('trialCredit.active', { used, cap, date })
    : credit.state === 'used' ? t('trialCredit.used', { used, cap }) : t('trialCredit.ended')
  return (
    <div className={clsx('rounded-lg px-3 py-2 text-xs', credit.active ? 'border border-line bg-subtle text-muted' : 'bg-warn-soft text-warn', className)} role="status" data-testid="trial-credit" data-state={credit.state}>
      <p>{text}</p>
      {credit.state !== 'ended' && <UsageBar pct={pct} over={credit.state === 'used'} className="mt-1.5" />}
    </div>
  )
}
