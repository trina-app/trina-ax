// The one-time line under a room's header (docs/DECISIONS.md "A welcome for invited people"): "✦ Ask Trina about this
// room. Only you see it." ✦ is the only way into the side chat (rooms have no "@트리나": "Trina side chat, PR 2"), and
// its placeholder was the only place that said so. The line shows in every room until the person closes it (✕) or uses
// ✦ (the line itself opens the side chat too); then never again, on any device (prefs.roomAskHint, PATCH /api/me).
import { X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { aiName } from '../../lib/tabs'
import { useT } from '../../i18n'
import { useSession } from '../../store/session'
import { IconButton } from '../ui'

/** Whether the line shows, and how to put it away for good (`seen`: closed or ✦ used). Shown at once as gone. */
export function useRoomAskHint(): { show: boolean; seen: () => void } {
  // signed out: nothing; signed in: whether it was seen (a plain value, so the selector stays stable)
  const state = useSession((s) => (s.status.kind === 'signed-in' ? s.status.me.user.prefs?.roomAskHint ?? 'new' : null))
  const [gone, setGone] = useState(false)
  const show = state === 'new' && !gone
  const seen = useCallback(() => {
    setGone(true)
    const st = useSession.getState().status
    if (st.kind !== 'signed-in' || st.me.user.prefs?.roomAskHint === 'seen') return
    void useSession.getState().updatePrefs({ roomAskHint: 'seen' }).catch(() => {})
  }, [])
  return { show, seen }
}

export function RoomAskHint({ onAsk, onClose }: { onAsk: () => void; onClose: () => void }) {
  const t = useT()
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-accent-soft/40 py-1 pr-1 pl-4 max-md:pl-3" data-testid="room-ask-hint">
      <button type="button" onClick={onAsk} className="min-h-9 min-w-0 flex-1 truncate text-left text-label text-ink hover:underline max-md:min-h-11" data-testid="room-ask-hint-open">
        {t('rooms.askHint', { name: aiName(t) })}
      </button>
      <IconButton tip label={t('common.close')} className="touch-hit shrink-0" onClick={onClose} data-testid="room-ask-hint-close">
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  )
}
