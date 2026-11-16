// What change_folder_access did (docs/decisions/20261116-team-folder-ai-and-ask.md): a team folder's access changed for
// one person or group after the admin's yes on the server's card. Drawn from the server's record on the step
// (`Step.shared.teamFolder`, the shared card record), never from the AI's words: "Sales group can now view Reports",
// the folder with its place in words (never a path), the person or group, then plain lines: how many people can open it
// before and after, who got or lost access, what happened to files inside shared one by one. No button: the folder's
// own Share in Files is where it is changed again. Only the person whose turn it was gets the record.
import { Folder, Users } from 'lucide-react'
import type { StepShared, TeamFolderResult } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { whoWords } from '../../lib/shareCard'
import { Avatar } from '../Avatar'
import { ListRow } from '../list/List'
import { ActionCard, ActionNote, ActionRows } from './ActionCard'

const listOf = (locale: string, items: string[]) => {
  try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items) } catch { return items.join(', ') }
}

export default function TeamFolderCard({ shared, folder }: { shared: StepShared; folder: TeamFolderResult }) {
  const t = useT()
  const locale = useLocale()
  const who = whoWords(t, locale, shared.who)
  const refused = shared.outcome === 'refused'
  const title0 = refused
    ? t('teamFolderCard.refused', { folder: folder.name })
    : folder.action === 'remove' ? t('teamFolderCard.removed', { who, folder: folder.name })
    : t(folder.access === 'edit' ? 'teamFolderCard.canEdit' : 'teamFolderCard.canView', { who, folder: folder.name })
  // the headline starts a sentence ("The Sales group can now view Reports")
  const title = title0.charAt(0).toLocaleUpperCase(locale) + title0.slice(1)
  const names = (xs: string[], n: number) => (n > xs.length ? t('shareCard.andMorePeople', { list: xs.join(', '), n: n - xs.length }) : listOf(locale, xs))
  const notes: string[] = []
  if (refused) notes.push(shared.refusal?.reason === 'changed' ? t('shareCard.why.changed') : t('shareCard.why.failed'))
  else {
    notes.push(t('teamFolderCard.counts', { before: folder.before, after: folder.after }))
    if (folder.gainedCount) notes.push(t('teamFolderCard.gained', { names: names(folder.gained, folder.gainedCount) }))
    if (folder.lostCount) notes.push(t('teamFolderCard.lost', { names: names(folder.lost, folder.lostCount) }))
    if (folder.action !== 'remove' && shared.who.some((w) => w.subjectType === 'group')) notes.push(t('shareCard.note.groupLater'))
    if (folder.fileShares) notes.push(t(folder.fileShares === 'removed' ? 'teamFolderCard.fileSharesRemoved' : 'teamFolderCard.fileSharesKept'))
  }
  const level = folder.access === 'edit' ? t('teamFolderCard.canEditTag') : t('fileShare.canView')
  return (
    <ActionCard title={title} label={title} testId="team-folder-card" state={refused ? 'refused' : shared.outcome} kind={folder.action}>
      <ActionRows testId="team-folder-card-rows">
        <ListRow icon={<Folder aria-hidden />} name={folder.name} nameTitle={folder.name} meta={folder.place && folder.place !== folder.name ? folder.place : undefined} testId="team-folder-card-folder" />
        {shared.who.map((w) => (
          <ListRow key={`${w.subjectType}:${w.subjectId}`} face icon={w.subjectType === 'group' ? <Users /> : <Avatar user={{ id: w.subjectId, name: w.name, avatarVersion: w.avatarVersion }} size="fill" />}
            name={w.name} tag={refused || folder.action === 'remove' ? undefined : level} testId="team-folder-card-who" />
        ))}
      </ActionRows>
      {notes.map((n, i) => <ActionNote key={i} testId="team-folder-card-note">{n}</ActionNote>)}
    </ActionCard>
  )
}
