// Admin › Home, once, for the office owner (QA TC-4470; server/src/office/claude-mcp-notice.ts): in office mode with this
// Mac's own Claude sign-in, the server takes the Claude Code connections out of this Mac account's settings. A new
// install asks first; an installation that updated into it only gets this card: what was removed, why, where the copy
// is, and how to switch to the sign-in token instead and put them back. Closed, it never shows again (prefs.officeMcpNotice).
import { ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OfficeClaudeMcpNotice } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { isOwner, useSession } from '../../store/session'
import { Button, IconButton } from '../../components/ui'

export function OfficeMcpNotice() {
  const t = useT()
  const state = useSession((s) => (s.status.kind === 'signed-in' && isOwner(s.status.me) ? s.status.me.user.prefs?.officeMcpNotice ?? 'new' : null))
  const [notice, setNotice] = useState<OfficeClaudeMcpNotice | null>(null)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (state !== 'new') return
    let off = false
    api.call(API.officeClaudeMcpNotice).then((n) => { if (!off) setNotice(n) }, () => {})
    return () => { off = true }
  }, [state])
  if (state !== 'new' || gone || !notice) return null
  const seen = () => {
    setGone(true)
    void useSession.getState().updatePrefs({ officeMcpNotice: 'seen' }).catch(() => {})
  }
  const names = notice.names.join(', ')
  const removed = !notice.names.length ? t('officeMcpNotice.removedOther')
    : notice.moreNames ? t('officeMcpNotice.removedMore', { names, count: notice.moreNames }) : t('officeMcpNotice.removed', { names })
  const code = 'mt-1 block overflow-x-auto rounded-md bg-subtle px-2 py-1 font-mono text-xs whitespace-pre text-ink'
  return (
    <section aria-labelledby="admin-office-mcp" data-testid="admin-office-mcp-notice">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2 text-sm break-words">
          <h2 id="admin-office-mcp" className="text-title-sm font-semibold">{t('officeMcpNotice.title')}</h2>
          <p className="text-ink">{t('officeMcpNotice.why')}</p>
          <p className="font-medium text-ink" data-testid="admin-office-mcp-removed">{removed}</p>
          <div>
            <p className="text-muted">{t('officeMcpNotice.backup')}</p>
            <code className={code} data-testid="admin-office-mcp-folder">{notice.backupFolder}</code>
          </div>
          <div>
            <p className="text-muted">{t('officeMcpNotice.switch')}</p>
            <code className={code}>{`${notice.teamax} configure --claude-token-file <file>`}</code>
          </div>
          <div>
            <p className="text-muted">{t('officeMcpNotice.restore')}</p>
            <code className={code}>{`${notice.teamax} claude-mcp restore <copy>`}</code>
          </div>
          <Button size="sm" variant="primary" onClick={seen} data-testid="admin-office-mcp-ok">{t('officeMcpNotice.ok')}</Button>
        </div>
        <IconButton tip label={t('common.close')} className="touch-hit shrink-0" onClick={seen} data-testid="admin-office-mcp-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
    </section>
  )
}
