// "Trina isn't ready yet" (chat error engine_missing: the AI cannot start here): one button by who reads it
// (docs/DECISIONS.md, owner 2026-11-11). The owner and admins go to the page that connects the AI (Admin › AI accounts,
// /admin/providers); a member tells them with one press (POST /api/me/ai-not-ready/tell: an Inbox notice to the owner(s)
// and admins, at most once an hour, the server's limit), and the button says so ("Told"). "Told" stays after a reload
// until that hour has passed: it is read from the server's own record (GET /api/me/ai-access notReadyTold, owner
// decision 2026-11-12), never from the browser.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { Button } from '../ui'

export default function NotReadyButton({ role, initial = 'idle' }: { role: 'owner' | 'admin' | 'member' | undefined; initial?: 'idle' | 'told' }) {
  const t = useT()
  const navigate = useNavigate()
  const [state, setState] = useState<'idle' | 'sending' | 'told' | 'failed'>(initial)
  const toldBefore = useAiAccess((s) => s.notReadyTold)
  const member = role === 'member'
  useEffect(() => { if (member) void useAiAccess.getState().load() }, [member])
  if (role === 'owner' || role === 'admin') {
    return (
      <Button size="sm" variant="primary" onClick={() => navigate('/admin/providers')} data-testid="not-ready-button" data-action="connect">
        {t('aiAccess.connectTeam')}
      </Button>
    )
  }
  // a signed-out page or one still loading the person: nothing to press yet
  if (!role) return null
  const told = state === 'told' || toldBefore
  const tell = async () => {
    if (state === 'sending' || told) return
    setState('sending')
    try { await api.call(API.tellAiNotReady); setState('told'); useAiAccess.getState().markNotReadyTold() } catch { setState('failed') }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant={told ? 'secondary' : 'primary'} disabled={told} busy={state === 'sending'} onClick={() => void tell()} data-testid="not-ready-button" data-action="tell">
        {t(told ? 'notReady.told' : 'notReady.tell')}
      </Button>
      {state === 'failed' && <span role="alert" className="text-xs">{t('aiAccess.askFailed')}</span>}
    </span>
  )
}
