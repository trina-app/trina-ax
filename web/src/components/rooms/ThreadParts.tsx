// The parts every thread panel has, the same in a room's thread (ThreadPanel.tsx) and in the thread under a shared
// chat's AI answer (components/chat/ChatThreadPanel.tsx): the header (‹ on phones, "Thread" and where it is, ✕) and the
// hairline with how many replies.
import clsx from 'clsx'
import { ChevronLeft, X } from 'lucide-react'
import { useT } from '../../i18n'
import { IconButton } from '../ui'

/** `closeX`: the ✕ at every width, never the phone's ‹. `testIds`: the prefix of its test ids ("thread", "chat-thread") */
export function ThreadHead({ where, onClose, closeX = false, testIds, whereTestId }: { where: string; onClose: () => void; closeX?: boolean; testIds: string; whereTestId: string }) {
  const t = useT()
  return (
    // the ✕ keeps the same 16 px from the right edge as the replies and the reply box
    <div className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line', closeX ? 'pr-2 pl-4 md:px-4' : 'px-2 max-md:pl-0.5 md:px-4')}>
      {!closeX && (
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid={`${testIds}-back`}>
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
      )}
      <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-title-sm font-semibold text-ink">{t('rooms.thread')}</span>
        <span className="truncate text-xs text-faint" data-testid={whereTestId}>{where}</span>
      </h2>
      <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className={clsx('touch-hit', !closeX && 'max-md:hidden')} data-testid={`${testIds}-close`}>
        <X size={16} aria-hidden />
      </IconButton>
    </div>
  )
}

/** The hairline under the root: "3 replies", or "No replies yet" */
export function ThreadCountLine({ count, testId }: { count: number; testId: string }) {
  const t = useT()
  return (
    <div role="separator" className="flex items-center gap-3 pt-3 pb-1 text-xs text-faint" data-testid={testId}>
      {count > 0 ? t('rooms.threadReplies', { n: count }) : t('rooms.threadNone')}
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  )
}
