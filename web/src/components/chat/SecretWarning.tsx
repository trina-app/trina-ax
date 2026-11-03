// A key typed into the message box (docs/INTEGRATIONS.md "Connecting from a chat"): before sending text that looks
// like a key or password (shared/src/secrets.ts hasSecret), the box says that a message goes to the AI provider and
// stays in the chat, and points to the connect card. "Send anyway" sends it as it is; "Edit" goes back to the text.
import { ShieldAlert } from 'lucide-react'
import { hasSecret } from '@mycel/shared'
import { useT } from '../../i18n'
import { Button } from '../ui'

/** Whether sending this text waits for "Send anyway": it looks like a key or a password. */
export const holdForSecret = (text: string): boolean => hasSecret(text)

export function SecretWarning({ onSendAnyway, onEdit }: { onSendAnyway: () => void; onEdit: () => void }) {
  const t = useT()
  return (
    <div role="alert" className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-2 rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" data-testid="secret-warning">
      <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      {/* at least ~14rem for the text: on a phone the buttons go to their own line */}
      <p className="min-w-0 flex-[1_1_14rem]">{t('composer.secretWarning')}</p>
      <div className="ml-auto flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={onSendAnyway} data-testid="secret-send-anyway">
          {t('composer.sendAnyway')}
        </Button>
        <Button size="sm" onClick={onEdit} data-testid="secret-edit">
          {t('composer.secretEdit')}
        </Button>
      </div>
    </div>
  )
}
