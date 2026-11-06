// The action for "no AI": connect (the owner: the team's; a member the team allows: their own), in the simple dialog
// in place (components/onboarding/ConnectAi.tsx), or tell the owner (one request, then "알렸어요").
import { useEffect } from 'react'
import { aiButton } from '../../lib/aiAccess'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { ConnectAiButton } from '../onboarding/ConnectAi'
import { Button } from '../ui'

export default function AiAccessButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const t = useT()
  const { loaded, usable, action, requested, sending, failed, ask, load } = useAiAccess()
  // a chat error never uses an old answer: ask again when the button appears
  useEffect(() => { void load(true) }, [load])
  // AI works (again), or this install signs in on its own: nothing to connect or ask for
  if (!loaded || usable) return null
  const b = aiButton(action, requested)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {b.kind === 'connect' ? (
        <ConnectAiButton personal={b.personal} size={size} label={b.label} data-testid="ai-access-button" data-action={action} />
      ) : (
        <Button size={size} variant={b.done ? 'secondary' : 'primary'} disabled={b.done} busy={sending} onClick={() => void ask()} data-testid="ai-access-button" data-action={action}>
          {sending ? t('aiAccess.asking') : t(b.label)}
        </Button>
      )}
      {failed && <span role="alert" className="text-xs">{t('aiAccess.askFailed')}</span>}
    </span>
  )
}
