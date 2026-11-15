// What people being added would see that they could not before (docs/DECISIONS.md "Share in one press", QA TC-3092),
// shown in place while picking, like Google Drive's warning when you add someone from outside. One look for the chat
// Share dialog (components/chat/ChatShareDialog.tsx) and the project members' share of a private chat
// (components/chat/ShareChat.tsx).
//
// Only what is really at stake gets the yellow box: answers that may have used my memories or my personal accounts,
// answers that used files they can't open, other places they can't open, team chat rooms they may not be in. Each is
// one specific sentence ("3 answers used files Mina can't open"), and "Show answers ›" opens the list of those answers.
// Nothing at stake, or only answers nobody could check: no box, at most one grey line. The button never changes:
// pressing Share is the confirmation.
import { AlertTriangle, ChevronRight, Info } from 'lucide-react'
import type { ShareCheck } from '@mycel/shared/api'
import { useT } from '../i18n'
import { placeName } from './chat/ShareToRoom'

type T = ReturnType<typeof useT>

/** Is anything at stake (the yellow box)? */
export const shareAtStake = (c: ShareCheck): boolean =>
  c.memoryAnswers > 0 || c.fileAnswers > 0 || c.accountAnswers > 0 || c.places.length > 0 || c.otherPlaces || c.roomsUnseen

/** The warning's sentences, in order (`names`: who is being added, as picked). */
export function shareWarningLines(t: T, c: ShareCheck, names: string): string[] {
  const places = [...c.places.map((p) => placeName(t, p)), ...(c.otherPlaces ? [t('share.widenList.placeHidden')] : [])]
  return [
    ...(c.memoryAnswers ? [t('share.warn.memories', { n: c.memoryAnswers })] : []),
    ...(c.accountAnswers ? [t('share.warn.accounts', { n: c.accountAnswers })] : []),
    ...(c.fileAnswers ? [t('share.warn.files', { n: c.fileAnswers, names })] : []),
    ...(places.length ? [t('share.warn.places', { places: places.join(', '), names })] : []),
    ...(c.roomsUnseen ? [t('share.warn.rooms', { names })] : []),
  ]
}

/** The one grey line when nothing else needs saying first: answers nobody could check, my earlier files, `fallback`. */
export function shareGreyLine(t: T, c: ShareCheck | null, fallback: string | null = null): string | null {
  if (c?.unchecked) return t('share.grey.unchecked', { n: c.unchecked })
  if (c?.earlierFiles) return t('chat.share.earlierFiles', { n: c.earlierFiles })
  return fallback
}

/** A grey line of the dialog (checking, failed, unchecked, earlier files, a group's later members). */
export function GreyLine({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="flex items-start gap-2 text-sm leading-6 break-keep text-muted" data-testid={testId}>
      <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  )
}

/** The warning box (nothing when nothing is at stake) and at most one grey line under it (`grey`: the line when the
 * check has none of its own; false: the caller shows the grey line itself). `onShow`: open the list of the answers it is
 * about (only when it is about answers). */
export function ShareWarning({ check, names, onShow, grey = null, testId = 'share-warning' }: {
  check: ShareCheck
  names: string
  onShow?: () => void
  grey?: string | null | false
  testId?: string
}) {
  const t = useT()
  const lines = shareWarningLines(t, check, names)
  const answers = check.memoryAnswers + check.fileAnswers + check.accountAnswers
  const line = grey === false ? null : shareGreyLine(t, check, grey)
  return (
    <>
      {lines.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm leading-6 break-keep [overflow-wrap:anywhere] text-warn" data-testid={testId}>
          <AlertTriangle size={16} className="mt-1 shrink-0" aria-hidden />
          <span className="min-w-0">
            {lines.join(' ')}
            {onShow && answers > 0 && (
              <>
                {' '}
                <button type="button" onClick={onShow} className="touch-hit inline-flex items-center font-medium text-accent-text hover:underline" data-testid={`${testId}-show`}>
                  {t('share.widenList.show')}<ChevronRight size={14} aria-hidden />
                </button>
              </>
            )}
          </span>
        </div>
      )}
      {line && <GreyLine text={line} testId={`${testId}-grey`} />}
    </>
  )
}
