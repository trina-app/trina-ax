// A link to something in this app as its name (docs/decisions/20261118-named-app-links.md): a pasted address of a chat,
// a project, a conversation, a file link, a folder or a file shows as a small chip, the place's icon and the name the
// server gave this viewer (store/linkNames.ts, POST /api/link-names), still a link that opens in the app. Without a
// name (they cannot open it, it is not there, or it is still being asked) the chip says only what kind of thing it is
// ("Trina file"): the same words for every reason, so nothing says whether it exists. The name is plain text.
// The link pieces draw it: a person's words (rooms/MessageText.tsx RoomLink) and AI answers (Markdown.tsx).
import clsx from 'clsx'
import { FileText, Folder, Hash, MessageCircle, Sparkles, SquareKanban, type LucideIcon } from 'lucide-react'
import { useEffect, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useT, type MessageKey } from '../i18n'
import { appLinkKey, type AppLinkRef } from '../lib/appLinks'
import { useGuestFolderHref } from './GuestView'
import { guestAppHref } from '../lib/guests'
import { openTeamFile } from '../lib/sidePanel'
import { useLinkNames, wantLinkName, type LinkNameAnswer } from '../store/linkNames'
import { CHIP } from './rooms/MessageLinkChip'
import { useRoomTitle } from './rooms/RoomIcon'

/** A chip without a name: the same shape, quieter (the words name only the kind of thing). */
export const CHIP_UNNAMED = 'rounded-md bg-subtle px-1 py-px font-medium text-muted no-underline [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent'

const GENERIC: Record<AppLinkRef['kind'], MessageKey> = {
  chat: 'appLinks.chat',
  project: 'appLinks.project',
  room: 'appLinks.room',
  share: 'appLinks.file',
  file: 'appLinks.file',
  folder: 'appLinks.folder',
}

function iconOf(link: AppLinkRef, a: LinkNameAnswer | undefined): LucideIcon {
  if (link.kind === 'chat') return Sparkles
  if (link.kind === 'project') return SquareKanban
  if (link.kind === 'room') return a?.room?.kind === 'dm' || a?.room?.kind === 'group' ? MessageCircle : Hash
  if (link.kind === 'folder' || a?.folder) return Folder
  return FileText
}

/** This link's answer, asked for when it is not known (or old). */
export function useAppLinkName(link: AppLinkRef): LinkNameAnswer | undefined {
  const key = appLinkKey(link)
  const a = useLinkNames((s) => s.byKey[key])
  useEffect(() => { wantLinkName({ kind: link.kind, id: link.id }) }, [link.kind, link.id])
  return a
}

/** The words of the chip: the name for this viewer, else the kind of thing. */
export function useAppLinkLabel(link: AppLinkRef, a: LinkNameAnswer | undefined): { label: string; named: boolean } {
  const t = useT()
  const title = useRoomTitle()
  if (!a || a.name === null) return { label: t(GENERIC[link.kind]), named: false }
  if (link.kind === 'room' && a.room) {
    const name = title({ kind: a.room.kind, name: a.room.name, peers: a.room.peers, memberCount: a.room.memberCount })
    return { label: a.room.kind === 'team' || a.room.kind === 'all' ? `#${name}` : name, named: true }
  }
  if (link.kind === 'chat' && !a.name) return { label: t('chat.untitled'), named: true }
  return { label: a.name || t(GENERIC[link.kind]), named: true }
}

/** What goes inside the chip's link: the icon, then the label (or `label`: the author's own words for the link). */
export function AppLinkChipBody({ link, answer, label }: { link: AppLinkRef; answer: LinkNameAnswer | undefined; label: string }) {
  const Icon = iconOf(link, answer)
  return (
    <>
      <Icon size={14} aria-hidden className="mr-1 inline-block shrink-0 align-[-2px]" />
      {label}
    </>
  )
}

/** Where the chip opens for this viewer: the page in the app (a guest's folder: their project's files screen,
 * lib/guests.ts), or null where no screen of theirs shows it (the chip is then its words, not a link). A file opens in
 * the preview panel by its path (as a team-file link does), whoever opens it: the server checks their access. */
export function useAppLinkTarget(link: AppLinkRef): string | null {
  const guestFolder = useGuestFolderHref()
  if (link.kind === 'file') return link.to
  return guestFolder ? guestAppHref(link.to, guestFolder) : link.to
}

/** a click the browser should handle itself: a new tab or window, a download */
export const ownClick = (e: MouseEvent) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey

/** A whole chip for an AI answer (Markdown.tsx), for a bare address: opens in the app; a file in the preview panel. */
export function AppLinkChip({ link }: { link: AppLinkRef }) {
  const t = useT()
  const answer = useAppLinkName(link)
  const { label, named } = useAppLinkLabel(link, answer)
  const to = useAppLinkTarget(link)
  const props = {
    className: clsx('not-prose', named ? CHIP : CHIP_UNNAMED),
    title: named ? undefined : t('appLinks.noName'),
    'data-testid': 'app-link-chip',
    'data-kind': link.kind,
    'data-named': named ? '' : undefined,
  }
  const body = <AppLinkChipBody link={link} answer={answer} label={label} />
  if (!to) return <span {...props}>{body}</span>
  if (link.kind === 'file')
    return (
      <a href={to} {...props} onClick={(e) => { if (ownClick(e)) return; e.preventDefault(); openTeamFile(link.path ?? link.id) }}>
        {body}
      </a>
    )
  return <Link to={to} {...props}>{body}</Link>
}
