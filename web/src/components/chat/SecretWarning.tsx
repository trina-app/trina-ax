// A key typed into a box whose text reaches the AI (docs/INTEGRATIONS.md "Connecting from a chat"): the message box,
// an ask_user card's answer, editing a sent message and editing a waiting one. Before sending text that is almost
// surely a key or password (shared/src/secrets.ts hasLikelySecret: a known key prefix, a private key, a JWT, a labelled
// value such as "password: hunter22"), the box says that a message goes to the AI provider and stays in the chat, and
// points to the connect card. "Send anyway" sends it as it is; "Edit" goes back to the text; a changed text asks
// again. Not the broader hasSecret of titles: a commit hash, a Google Docs link or a generated folder name must not
// hold a message back.
import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { hasLikelySecret } from '@mycel/shared'
import { useT } from '../../i18n'
import { Button } from '../ui'

/** Whether sending this text waits for "Send anyway": it is almost surely a key or a password. */
export const holdForSecret = (text: string): boolean => hasLikelySecret(text)

/** One box's hold: `pass(anyway)` says whether `text` may go now and shows the warning (`held`) when it may not;
 * "Send anyway" calls the box's send with `pass(true)` or sends directly after `release()`. A changed text ends it. */
export function useSecretHold(text: string) {
  const [held, setHeld] = useState(false)
  useEffect(() => setHeld(false), [text])
  return {
    held,
    pass: (anyway = false) => {
      if (!anyway && holdForSecret(text)) {
        setHeld(true)
        return false
      }
      setHeld(false)
      return true
    },
    release: () => setHeld(false),
  }
}

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
