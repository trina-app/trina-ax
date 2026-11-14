// The widening list (docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden", owner 2026-11-14):
// the answers the people being added would start seeing although they used places some of them can't open. Opened from
// the warning line of a sharing dialog (the project Members dialog now, a chat's Share dialog later); it replaces the
// dialog's body in place (the picks stay) and ‹ goes back to them. The server's list (POST
// /api/sharing/widening-answers): the caller's own view, 20 a page, newest first.
//
// Each item: the chat (left out when the list is about one chat), who asked and when, the answer's first line, the
// places it used (by name only where the caller may open them, else "a place you can't open") and, with several people
// or groups picked, which of them can't open it. On a computer an item opens the answer in a new tab (the dialog and
// its picks stay as they are); on a phone on this screen (`onOpen`: the dialog keeps its draft first, and the chat page
// has "‹ Back to sharing").
import clsx from 'clsx'
import { ExternalLink, Folder, Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WideningAnswer, WideningAnswersBody } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'
import { formatMonthDay } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { Avatar } from './Avatar'
import { Button, ErrorNote, Skeleton } from './ui'
import { pageRowBox } from './list/List'

/** Where an item opens: the chat at that answer (pages/Chat.tsx `?answer=`). */
export const answerHref = (a: Pick<WideningAnswer, 'chatId' | 'messageId'>) => `/c/${a.chatId}?answer=${encodeURIComponent(a.messageId)}`

export function WideningList({ target, add, names, phone, oneChat = false, initialScroll = 0, onScroll, onOpen, scroller }: {
  target: WideningAnswersBody['target']
  add: WideningAnswersBody['add']
  /** the people and groups being added, as picked ("Sales and Sam") */
  names: string
  phone: boolean
  /** the list is about one chat (its title is left out) */
  oneChat?: boolean
  initialScroll?: number
  onScroll?: (top: number) => void
  /** a phone: open the answer on this screen (the caller keeps the dialog's draft first) */
  onOpen?: (a: WideningAnswer) => void
  /** the element that scrolls the list (the dialog's body), for the scroll kept in the draft */
  scroller?: () => HTMLElement | null
}) {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<WideningAnswer[] | null>(null)
  const [total, setTotal] = useState(0)
  const [capped, setCapped] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const restored = useRef(false)
  const key = JSON.stringify([target, add])

  const first = async (live: () => boolean) => {
    setFailed(false)
    try {
      const r = await api.call(API.wideningAnswers, { body: { target, add } })
      if (!live()) return
      setItems(r.items); setTotal(r.total); setCapped(r.totalCapped); setCursor(r.nextCursor)
    } catch {
      if (live()) { setItems((x) => x ?? []); setFailed(true) }
    }
  }
  useEffect(() => {
    let on = true
    setItems(null)
    void first(() => on)
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // the scroll kept in a phone's draft, once the first page is here
  useEffect(() => {
    if (restored.current || !items?.length) return
    restored.current = true
    const el = scroller?.()
    if (el && initialScroll > 0) el.scrollTop = initialScroll
  }, [items, initialScroll, scroller])
  useEffect(() => {
    const el = scroller?.()
    if (!el || !onScroll) return
    const on = () => onScroll(el.scrollTop)
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [scroller, onScroll])

  const more = async () => {
    if (!cursor) return
    setBusy(true)
    try {
      const r = await api.call(API.wideningAnswers, { body: { target, add, cursor } })
      setItems((x) => [...(x ?? []), ...r.items]); setTotal(r.total); setCapped(r.totalCapped); setCursor(r.nextCursor)
    } catch (e) {
      // the people or the list changed since: read it again from the top
      if (isApiError(e, 'conflict')) { setItems(null); await first(() => true) } else setFailed(true)
    } finally { setBusy(false) }
  }

  if (items === null) return <Skeleton lines={4} />
  const left = total - items.length
  return (
    <div className="space-y-3" data-testid="widening-list">
      <p className="text-sm leading-6 break-keep text-muted" data-testid="widening-list-sub">{t('share.widenList.sub', { names })}</p>
      {failed && <ErrorNote onRetry={() => void (cursor && items.length ? more() : first(() => true))}>{t('share.widenList.loadFailed')}</ErrorNote>}
      {!failed && !items.length && <p className="text-sm break-keep text-faint" data-testid="widening-list-empty">{t('share.widenList.empty')}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {items.map((a) => <Item key={a.messageId} a={a} oneChat={oneChat} phone={phone} onOpen={onOpen} />)}
        </ul>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button busy={busy} onClick={() => void more()} className={clsx(phone && 'w-full')} data-testid="widening-list-more">
            {!capped && left <= 20 ? t('share.widenList.showAll', { n: total.toLocaleString(locale) }) : t('share.widenList.more')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Item({ a, oneChat, phone, onOpen }: { a: WideningAnswer; oneChat: boolean; phone: boolean; onOpen?: (a: WideningAnswer) => void }) {
  const t = useT()
  const locale = useLocale()
  const named = a.places.filter((p): p is { name: string } => 'name' in p).map((p) => p.name)
  const hidden = a.places.some((p) => 'hidden' in p)
  const title = a.chatTitle || t('chat.untitled')
  const body = (
    <>
      {!oneChat && (
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-row font-medium text-ink" data-testid="widening-item-chat">{title}</span>
          {!phone && <ExternalLink size={14} className="shrink-0 text-faint" aria-hidden />}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-meta text-faint">
        {a.askedBy && <Avatar user={a.askedBy} size={20} />}
        <span className="min-w-0 truncate">{t('share.widenList.item', { who: a.askedBy?.name ?? '?', when: formatMonthDay(a.at, locale) })}</span>
      </span>
      {a.preview && <span className={clsx('block text-sm break-words text-ink', phone ? 'line-clamp-2' : 'truncate')} data-testid="widening-item-preview">“{a.preview}”</span>}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-muted" data-testid="widening-item-places">
        {named.length > 0 && <span className="inline-flex min-w-0 items-center gap-1"><Folder size={14} className="shrink-0" aria-hidden /><span className="break-words">{named.join(' · ')}</span></span>}
        {hidden && <span className="inline-flex items-center gap-1"><Lock size={14} className="shrink-0" aria-hidden />{t('share.widenList.placeHidden')}</span>}
      </span>
      {a.missedBy.length > 1 && <span className="block text-meta text-faint">{t('share.widenList.whoMisses', { names: a.missedBy.join(t('rooms.nameSep')) })}</span>}
    </>
  )
  // the whole row is the link (44 px and more to tap on a phone)
  const cls = clsx(pageRowBox, 'flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-hover focus-visible:-outline-offset-2')
  return (
    <li data-testid={`widening-item-${a.messageId}`}>
      {phone && onOpen ? (
        <button type="button" className={cls} onClick={() => onOpen(a)} data-testid="widening-item-open">{body}</button>
      ) : (
        <a href={answerHref(a)} target="_blank" rel="noopener" className={cls} title={t('share.widenList.open')} data-testid="widening-item-open">{body}<span className="sr-only">{t('share.widenList.open')}</span></a>
      )}
    </li>
  )
}
