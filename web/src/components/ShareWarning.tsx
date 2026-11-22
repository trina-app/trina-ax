// What people being added would see that they could not before (docs/DECISIONS.md "Share in one press", QA TC-3092),
// shown in place while picking, like Google Drive's warning when you add someone from outside. One look for the chat
// Share dialog (components/chat/ChatShareDialog.tsx) and the project members' share of a private chat
// (components/chat/ShareChat.tsx).
//
// Only what is really at stake gets the yellow box: answers that may have used my memories or my personal accounts,
// answers that used files they can't open, other places they can't open, team chat rooms they may not be in. Each is
// one specific sentence ("3 answers used files Mina can't open") on a line of its own, and "Show answers ›" after them
// opens the list of those answers. Names come in as picked (whoNames): a person with the language's honorific ("Bob
// 님"), a group as its people ("Sales 부서 사람들"), never 님 on a group.
// The chat Share dialog uses its compact look (docs/decisions/20261122-share-dialog-lean.md): one line, "Some answers
// used places Bob can't open · your personal memories, groups/x/, My files", answers nobody could check as a short
// second line in the box.
// Nothing at stake, or only answers nobody could check: no box, at most one grey line. The button never changes:
// pressing Share is the confirmation.
import { AlertTriangle, ChevronRight, Info } from 'lucide-react'
import clsx from 'clsx'
import type { ShareCheck } from '@mycel/shared/api'
import { useT } from '../i18n'
import { placeName } from './chat/ShareToRoom'

type T = ReturnType<typeof useT>

/** The people and groups being added, as the share lines name them: a person with the language's honorific
 * (share.who.person: "Bob 님"), a group as its people (share.who.group: "Sales 부서 사람들"); in English both as named. The
 * lines' particle marks then read right after either ("Bob 님이", "Sales 부서 사람들이"). */
export function whoNames(t: T, picks: readonly { subjectType: 'user' | 'group'; name: string }[]): string {
  return picks.filter((p) => p.name).map((p) => t(p.subjectType === 'group' ? 'share.who.group' : 'share.who.person', { name: p.name })).join(t('rooms.nameSep'))
}

/** Is anything at stake (the yellow box)? */
export const shareAtStake = (c: ShareCheck): boolean =>
  c.memoryAnswers > 0 || c.fileAnswers > 0 || c.accountAnswers > 0 || c.places.length > 0 || c.otherPlaces || c.roomsUnseen || (c.devAnswers ?? 0) > 0 || (c.hiddenAnswers ?? 0) > 0

/** The warning's sentences, in order (`names`: who is being added, as picked). */
export function shareWarningLines(t: T, c: ShareCheck, names: string): string[] {
  const places = [...c.places.map((p) => placeName(t, p)), ...(c.otherPlaces ? [t('share.widenList.placeHidden')] : [])]
  return [
    ...(c.memoryAnswers ? [t('share.warn.memories', { n: c.memoryAnswers })] : []),
    ...(c.accountAnswers ? [t('share.warn.accounts', { n: c.accountAnswers })] : []),
    // the files by name and that their content shows (QA TC-7277): the sharer read them, so their names may be told
    ...(c.fileAnswers ? [c.fileNames?.length ? t('share.warn.filesNamed', { n: c.fileAnswers, names, files: c.fileNames.join(', ') }) : t('share.warn.files', { n: c.fileAnswers, names })] : []),
    ...(c.devAnswers ? [t('share.warn.dev', { n: c.devAnswers, names })] : []),
    ...(c.hiddenAnswers ? [t('share.warn.hidden', { n: c.hiddenAnswers, names })] : []),
    ...(places.length ? [t('share.warn.places', { places: places.join(', '), names })] : []),
    ...(c.roomsUnseen ? [t('share.warn.rooms', { names })] : []),
  ]
}

/** The warning as one line (the chat Share dialog's lean look): what is at stake in a few words, then the places
 * themselves after " · " ("Some answers used places Bob can't open · your personal memories, groups/x/, My files"). */
export function shareWarningSummary(t: T, c: ShareCheck, names: string): string {
  const sources = [
    ...(c.memoryAnswers ? [t('share.src.memories')] : []),
    ...(c.accountAnswers ? [t('share.src.accounts')] : []),
    // the files by name when the server names them (QA TC-7277: the sharer read them, so their names may be told)
    ...(c.fileAnswers ? (c.fileNames?.length ? c.fileNames : [t('share.src.files')]) : []),
    ...c.places.map((p) => placeName(t, p)),
    ...(c.otherPlaces ? [t('share.widenList.placeHidden')] : []),
    ...(c.roomsUnseen ? [t('share.src.rooms')] : []),
  ]
  // dev environment answers and answers kept hidden are not a place: their own short sentences (QA TC-7262)
  const more = [
    ...(c.devAnswers ? [t('share.warn.dev', { n: c.devAnswers, names })] : []),
    ...(c.hiddenAnswers ? [t('share.warn.hidden', { n: c.hiddenAnswers, names })] : []),
  ]
  return [...(sources.length ? [`${t('share.warn.summary', { names })} · ${sources.join(', ')}`] : []), ...more].join(' ')
}

/** The one grey line when nothing else needs saying first: answers nobody could check, else `fallback`. */
export function shareGreyLine(t: T, c: ShareCheck | null, fallback: string | null = null): string | null {
  if (c?.unchecked) return t('share.grey.unchecked', { n: c.unchecked })
  return fallback
}

/** My files from the computer a first share copies to them: always a line of its own whenever there are any (security
 * review of #976: a one-press save never copies them without this line on screen), never folded into another line. */
export function shareFilesLine(t: T, c: ShareCheck | null): string | null {
  return c?.earlierFiles ? t('chat.share.earlierFiles', { n: c.earlierFiles }) : null
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
export function ShareWarning({ check, names, onShow, grey = null, compact = false, testId = 'share-warning' }: {
  check: ShareCheck
  names: string
  onShow?: () => void
  grey?: string | null | false
  /** one summary line in place of the sentences, and answers nobody could check as a short second line in the same box
   * (the chat Share dialog; the caller then shows no grey line of its own for them) */
  compact?: boolean
  testId?: string
}) {
  const t = useT()
  const lines = compact ? (shareAtStake(check) ? [shareWarningSummary(t, check, names)] : []) : shareWarningLines(t, check, names)
  const unchecked = compact && check.unchecked ? t('share.grey.unchecked', { n: check.unchecked }) : null
  const answers = check.memoryAnswers + check.fileAnswers + check.accountAnswers
  const line = grey === false ? null : shareGreyLine(t, check, grey)
  const files = grey === false ? null : shareFilesLine(t, check)
  return (
    <>
      {lines.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm leading-6 break-keep [overflow-wrap:anywhere] text-warn" data-testid={testId}>
          <AlertTriangle size={16} className="mt-1 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            {/* one finding per line (a short list when there are several), "Show answers ›" after them */}
            <ul className={clsx(lines.length > 1 && 'list-disc space-y-0.5 pl-4')} data-testid={`${testId}-lines`}>
              {lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
            {unchecked && <p className="mt-0.5 text-xs leading-5" data-testid={`${testId}-unchecked`}>{unchecked}</p>}
            {onShow && answers > 0 && (
              <button type="button" onClick={onShow} className="touch-hit mt-1 inline-flex items-center font-medium text-accent-text hover:underline" data-testid={`${testId}-show`}>
                {t('share.widenList.show')}<ChevronRight size={14} aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}
      {line && <GreyLine text={line} testId={`${testId}-grey`} />}
      {files && <GreyLine text={files} testId={`${testId}-files`} />}
    </>
  )
}
