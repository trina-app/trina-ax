// Admin > Team settings: the team's company profile (docs/DECISIONS.md "D — Company profile from the company website"),
// what every team chat's AI is told about the company. Shows what is saved (the brand colours as small swatches); "Create"
// / "Edit" opens the same step the welcome wizard uses (ProfileStep.tsx) in a dialog. Owner and admins only (the page is
// theirs; the server checks again).
import { useState, type ReactNode } from 'react'
import { API, type CompanyProfile } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { useT } from '../../i18n'
import { Card, Loadable, useLoad } from '../../pages/admin/common'
import { Button, Modal } from '../ui'
import ProfileStep, { brandColors, ColorSwatch } from './ProfileStep'

export default function CompanyProfileCard() {
  const t = useT()
  const state = useLoad(() => api.call(API.getCompanyProfile))
  const [open, setOpen] = useState(false)
  const profile = state.data?.profile ?? null
  return (
    <Card
      id="company-profile"
      title={t('onboarding.profile.title')}
      desc={t('onboarding.profile.cardDesc')}
      actions={state.data && (
        <Button size="sm" onClick={() => setOpen(true)} data-testid="company-profile-edit">
          {profile ? t('onboarding.profile.edit') : t('onboarding.profile.create')}
        </Button>
      )}
    >
      <Loadable state={state} lines={2}>
        {(d) => (d.profile ? <Summary p={d.profile} /> : <p className="text-sm text-muted">{t('onboarding.profile.none')}</p>)}
      </Loadable>
      <Modal open={open} onClose={() => setOpen(false)} title={t('onboarding.profile.title')} width={640}>
        <ProfileStep
          initial={profile}
          onDone={(p) => { state.setData({ profile: p }); setOpen(false) }}
          onSkip={() => setOpen(false)}
          skipLabel={t('onboarding.profile.cancel')}
        />
      </Modal>
    </Card>
  )
}

function Summary({ p }: { p: CompanyProfile }) {
  const t = useT()
  const colors = brandColors(p.colors)
  const rows: [string, ReactNode][] = [
    [t('onboarding.profile.f.name'), p.name ?? ''],
    [t('onboarding.profile.f.oneLine'), p.oneLine],
    [t('onboarding.profile.f.products'), p.products],
    [t('onboarding.profile.f.audience'), p.audience],
    [t('onboarding.profile.f.tone'), p.tone.join(', ')],
    [t('onboarding.profile.f.colors'), colors.length > 0 && (
      <span className="flex flex-wrap gap-1.5" data-testid="company-profile-colors">
        {colors.map((c) => <ColorSwatch key={c} color={c} />)}
      </span>
    )],
    [t('onboarding.profile.f.avoid'), p.avoid],
    [t('onboarding.profile.f.website'), p.website],
  ]
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-faint sm:pt-0.5">{k}</dt>
          <dd className="min-w-0 break-words whitespace-pre-line text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
