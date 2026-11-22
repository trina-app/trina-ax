// What my_folders found (server/src/chat/my-folders.ts; docs/decisions/20261122-demo-permission-scene.md): the folders
// the person's AI can see, each with its access, under an answer that could not find a folder or a file they asked for.
// Drawn from the server's record on the step (Step.folders), never from the AI's words. Only folders they can open are
// there: a folder hidden from them is never named, so the card reads the same whether what they asked for is missing
// or not open to them. Each row opens the folder in Files; no button.
import { Folder } from 'lucide-react'
import type { Step } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useFolderWords } from '../../lib/folderLabels'
import { ListRow } from '../list/List'
import { ActionCard, ActionNote, ActionRows } from './ActionCard'

export default function MyFoldersCard({ folders, more }: { folders: NonNullable<Step['folders']>; more?: number }) {
  const t = useT()
  const words = useFolderWords()
  const title = t('myFoldersCard.title')
  return (
    <ActionCard title={title} label={title} testId="my-folders-card">
      <ActionRows testId="my-folders-card-rows">
        {folders.map((f) => {
          const name = words.path(f.path, ' / ')
          return (
            <ListRow key={f.path} icon={<Folder aria-hidden />} name={name} nameTitle={name} to={`/files?path=${encodeURIComponent(f.path)}`}
              tag={t(f.access === 'edit' ? 'myFoldersCard.canEdit' : 'myFoldersCard.readOnly')} tagTestId="my-folders-card-access" testId="my-folders-card-folder" />
          )
        })}
      </ActionRows>
      {more ? <ActionNote testId="my-folders-card-more">{t('myFoldersCard.more', { n: more })}</ActionNote> : null}
    </ActionCard>
  )
}
