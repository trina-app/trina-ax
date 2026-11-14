// The linked message under a message that links to it (docs/DECISIONS.md "Message links and their previews"): who wrote
// it, when, where (as the chip names it), its words (six lines, then "Show more"), its files as one line, and for a
// snapshot the sender chose to show ("Show message") who shared it. The whole card opens the message in the app (the room
// at it, centred and marked; a reply in its thread); its own links sit above that button (the Quote pattern of
// RoomMessages.tsx). What it holds is what the server decided this viewer may see (RoomMessage.linkPreviews); a deleted
// original is its header and "This message was deleted". On the sender's own message a ✕ removes it for everyone.
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RoomLinkPreview } from '@mycel/shared/api'
import { formatDateTime } from '../../lib/format'
import { messagePath } from '../../lib/messageLinks'
import { unescapeAppBody } from '../../lib/roomApps'
import type { MessageMention } from '../../lib/messageMarkdown'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf, useNameOf } from '../../store/people'
import { Avatar } from '../Avatar'
import { Markdown, PersonMarkdown } from '../LazyMarkdown'
import { Tooltip } from '../Tooltip'
import { AiFace } from './AiFace'
import { AppTile } from './apps/AppParts'
import { MessageLinkPreviews, usePlaceLabel } from './MessageLinkChip'

/** a touch held this long opened the message's menu: the finger lifting is no click (MessageText.tsx RoomLink) */
const LONG_PRESS_MS = 500

function CardFace({ p }: { p: RoomLinkPreview }) {
  const user = useAvatarOf(p.author)
  if (p.app) return <AppTile kind={p.app.kind} size="title" />
  if (p.authorKind === 'ai') return <AiFace size={22} />
  return user ? <Avatar user={user} size={24} className="select-none" /> : <span aria-hidden className="size-6 shrink-0 rounded-full bg-hover" />
}

/** `nested`: the previews of the message around it (a link in the card's words is a chip, never a card); `onRemove`:
 * the sender's "Remove preview"; `still`: it opens nothing (the box's "Show message" card, before the send). */
export function MessageLinkCard({ p, nested, onRemove, still = false }: { p: RoomLinkPreview; nested: readonly RoomLinkPreview[]; onRemove?: () => void; still?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const nameOf = useNameOf()
  const navigate = useNavigate()
  const place = usePlaceLabel()(p)
  const name = p.app ? p.app.name : p.authorKind === 'ai' ? t('rooms.aiName') : (nameOf(p.author) ?? t('rooms.goneUser'))
  const time = formatDateTime(p.createdAt, locale)
  const mentions: MessageMention[] = p.mentions.map((id) => ({ id, name: nameOf({ id, name: '' }) ?? '' })).filter((x) => x.name)
  // six lines, then "Show more" in place
  const words = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = words.current
    if (!el || open) return
    setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [p.body, open])
  // a long press opened the message's menu: the finger lifting does not open the card
  const press = useRef(0)
  const held = useRef(false)
  const edited = p.editedAt && !p.deleted ? <span className="ml-1 text-xs text-faint select-none">{t('rooms.edited')}</span> : null
  const files = p.files.count > 0 ? [t('rooms.lastFiles', { n: p.files.count }), p.files.first?.name].filter(Boolean).join(' · ') : null
  return (
    <div className="group/card relative mt-1 mb-0.5 max-w-xl rounded-lg border border-line bg-surface px-3 py-2 hover:border-line-strong" data-testid="message-link-card" data-snapshot={p.sharedBy !== undefined ? '' : undefined} data-deleted={p.deleted ? '' : undefined}>
      {!still && <button
        type="button"
        aria-label={t('rooms.link.cardLabel', { name, place, time })}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent"
        onPointerDown={(e: PointerEvent) => {
          press.current = e.pointerType === 'touch' ? Date.now() : 0
          held.current = false
        }}
        onPointerUp={() => {
          held.current = press.current > 0 && Date.now() - press.current >= LONG_PRESS_MS
          press.current = 0
        }}
        onClick={(e) => {
          if (held.current && e.detail !== 0) {
            held.current = false
            return
          }
          navigate(messagePath(p))
        }}
        data-testid="message-link-card-open"
      />}
      <p className="flex min-w-0 items-center gap-2 text-xs text-faint">
        <CardFace p={p} />
        <span className="truncate text-sm font-medium text-ink">{name}</span>
        <time dateTime={p.createdAt} className="shrink-0">{time}</time>
        <span className="min-w-0 truncate max-md:hidden" data-testid="message-link-card-place">{place}</span>
      </p>
      {p.deleted ? (
        <p className="mt-1 text-reading leading-reading text-faint">{t('rooms.deleted')}</p>
      ) : (
        <>
          {p.body && (
            <div ref={words} className={clsx('mt-1 [&_a]:relative', !open && 'line-clamp-6')} data-testid="message-link-card-text">
              <MessageLinkPreviews.Provider value={nested}>
                {p.app ? (
                  <p className="text-reading leading-reading break-words whitespace-pre-wrap text-ink">{unescapeAppBody(p.body)}</p>
                ) : p.authorKind === 'ai' || p.openable ? (
                  <Markdown text={p.body} className="min-w-0" openable={new Set(p.openable ?? [])} />
                ) : (
                  <PersonMarkdown text={p.body} mentions={mentions} className="min-w-0" after={edited} />
                )}
              </MessageLinkPreviews.Provider>
            </div>
          )}
          {!p.body && edited}
          {clipped && !open && (
            <button type="button" onClick={() => setOpen(true)} className="relative mt-0.5 text-xs font-medium text-accent-text hover:underline" data-testid="message-link-card-more">
              {t('rooms.link.showMore')}
            </button>
          )}
          {files && <p className="mt-1 truncate text-xs text-muted" data-testid="message-link-card-files">{files}</p>}
        </>
      )}
      {p.sharedBy !== undefined && (
        <p className="mt-1 text-xs text-faint" data-testid="message-link-card-shared-by">{t('rooms.link.sharedBy', { name: nameOf(p.sharedBy) ?? t('rooms.goneUser') })}</p>
      )}
      {onRemove && (
        <Tooltip label={t('rooms.link.removePreview')}>
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('rooms.link.removePreview')}
            className="absolute top-1.5 right-1.5 rounded-md p-1 text-faint opacity-0 transition hover:bg-hover hover:text-ink group-hover/card:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
            data-testid="message-link-card-remove"
          >
            <X size={14} aria-hidden />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
