// A person's words in a room (a message, the quote of one, a message being sent) with the web addresses in it as links
// (lib/textLinks.ts: only http and https, never another scheme). A link opens as the links of an AI answer do
// (components/Markdown.tsx, lib/markdown.ts classifyLink): another site in a new tab, without the referrer (the desktop
// app and the phone app hand it to the system browser); a page of this team's app (/rooms/…, /chats/…) in the app
// itself; a team file in the preview panel (the server checks the viewer's access); this server's /api/ addresses stay
// text. The phone app opens https only (mobile/src/protocol.ts navigationDecision): an http link there copies the address
// and says so instead of doing nothing. In the accent colour, underlined (a mention is the accent colour without one), a
// long address breaks after its slashes and anywhere when one piece is still too long for the line. The text itself is
// never changed: copy and edit take the message as it was written.
import { Fragment, useMemo, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { classifyLink } from '../../lib/markdown'
import { mobileApp } from '../../lib/mobile'
import { openTeamFile } from '../../lib/sidePanel'
import { addressPieces, linkParts } from '../../lib/textLinks'
import { useT } from '../../i18n'
import { toast } from '../../store/ui'
import { useCopy } from '../ui'

const LINK = 'rounded-sm text-accent-text underline decoration-accent-text/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent-text'
/** a touch held this long opened the message's menu (MenuButton useLongPress): the finger lifting is no click */
const LONG_PRESS_MS = 500

const origin = () => (typeof location === 'undefined' ? 'http://localhost' : location.origin)
/** a click the browser should handle itself: a new tab or window, a download */
const ownClick = (e: MouseEvent) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey

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

function RoomLink({ href, text, oneLine, menu }: { href: string; text: string; oneLine?: boolean; menu: boolean }) {
  const t = useT()
  const { copy } = useCopy()
  // the last touch on it: when it went down, and whether it was held long enough to open the message's menu
  const press = useRef({ down: 0, long: false })
  const l = classifyLink(href, origin())
  // (classifyLink gives no path that starts with "//": the router would open that as another site, in this tab)
  if (l.kind === 'blocked' || (l.kind === 'app' && !/^\/(?![/\\])/.test(l.href))) return <>{text}</>
  // (a <wbr> breaks a line even where white-space is nowrap)
  const words: ReactNode = oneLine ? text : addressPieces(text).map((piece, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {piece}
    </Fragment>
  ))
  const own = {
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
  if (l.kind === 'app')
    return (
      <Link to={l.href} {...own} onClick={(e) => void held(e)}>
        {words}
      </Link>
    )
  if (l.kind === 'team-file')
    return (
      <a
        href={href}
        {...own}
        onClick={(e) => {
          if (held(e) || ownClick(e)) return
          e.preventDefault()
          openTeamFile(l.path, l.at)
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
      {...own}
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
