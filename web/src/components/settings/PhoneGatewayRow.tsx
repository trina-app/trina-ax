// Settings › Notifications › Phone › "Phone notifications", for owners and admins (docs/DECISIONS.md "Owners and admins
// choose where phone notifications go"): where the whole team's phone app notifications go. Three choices: the
// product's push service (the default; the store app gets them), Off, or Custom: an address of the team's own push
// service, for their own build of the phone app (the store app can't get those). Default and Off save at once; Custom
// saves with its button, and the server saves it only when the address answers as a push service, else the reason
// shows under the field. Set in the server's own settings (MYCEL_PUSH_GATEWAY, server.json): the value and where it is
// set, nothing to change.
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { PUSH_GATEWAY_PROBLEMS, type PushGatewayChoice, type PushGatewayProblem, type PushGatewaySetting } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, ErrorNote, inputCls, useMediaQuery } from '../ui'
import { PhoneChoiceRow } from '../phone/PhoneChoice'
import { settingDesc } from './SettingRow'
import { PrefRow } from './PrefRows'

/** why a save was refused, in words (server: routes/push.ts setPushGateway); null: not one of ours */
export const gatewayProblem = (e: unknown): PushGatewayProblem | null => {
  const reason = e instanceof ApiError ? e.body.params?.reason : undefined
  return (PUSH_GATEWAY_PROBLEMS as readonly unknown[]).includes(reason) ? reason as PushGatewayProblem : null
}

export function PhoneGatewayRow() {
  const t = useT(), locale = useLocale()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [setting, setSetting] = useState<PushGatewaySetting | null>(null)
  // the choice on screen: Custom is only shown until its address is saved
  const [choice, setChoice] = useState<PushGatewayChoice | null>(null)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const show = (s: PushGatewaySetting) => { setSetting(s); setChoice(s.choice); setAddress(s.url ?? '') }
  useEffect(() => {
    alive.current = true
    void api.call(API.getPushGateway).then((s) => { if (alive.current) show(s) }, (e) => { if (alive.current) setError(errorText(e, locale, t('error.network'))) })
    return () => { alive.current = false }
    // read once for this open page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = async (next: PushGatewayChoice) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const s = await api.call(API.setPushGateway, { body: next === 'custom' ? { choice: next, url: address.trim() } : { choice: next } })
      if (!alive.current) return
      show(s)
      toast({ level: 'success', text: t('pushGateway.saved') })
    } catch (e) {
      if (!alive.current) return
      const problem = gatewayProblem(e)
      setError(problem ? t(`pushGateway.problem.${problem}`) : errorText(e, locale, t('error.network')))
      // Default or Off that did not save: back to what the server has
      if (next !== 'custom' && setting) setChoice(setting.choice)
    } finally { if (alive.current) setBusy(false) }
  }
  const pick = (next: PushGatewayChoice) => {
    setError(null)
    if (next === 'custom') { setChoice('custom'); return }
    setChoice(next); void save(next)
  }
  const title = t('pushGateway.title')
  if (!setting || !choice) return error ? <PrefRow id="np-phone-gateway" title={title} below={<div className="mt-2"><ErrorNote>{error}</ErrorNote></div>} testId="phone-gateway" /> : null
  const label = (c: PushGatewayChoice) => c === 'default' ? t('pushGateway.choice.default') : c === 'off' ? t('pushGateway.choice.off') : t('pushGateway.choice.custom')
  const options = (['default', 'off', 'custom'] as const).filter((c) => c !== 'default' || setting.defaultHost || setting.choice === 'default')
  const desc = t(`pushGateway.desc.${choice}`)

  // set in the server's own settings: the value and where, nothing to pick
  if (setting.lockedBy) {
    return <PrefRow id="np-phone-gateway" title={title} desc={desc} testId="phone-gateway" attrs={{ 'data-locked': '' }}
      control={<span className="text-sm text-muted" data-testid="phone-gateway-value">{label(setting.choice)}</span>}
      below={<>
        {setting.url && <p className={clsx('mt-2 break-all', settingDesc)} data-testid="phone-gateway-url">{setting.url}</p>}
        <p className={clsx('mt-2', settingDesc)} data-testid="phone-gateway-locked">{t('pushGateway.locked', { where: setting.lockedBy })}</p>
      </>} />
  }

  const custom = choice === 'custom' && <div className="mt-3 flex flex-col gap-2" data-testid="phone-gateway-custom">
    <label htmlFor="np-phone-gateway-url" className="sr-only">{t('pushGateway.address')}</label>
    <div className="flex items-center gap-2">
      <input id="np-phone-gateway-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://push.example.com" aria-describedby="np-phone-gateway-note"
        className={clsx(inputCls, 'min-w-0 flex-1')} value={address} onChange={(e) => { setAddress(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && address.trim()) void save('custom') }} data-testid="phone-gateway-address" />
      <Button busy={busy} disabled={!address.trim() || (setting.choice === 'custom' && address.trim() === setting.url)} onClick={() => void save('custom')} data-testid="phone-gateway-save">{t('common.save')}</Button>
    </div>
    <p id="np-phone-gateway-note" className={settingDesc}>{t('pushGateway.customNote')}</p>
  </div>
  const below = <>
    {custom}
    {error && <div className="mt-2" data-testid="phone-gateway-error"><ErrorNote>{error}</ErrorNote></div>}
  </>
  if (phone)
    return <PhoneChoiceRow title={title} desc={desc} value={choice} options={options.map((c) => ({ value: c, label: label(c) }))} onChange={pick} below={below} testId="phone-gateway" />
  return <PrefRow id="np-phone-gateway" title={title} desc={desc} testId="phone-gateway" below={below}
    control={<select id="np-phone-gateway" aria-describedby="np-phone-gateway-desc" className={clsx(inputCls, 'md:w-64')} value={choice} disabled={busy}
      onChange={(e) => pick(e.target.value as PushGatewayChoice)} data-testid="phone-gateway-choice">
      {options.map((c) => <option key={c} value={c}>{label(c)}</option>)}
    </select>} />
}
