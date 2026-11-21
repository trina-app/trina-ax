// Admin › Home, once (folder sharing, docs/AGENTS/plan/20261116-1330-folder-share-web.md; the design's L6): the owner
// and admins read one line that members can now share folders in their own files,
// and where to turn it off. Closed with ✕ (or followed to Team settings) it never shows again, on any device
// (prefs.folderShareNotice, PATCH /api/me), as the room's one-time line (components/rooms/RoomAskHint.tsx).
import { X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../../i18n'
import { isAdmin, useSession } from '../../store/session'
import { IconButton } from '../../components/ui'

export function FolderShareNotice() {
  const t = useT()
  const state = useSession((s) => (s.status.kind === 'signed-in' && isAdmin(s.status.me) ? s.status.me.user.prefs?.folderShareNotice ?? 'new' : null))
  const [gone, setGone] = useState(false)
  if (state !== 'new' || gone) return null
  const seen = () => {
    setGone(true)
    void useSession.getState().updatePrefs({ folderShareNotice: 'seen' }).catch(() => {})
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-accent-soft/40 py-2 pr-1 pl-3" role="status" data-testid="admin-folder-share-notice">
      <p className="min-w-0 flex-1 text-sm break-keep text-ink">
        {t('adminHome.folderShareNotice')}{' '}
        <Link to="/admin/settings#ts-member-file-shares" onClick={seen} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="admin-folder-share-notice-open">
          {t('adminHome.folderShareNoticeOpen')}
        </Link>
      </p>
      <IconButton tip label={t('common.close')} className="touch-hit shrink-0" onClick={seen} data-testid="admin-folder-share-notice-close">
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  )
}
