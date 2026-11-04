// The action for "no AI": connect (owner / own connection) or tell the admin (one request, then "알렸어요").
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { aiButton } from '../../lib/aiAccess'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { Button } from '../ui'

export default function AiAccessButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const t = useT()
  const navigate = useNavigate()
  const { loaded, action, requested, sending, failed, ask, load } = useAiAccess()
  useEffect(() => { void load() }, [load])
  if (!loaded) return null
  const b = aiButton(action, requested)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {b.kind === 'link' ? (
        <Button size={size} variant="primary" onClick={() => navigate(b.to)} data-testid="ai-access-button" data-action={action}>{t(b.label)}</Button>
      ) : (
        <Button size={size} variant={b.done ? 'secondary' : 'primary'} disabled={b.done} busy={sending} onClick={() => void ask()} data-testid="ai-access-button" data-action={action}>
          {sending ? t('aiAccess.asking') : t(b.label)}
        </Button>
      )}
      {failed && <span role="alert" className="text-xs">{t('aiAccess.askFailed')}</span>}
    </span>
  )
}
