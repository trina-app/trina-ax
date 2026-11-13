// Admin › Connectors, the five Google pages (GoogleAdminPage.tsx): "Google sign-in", the first row of Team settings
// (docs/AGENTS/plan/20261113-0917-google-own-app.md "UI and UX"; the guide docs/site/use/google-own-app.md). Owners and
// admins only, and only where the company's own Google app can be set or is set (GoogleOwnAppStatus available or active).
//  - Trina's app: one line and Use your company's app.
//  - The company's app: one line with who set it and when, and ⋯ with Replace and Use Trina's Google sign-in again (or,
//    without a Trina sign-in to go back to, a Remove that says it turns Google off for everyone). Both ask first with
//    the numbers of the dialog's last step.
// The dialog, "Use your company's Google app" (also Replace), in four steps: Before you start (who it is for, the guide),
// In Google Cloud (DriveConnector.tsx DriveCloudSteps with the five APIs, both return addresses with Copy), Add it here
// (the downloaded file, dropped or chosen, or the ID and secret behind a disclosure; a file without both return
// addresses is refused at once, with the one to add), Before you save (how many connect again). Nothing changes before
// Save. The server checks everything again; the row never shows the ID or secret.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { API, type GoogleOwnAppStatus } from '@mycel/shared/api'
import { api, ApiError } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, confirmDialog, Modal } from '../ui'
import { SettingRow } from '../../pages/admin/common'
import { CardMenu } from './AppConnectorCard'
import { ExtLink } from './AppDetail'
import { clientBody, clientReady, DriveCloudSteps, emptyClient, GoogleClientFields, ReturnAddress, type ClientInput, type CloudStep } from './DriveConnector'

type T = ReturnType<typeof useT>

/** The guide in the public docs (docs/site/use/google-own-app.md), opened in a new tab like the plugin guide. */
export const GOOGLE_OWN_APP_GUIDE = 'https://ax.trina.app/docs/use/google-own-app/'

/** The Google Cloud steps for the company's app: the five APIs, Internal, the permissions, a web client, its file. */
export const OWN_APP_CLOUD_STEPS: readonly CloudStep[] = [
  { key: 'gsign.cloud.project', link: 'gsign.link.project', href: 'https://console.cloud.google.com/projectcreate' },
  { key: 'gsign.cloud.apis', link: null, href: null, links: [
    { name: 'Google Drive API', href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
    { name: 'Gmail API', href: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com' },
    { name: 'Google Calendar API', href: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com' },
    { name: 'Google Docs API', href: 'https://console.cloud.google.com/apis/library/docs.googleapis.com' },
    { name: 'Google Sheets API', href: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com' },
  ] },
  { key: 'gsign.cloud.consent', link: 'gsign.link.consent', href: 'https://console.cloud.google.com/auth/overview' },
  { key: 'gsign.cloud.scopes', link: 'gsign.link.scopes', href: 'https://console.cloud.google.com/auth/scopes' },
  { key: 'gsign.cloud.client', link: 'gsign.link.client', href: 'https://console.cloud.google.com/auth/clients' },
  { key: 'gsign.cloud.json', link: null, href: null },
]

/** Whether the row shows: owners and admins, where the company's app can be set here or is set. */
export const googleSignInShown = (admin: boolean, s: GoogleOwnAppStatus | null | undefined): s is GoogleOwnAppStatus => admin && !!s && (s.available || s.active)

/** The server's refusal (error.params.reason) in the person's words; `addresses` for the one to add. */
export function ownAppErrorText(t: T, reason: string | undefined, addresses: GoogleOwnAppStatus['returnAddresses']): string {
  switch (reason) {
    case 'client_invalid': return t('gsign.error.invalid')
    case 'client_redirect_drive': return t('gsign.error.redirectDrive', { address: addresses?.drive ?? '' })
    case 'client_redirect_apps': return t('gsign.error.redirectApps', { address: addresses?.apps ?? '' })
    case 'server': return t('gsign.error.server')
    case 'not_service': return t('gsign.error.notService')
    case 'public_host': return t('gsign.noAddress')
    case 'key_unsafe': return t('gsign.error.unsafe')
    default: return t('driveSetup.error.failed')
  }
}
const reasonOf = (e: unknown) => (e instanceof ApiError ? (e.body.params?.reason as string | undefined) : undefined)

/** The downloaded file, checked here before the last step as the server checks it: a Google "Web application" that lists
 * both return addresses. The ID and secret are only checked for being there. null: fine. */
export function checkClient(c: ClientInput, addresses: GoogleOwnAppStatus['returnAddresses']): string | null {
  if (!c.file) return null
  let j: unknown
  try { j = JSON.parse(c.file.text) } catch { return 'client_invalid' }
  const web = j && typeof j === 'object' ? (j as { web?: unknown }).web : null
  if (!web || typeof web !== 'object') return 'client_invalid'
  const uris = (web as { redirect_uris?: unknown }).redirect_uris
  const list = Array.isArray(uris) ? uris : []
  if (addresses && !list.includes(addresses.drive)) return 'client_redirect_drive'
  if (addresses && !list.includes(addresses.apps)) return 'client_redirect_apps'
  return null
}

/** What a change ends: how many people connect Google again, and the shared ones an admin reconnects. */
function Counts({ status }: { status: GoogleOwnAppStatus }) {
  const t = useT()
  return (
    <>
      <p data-testid="gsign-people">{status.people > 0 ? t('gsign.confirm.people', { n: status.people }) : t('gsign.confirm.nobody')}</p>
      {status.shared > 0 && <p data-testid="gsign-shared">{t('gsign.confirm.shared', { n: status.shared })}</p>}
    </>
  )
}

/** Team settings › Google sign-in, and its dialog. `onChange`: the new status after Save or a removal (the page then
 * reads its other statuses again: the shared rows ask to reconnect). */
export function GoogleSignInRow({ status, onChange }: { status: GoogleOwnAppStatus; onChange: (s: GoogleOwnAppStatus) => void }) {
  const t = useT()
  const locale = useLocale()
  const [dialog, setDialog] = useState<'new' | 'replace' | null>(null)
  const active = status.active
  const date = formatDate(status.setAt, locale)
  const setLine = !active || !date ? '' : status.setBy ? t('gsign.setBy', { name: status.setBy.name, date }) : t('gsign.setOn', { date })
  const remove = async () => {
    const off = !status.canGoBack
    const ok = await confirmDialog({
      title: t(off ? 'gsign.offTitle' : 'gsign.goBackTitle'),
      body: <div className="space-y-2" data-testid="gsign-remove-body"><p>{t(off ? 'gsign.offBody' : 'gsign.goBackBody')}</p>{!off && <Counts status={status} />}</div>,
      confirm: t(off ? 'gsign.offConfirm' : 'gsign.goBack'),
      danger: off,
    })
    if (!ok) return
    try {
      onChange(await api.call(API.removeGoogleOwnApp))
      toast({ level: 'success', text: t(off ? 'gsign.goneOff' : 'gsign.goneBack') })
    } catch (e) { toast({ level: 'error', text: ownAppErrorText(t, reasonOf(e), status.returnAddresses) }) }
  }
  return (
    <>
      <SettingRow heading title={t('gsign.title')} testId="gsign-row" attrs={{ 'data-state': active ? 'company' : 'trina' }}
        desc={active ? [t('gsign.company'), setLine].filter(Boolean).join(' ') : t('gsign.trina')}
        more={active ? t('gsign.addressMore') : undefined}
        control={active
          ? <CardMenu label={t('gsign.more')} testId="gsign-menu" startOnPhone items={[
              ...(status.available ? [{ label: t('gsign.replace'), onSelect: () => setDialog('replace'), testId: 'gsign-replace' }] : []),
              { label: t(status.canGoBack ? 'gsign.goBack' : 'gsign.remove'), onSelect: () => void remove(), danger: !status.canGoBack, testId: 'gsign-remove' },
            ]} />
          : <Button onClick={() => setDialog('new')} data-testid="gsign-use">{t('gsign.use')}</Button>} />
      {dialog && (
        <OwnAppDialog status={status} replace={dialog === 'replace'} onClose={() => setDialog(null)}
          onSaved={(st) => { setDialog(null); onChange(st); toast({ level: 'success', text: t('gsign.saved') }) }} />
      )}
    </>
  )
}

const STEPS = ['start', 'cloud', 'add', 'confirm'] as const
type Step = typeof STEPS[number]
const STEP_TITLE = { start: 'gsign.step.start', cloud: 'gsign.step.cloud', add: 'gsign.step.add', confirm: 'gsign.step.confirm' } as const

/** Use your company's Google app (or Replace it): four steps, Save on the last; nothing is sent before Save. */
function OwnAppDialog({ status, replace, onClose, onSaved }: { status: GoogleOwnAppStatus; replace: boolean; onClose: () => void; onSaved: (s: GoogleOwnAppStatus) => void }) {
  const t = useT()
  // Replace: the admin has been through it once; the new file is what is asked for (Back still shows the rest)
  const [step, setStep] = useState<Step>(replace ? 'add' : 'start')
  const [client, setClient] = useState<ClientInput>(emptyClient)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)
  // a new step: the keyboard and the screen reader start at its heading (not on opening: the dialog focuses itself)
  useEffect(() => { if (first.current) { first.current = false; return } heading.current?.focus() }, [step])
  const at = STEPS.indexOf(step)
  const go = (s: Step) => { setError(null); setStep(s) }
  const addresses = status.returnAddresses
  const next = () => {
    if (step === 'add') {
      const bad = checkClient(client, addresses)
      if (bad) { setError(ownAppErrorText(t, bad, addresses)); return }
    }
    go(STEPS[at + 1]!)
  }
  const save = async () => {
    if (busy || !clientReady(client)) return
    setBusy(true); setError(null)
    try { onSaved(await api.call(API.setGoogleOwnApp, { body: clientBody(client) })) }
    catch (e) {
      const reason = reasonOf(e)
      // the file or the ID and secret: back to where they are given, with the line saying what to change
      if (reason?.startsWith('client_')) setStep('add')
      setError(ownAppErrorText(t, reason, addresses))
    } finally { setBusy(false) }
  }
  const canNext = step !== 'add' || clientReady(client)
  let body: ReactNode
  if (step === 'start') {
    body = <>
      <p>{t('gsign.start.who')}</p>
      <p>{t('gsign.start.what')}</p>
      <p><ExtLink href={GOOGLE_OWN_APP_GUIDE} name={t('gsign.start.guide')} testId="gsign-guide">{t('gsign.start.guide')}</ExtLink></p>
    </>
  } else if (step === 'cloud') {
    body = <>
      <DriveCloudSteps steps={OWN_APP_CLOUD_STEPS} title={null} />
      {addresses
        ? <div className="space-y-2" data-testid="gsign-addresses">
            <ReturnAddress label={t('gsign.address.drive')} value={addresses.drive} testId="gsign-address-drive" copyLabel={t('gsign.copy.drive')} />
            <ReturnAddress label={t('gsign.address.apps')} value={addresses.apps} testId="gsign-address-apps" copyLabel={t('gsign.copy.apps')} />
          </div>
        : <p className="text-muted">{t('gsign.noAddress')}</p>}
    </>
  } else if (step === 'add') {
    body = <>
      <GoogleClientFields redirectUri={null} value={client} onChange={(c) => { setClient(c); setError(null) }} onError={setError} drop={t('gsign.add.drop')} manual={t('gsign.add.manual')} />
    </>
  } else {
    body = <>
      <p>{t('gsign.confirm.what')}</p>
      <Counts status={status} />
      <p className="text-muted">{t('gsign.confirm.nothing')}</p>
    </>
  }
  return (
    <Modal open title={t(replace ? 'gsign.replaceTitle' : 'gsign.dialogTitle')} onClose={onClose} width={560}
      footer={<>
        {at > 0 && <Button variant="ghost" className="mr-auto" onClick={() => go(STEPS[at - 1]!)} disabled={busy} data-testid="gsign-back">{t('gsign.prev')}</Button>}
        <Button onClick={onClose} disabled={busy} data-testid="gsign-cancel">{t('common.cancel')}</Button>
        {step === 'confirm'
          ? <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="gsign-save">{t('common.save')}</Button>
          : <Button variant="primary" disabled={!canNext} onClick={next} data-testid="gsign-next">{t('gsign.next')}</Button>}
      </>}>
      <div className="space-y-4 text-sm" data-testid="gsign-dialog" data-step={step}>
        <div>
          <p className="text-xs text-muted" data-testid="gsign-step-of">{t('gsign.stepOf', { n: at + 1, total: STEPS.length })}</p>
          <h3 ref={heading} tabIndex={-1} className="font-medium outline-none" data-testid="gsign-step-title">{t(STEP_TITLE[step])}</h3>
        </div>
        {body}
        {error && <p className="text-danger" role="alert" data-testid="gsign-error">{error}</p>}
      </div>
    </Modal>
  )
}
