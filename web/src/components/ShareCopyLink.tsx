// "Copy link" at the bottom left of a Share dialog (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933): the
// file's (components/FileShareDialog.tsx), a chat's (components/chat/ChatShareDialog.tsx) and a project's
// (components/ProjectMembersDialog.tsx, pages/Projects.tsx ShareProjectDialog), one button for all of them. It copies
// the thing's own address (a chat's /c/<id>, a project's /projects/<id>, a file's /f/<id>) on the team address
// (lib/team-address.ts teamOrigin, as a message's Copy link: never the 192.168.x.x the desktop app may be at), and an
// address on this computer only (127.0.0.1: a tunnel, no team address yet) says so in the toast of a copy, not as a
// fixed line in the dialog (components/LocalLinkNote.tsx localLinkToast; QA TC-ask1-14). It opens only for people who can already open it, everyone else gets the plain "not
// found" page. While people are picked but not saved yet, one short line above the buttons says the link works for them
// only after the save (`unsaved`: the save button's words). A copy the browser refuses says so, with the link to copy by
// hand, never "Link copied".
import type { Project } from '@mycel/shared/api'
import { useT } from '../i18n'
import { teamOrigin } from '../lib/team-address'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { localLinkToast } from './LocalLinkNote'
import { Button, useCopy } from './ui'

const pageOrigin = () => (typeof location === 'undefined' ? '' : location.origin)

/** The origin copied links are made on: the team address when there is one, else this page's. */
export function useTeamOrigin(): string {
  const me = useMe()
  return teamOrigin(me?.team?.address, pageOrigin())
}

/** The address of a project's page (the app's own route; someone who cannot see the project gets "not found"), on
 * `origin` (the team origin: useTeamOrigin). */
export const projectLink = (id: string, origin = pageOrigin()) => `${origin}/projects/${id}`

/** Copies a link; true when it reached the clipboard. A refused copy (both ways failed) says so with the link itself in
 * the toast, to copy by hand. */
export function useCopyLink() {
  const t = useT()
  const { copy } = useCopy()
  return async (href: string): Promise<boolean> => {
    const ok = await copy(href)
    if (!ok) toast({ level: 'error', text: t('roomApps.copyFailed'), detail: href, ms: 15_000 })
    return ok
  }
}

/** Copy link of a project's Share dialogs: its page's address, and the file link's words for who opens it (a personal
 * project: only me until it is shared); an address on this computer only says so in the toast. */
export function useCopyProjectLink() {
  const t = useT()
  const origin = useTeamOrigin()
  const copy = useCopyLink()
  return async (p: Pick<Project, 'id' | 'folderPath'>) => {
    const href = projectLink(p.id, origin)
    if (!(await copy(href))) return
    toast({ level: 'success', text: t(p.folderPath.startsWith('users/') ? 'fileLink.copiedOnlyYou' : 'fileLink.copied'), ...localLinkToast(t, href) })
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
