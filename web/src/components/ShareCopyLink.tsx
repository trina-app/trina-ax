// "Copy link" at the bottom left of a Share dialog (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933): the
// file's (components/FileShareDialog.tsx), a chat's (components/chat/ChatShareDialog.tsx) and a project's
// (components/ProjectMembersDialog.tsx, pages/Projects.tsx ShareProjectDialog), one button for all of them. It copies
// the thing's own address (a chat's /c/<id>, a project's /projects/<id>, a file's /f/<id>): it opens only for people who
// can already open it, everyone else gets the plain "not found" page. While people are picked but not saved yet, one
// short line above the buttons says the link works for them only after the save (`unsaved`: the save button's words).
import type { Project } from '@mycel/shared/api'
import { useT } from '../i18n'
import { toast } from '../store/ui'
import { Button, useCopy } from './ui'

/** The address of a project's page (the app's own route; someone who cannot see the project gets "not found"). */
export const projectLink = (id: string) => `${typeof location === 'undefined' ? '' : location.origin}/projects/${id}`

/** Copy link of a project's Share dialogs: its page's address, and the file link's words for who opens it (a personal
 * project: only me until it is shared). */
export function useCopyProjectLink() {
  const t = useT()
  const { copy } = useCopy()
  return async (p: Pick<Project, 'id' | 'folderPath'>) => {
    await copy(projectLink(p.id))
    toast({ level: 'success', text: t(p.folderPath.startsWith('users/') ? 'fileLink.copiedOnlyYou' : 'fileLink.copied') })
  }
}

export function ShareCopyLink({ onCopy, unsaved, testId }: { onCopy: () => void; unsaved?: string | null; testId: string }) {
  const t = useT()
  return (
    <>
      {unsaved && <p className="mr-auto w-full text-sm break-keep text-muted" data-testid={`${testId}-unsaved`}>{t('share.linkAfterSave', { button: unsaved })}</p>}
      <Button variant="secondary" onClick={onCopy} className="mr-auto max-sm:shrink-0" data-testid={testId}>{t('rooms.menu.copyLink')}</Button>
    </>
  )
}
