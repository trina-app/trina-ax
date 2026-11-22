// A person's words in a room (a message, the quote of one, a message being sent) with the web addresses in it as links
// (lib/textLinks.ts: only http and https, never another scheme). A link opens as the links of an AI answer do
// (components/Markdown.tsx, lib/markdown.ts classifyLink): another site in a new tab, without the referrer (the desktop
// app and the phone app hand it to the system browser); a page of this team's app (/rooms/…, /chats/…) in the app
// itself; a team file in the preview panel (the server checks the viewer's access); this server's /api/ addresses stay
// text. The phone app opens https only (mobile/src/protocol.ts navigationDecision): an http link there copies the address
// and says so instead of doing nothing. In the accent colour, underlined (a mention is the accent colour without one), a
// long address breaks after its slashes and anywhere when one piece is still too long for the line. The text itself is
// never changed: copy and edit take the message as it was written.
import clsx from 'clsx'
import { useGuestFolderHref } from '../GuestView'
import { PersonButton } from '../PersonCard'
import { mentionClass, mentionParts } from '../../lib/rooms'
import { guestAppHref } from '../../lib/guests'
import { Fragment, useContext, useMemo, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { classifyLink } from '../../lib/markdown'
import { mobileApp } from '../../lib/mobile'
import { openTeamFile, RoomLinkMessage, type RoomLinkFrom } from '../../lib/sidePanel'
import { addressPieces, linkParts } from '../../lib/textLinks'
import { messagePath, ownMessageLink } from '../../lib/messageLinks'
import { CHIP, MessageLinkChipBody, useLinkHosts, useMessageLinkPreviews } from './MessageLinkChip'
import { appLinkRef, labelIsAddress, type AppLinkRef } from '../../lib/appLinks'
import { AppLinkChipBody, CHIP_UNNAMED, useAppLinkLabel, useAppLinkName, useAppLinkTarget } from '../AppLinkChip'
import { useT } from '../../i18n'
import { toast } from '../../store/ui'
import { useCopy } from '../ui'

const LINK = 'rounded-sm text-accent-text underline decoration-accent-text/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent-text'
/** a touch held this long opened the message's menu (MenuButton useLongPress): the finger lifting is no click */
const LONG_PRESS_MS = 500

const origin = () => (typeof location === 'undefined' ? 'http://localhost' : location.origin)
/** a click the browser should handle itself: a new tab or window, a download */
const ownClick = (e: MouseEvent) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey

/** A person's plain words (never Markdown: a thread reply under an AI answer) with the people it mentions as names in the
 * rooms. mention look (lib/rooms.ts mentionClass; mine on the soft background) that open their card, and its
 * addresses as links. `mentioned`: the ids and the names to look for (the name now and as the list had it, so "@Ben"
 * still stands out after Ben renamed himself). */
export function MentionedText({ text, mentioned, meId }: { text: string; mentioned: { id: string; name: string }[]; meId: string | null }) {
  const parts = useMemo(() => mentionParts(text, mentioned), [text, mentioned])
  return (
    <>
      {parts.map((p, i) => (p.userId ? (
        <PersonButton key={i} user={{ id: p.userId, name: '' }} look="mention" className={clsx(mentionClass(p.userId === meId))} testId="room-mention-person">{p.text}</PersonButton>
      ) : <LinkedText key={i} text={p.text} />))}
    </>
  )
}

/** The words of `text`, its addresses as links. `cut`: the text ends in the "…" of an excerpt; an address cut by it
 * stays text. `oneLine`: the text is one line cut with "…" (a quote): no break inside an address. `menu`: a long press
 * here opens the message's menu (false: a message being sent, which has none). */
export function LinkedText({ text, cut, oneLine, menu = true }: { text: string; cut?: boolean; oneLine?: boolean; menu?: boolean }) {
  const parts = useMemo(() => linkParts(text, { cut }), [text, cut])
  return (
    <>
      {parts.map((p, i) => (p.href ? <RoomLink key={i} href={p.href} text={p.text} oneLine={oneLine} menu={menu} /> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  )
}

/** One link in a person's words: a plain address (`text`, its words) or a Markdown link (`children`, its label: the
 * same opening rules; components/Markdown.tsx PersonMarkdown). A link that may not open is its words, as text. */
export function RoomLink({ href, text, oneLine, menu, children }: { href: string; text?: string; oneLine?: boolean; menu: boolean; children?: ReactNode }) {
  const t = useT()
  const { copy } = useCopy()
  // the last touch on it: when it went down, and whether it was held long enough to open the message's menu
  const press = useRef({ down: 0, long: false })
  // a link to a message of this team that the server gave this viewer a preview of: a chip with the place's name
  // (MessageLinkChip.tsx), opened in the app by its path (also a link on the team address while this page runs on another)
  const previews = useMessageLinkPreviews()
  const hosts = useLinkHosts()
  const own = text !== undefined && previews?.length ? ownMessageLink(href, hosts, origin()) : null
  const preview = own ? previews!.find((p) => p.messageId === own.messageId) : undefined
  const guestFolder = useGuestFolderHref()
  // the message it is in: a team file that does not open offers to ask to view it (components/RoomFileAsk.tsx)
  const from = useContext(RoomLinkMessage)
  const l = classifyLink(href, origin())
  // (classifyLink gives no path that starts with "//": the router would open that as another site, in this tab)
  if (!preview && (l.kind === 'blocked' || (l.kind === 'app' && !/^\/(?![/\\])/.test(l.href)))) return <>{children ?? text}</>
  // (a <wbr> breaks a line even where white-space is nowrap)
  const words: ReactNode = children !== undefined ? children : oneLine || text === undefined ? text : addressPieces(text).map((piece, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {piece}
    </Fragment>
  ))
  const props = {
    className: LINK,
    'data-testid': 'room-link',
    onPointerDown: (e: PointerEvent) => {
      press.current = { down: e.pointerType === 'touch' ? Date.now() : 0, long: false }
    },
    onPointerUp: () => {
      const p = press.current
      press.current = { down: 0, long: p.down > 0 && Date.now() - p.down >= LONG_PRESS_MS }
    },
    onPointerCancel: () => {
      press.current = { down: 0, long: false }
    },
  }
  /** the finger lifting after a long press (the message's menu is open): nothing to open. A click from the keyboard or
   * a screen reader (detail 0) always opens. */
  const held = (e: MouseEvent) => {
    const long = press.current.long
    press.current.long = false
    if (!menu || !long || e.detail === 0) return false
    e.preventDefault()
    return true
  }
  if (preview)
    return (
      <Link to={messagePath(preview)} {...props} className={CHIP} data-testid="message-link-chip" onClick={(e) => void held(e)}>
        <MessageLinkChipBody preview={preview} />
      </Link>
    )
  // a bare address of something in this app (a chat, a project, a conversation, a file link, a folder or a file in
  // Files) on this page's host or the team address: a chip with its name for this viewer (AppLinkChip.tsx). A Markdown
  // link with its own words keeps them.
  const app = !preview && (children === undefined || labelIsAddress(children, href)) ? appLinkRef(href, hosts, origin()) : null
  if (app) return <AppLinkInWords link={app} words={words} props={props} held={held} from={from} />
  // a chat file is opened from its own chat only (a room message shows its words)
  if (l.kind === 'blocked' || l.kind === 'chat-file') return <>{children ?? text}</>
  // a guest has no 파일 screen (/files goes Home): their project's files screen, else plain text (lib/guests.ts)
  const appHref = l.kind !== 'app' ? null : guestFolder ? guestAppHref(l.href, guestFolder) : l.href
  if (l.kind === 'app' && !appHref) return <>{words}</>
  if (l.kind === 'app')
    return (
      <Link to={appHref!} {...props} onClick={(e) => void held(e)}>
        {words}
      </Link>
    )
  if (l.kind === 'team-file')
    return (
      <a
        href={href}
        {...props}
        onClick={(e) => {
          if (held(e) || ownClick(e)) return
          e.preventDefault()
          openTeamFile(l.path, l.at, null, from)
        }}
      >
        {words}
      </a>
    )
  return (
    <a
      href={l.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      {...props}
      onClick={(e) => {
        if (held(e) || !l.href.startsWith('http:') || !mobileApp()) return
        e.preventDefault()
        // (useCopy falls back to a hidden text field where the async clipboard is missing or refused)
        void copy(l.href).then(
          () => toast({ level: 'info', text: t('rooms.linkHttpCopied') }),
          () => toast({ level: 'warn', text: t('rooms.linkHttpApp') }),
        )
      }}
    >
      {words}
    </a>
  )
}

/** RoomLink's chip for a link to something in this app: the same long-press rule as its other links. Where no screen of
 * the viewer's shows it (a guest and a team folder), its words as text, as before. */
function AppLinkInWords({ link, words, props, held, from }: { link: AppLinkRef; words: ReactNode; props: { className: string } & Record<string, unknown>; held: (e: MouseEvent) => boolean; from: RoomLinkFrom | null }) {
  const t = useT()
  const answer = useAppLinkName(link)
  const { label, named } = useAppLinkLabel(link, answer)
  const to = useAppLinkTarget(link)
  if (!to) return <>{words}</>
  const chip = {
    ...props,
    className: named ? CHIP : CHIP_UNNAMED,
    title: named || !answer ? undefined : t('appLinks.noName'),
    'data-testid': 'app-link-chip',
    'data-kind': link.kind,
    'data-named': named ? '' : undefined,
  }
  const body = <AppLinkChipBody link={link} answer={answer} label={label} />
  if (link.kind === 'file')
    return (
      <a
        href={to}
        {...chip}
        onClick={(e) => {
          if (held(e) || ownClick(e)) return
          e.preventDefault()
          openTeamFile(link.path ?? link.id, link.at, null, link.path ? from : null)
        }}
      >
        {body}
      </a>
    )
  return (
    <Link to={to} {...chip} onClick={(e) => void held(e)}>
      {body}
    </Link>
  )
}
