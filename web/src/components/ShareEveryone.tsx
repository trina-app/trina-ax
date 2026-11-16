// "Everyone on the team" for file shares (QA TC-3509, docs/decisions/20261116-file-share-everyone.md): the option at the
// top of the people-and-groups search of the file Share dialog (FileShareDialog.tsx) and of Find work files' share step
// (onboarding/ShareFoundFiles.tsx), and the one line that says what it does before the press. It is a group entry with
// the reserved id FILE_SHARE_EVERYONE: every active member, also people who join later, never a guest.
import { Users } from 'lucide-react'
import { useMemo } from 'react'
import { FILE_SHARE_EVERYONE, type ProjectParticipant } from '@mycel/shared/api'
import { useT } from '../i18n'
import type { ParticipantOption } from './ProjectParticipants'

export const EVERYONE_KEY = `group:${FILE_SHARE_EVERYONE}`
export const isEveryone = (x: { subjectType: string; subjectId: string }) => x.subjectType === 'group' && x.subjectId === FILE_SHARE_EVERYONE

/** The picker's options with "Everyone on the team" first (any other copy of it, from the rows the server sent, left
 * out). */
export function useWithEveryone(options: readonly ParticipantOption[]): ParticipantOption[] {
  const t = useT()
  return useMemo(() => [
    { subjectType: 'group' as const, subjectId: FILE_SHARE_EVERYONE, name: t('fileShare.everyone'), kind: t('fileShare.everyoneKind'), first: true },
    ...options.filter((o) => !isEveryone(o)),
  ], [options, t])
}

/** Before the press: the whole team will be able to open what is shared: "this file" (the Share dialog), or `files`, how
 * many files the press shares (Find work files' step). */
export function EveryoneLine({ picks, files, testId = 'share-everyone-line' }: { picks: readonly ProjectParticipant[]; files?: number; testId?: string }) {
  const t = useT()
  if (!picks.some(isEveryone)) return null
  return (
    <p className="flex items-start gap-2 text-sm leading-6 break-keep text-ink" role="status" data-testid={testId}>
      <Users size={16} className="mt-1 shrink-0 text-accent-text" aria-hidden />
      <span className="min-w-0">{files !== undefined ? t('fileShare.everyoneLineMany', { n: files }) : t('fileShare.everyoneLineOne')}</span>
    </p>
  )
}
