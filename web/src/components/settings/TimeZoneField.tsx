// The team time zone in Admin > Team settings: city and UTC offset ("Seoul (UTC+9)") instead of raw IANA names, the common
// zones first and a search over all of them. The saved value stays the IANA name. A computer: a search box over a select;
// a phone: the row of rooms/PhoneChoice with the same search under it (the sheet lists what the search keeps).
import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useLocale, useT } from '../../i18n'
import { zoneGroups } from '../../lib/time-zones'
import { inputCls } from '../ui'
import { PhoneChoiceRow } from '../phone/PhoneChoice'

function Search({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const t = useT()
  return <input id={id} type="search" className={clsx(inputCls, 'md:w-64')} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('teamSettings.timeZoneSearch')} aria-label={t('teamSettings.timeZoneSearch')} autoComplete="off" data-testid="team-time-zone-search" />
}

export function TimeZoneSelect({ id, describedBy, value, onChange }: { id: string; describedBy: string; value: string; onChange: (z: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const [q, setQ] = useState('')
  const g = useMemo(() => zoneGroups(value, locale, q), [value, locale, q])
  return (
    <div className="flex flex-col gap-2 md:w-64">
      <Search id={`${id}-search`} value={q} onChange={setQ} />
      <select id={id} aria-describedby={describedBy} className={clsx(inputCls, 'w-full')} value={value} onChange={(e) => onChange(e.target.value)} data-testid="team-time-zone">
        {g.common.length > 0 && <optgroup label={t('teamSettings.timeZoneCommon')}>{g.common.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup>}
        {g.other.length > 0 && <optgroup label={t('teamSettings.timeZoneOther')}>{g.other.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup>}
      </select>
      {g.none && <p className="text-xs text-faint" role="status">{t('teamSettings.timeZoneNone')}</p>}
    </div>
  )
}

export function PhoneTimeZoneRow({ value, onChange }: { value: string; onChange: (z: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const [q, setQ] = useState('')
  const g = useMemo(() => zoneGroups(value, locale, q), [value, locale, q])
  const all = useMemo(() => zoneGroups(value, locale).common, [value, locale])
  // the current zone stays among the options, so the row shows its label while the search narrows the sheet
  const options = [...g.common, ...g.other]
  const cur = all.find((c) => c.value === value) ?? options.find((c) => c.value === value) ?? { value, label: value }
  return (
    <PhoneChoiceRow title={t('teamSettings.timeZone')} desc={t('teamSettings.row.timeZoneDesc')} more={t('teamSettings.timeZoneHint')} value={value}
      options={options.some((o) => o.value === value) ? options : [cur, ...options]} onChange={onChange} testId="team-time-zone"
      below={<div className="flex flex-col gap-2 pb-2"><Search id="ts-time-zone-search" value={q} onChange={setQ} />{g.none && <p className="text-xs text-faint" role="status">{t('teamSettings.timeZoneNone')}</p>}</div>} />
  )
}
