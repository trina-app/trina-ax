// "Files you sent" (docs/decisions/20261116-room-files-cleanup.md): like Slack, the people who sent files in
// conversations are the ones who delete them. My own files in the conversations I am in now, largest first, with the
// space they take together (GET /api/room-files/mine). A row opens the message it was sent with; Delete deletes that
// message (DELETE /api/rooms/:id/messages/:messageId, the author's only, as in the conversation), so every file of the
// message leaves the list. No menu item: Search ("Files you sent"), the clean-up notice and a file refused for a full
// disk lead here. Guests too (their own files).
import { File as FileIcon, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MyRoomFilesPage, RoomFileSearchHit, RoomSearchRoom } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatSize, listTime } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { ListRow } from '../components/list/List'
import { roomFileHref, useWhere } from '../components/SearchDialog'
import { Button, confirmDialog, EmptyState, ErrorNote, IconButton, PageHeader, Skeleton, pageColumn } from '../components/ui'

export default function SentFiles() {
  const t = useT()
  const locale = useLocale()
  const where = useWhere()
  const [items, setItems] = useState<RoomFileSearchHit[] | null>(null)
  const [rooms, setRooms] = useState<Map<string, RoomSearchRoom>>(new Map())
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const life = useRef(0)
  const take = (p: MyRoomFilesPage, add: boolean) => {
    setItems((cur) => (add && cur ? [...cur, ...p.items.filter((x) => !cur.some((y) => y.file.id === x.file.id))] : p.items))
    setRooms((cur) => new Map([...(add ? cur : []), ...p.rooms.map((r) => [r.id, r] as const)]))
    // the total comes with the first page
    if (!add) setTotal(p.totalBytes)
    setNext(p.nextCursor)
  }
  const load = async () => {
    const n = ++life.current
    setError(null)
    try {
      const p = await api.call(API.listMyRoomFiles, { query: {} })
      if (n === life.current) take(p, false)
    } catch (e) {
      if (n === life.current) setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    return () => { life.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const loadMore = async () => {
    if (!next) return
    setMore(true)
    try { take(await api.call(API.listMyRoomFiles, { query: { cursor: next } }), true) }
    catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
    finally { setMore(false) }
  }
  /** Delete: the whole message goes, so each file of it leaves the list; then the list is read again, for the true total
   * (files of the message on pages not loaded yet count too) */
  const remove = async (h: RoomFileSearchHit) => {
    const others = (items ?? []).filter((x) => x.messageId === h.messageId && x.file.id !== h.file.id).length
    const ok = await confirmDialog({
      title: t('sentFiles.confirmTitle', { name: h.file.name }),
      body: others ? t('sentFiles.confirmBodyOthers', { n: others }) : t('sentFiles.confirmBody'),
      confirm: t('common.delete'), danger: true,
    })
    if (!ok) return
    setBusy((s) => new Set(s).add(h.messageId))
    try {
      await api.call(API.deleteRoomMessage, { params: { id: h.roomId, messageId: h.messageId } })
      setItems((cur) => (cur ?? []).filter((x) => x.messageId !== h.messageId))
      void load()
    } catch {
      toast({ level: 'error', text: t('sentFiles.deleteFailed') })
    } finally {
      setBusy((s) => { const c = new Set(s); c.delete(h.messageId); return c })
    }
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="sent-files">
      <PageHeader title={t('sentFiles.title')} desc={t('sentFiles.desc')} />
      <div className={`${pageColumn} p-4 sm:p-6`}>
        {error && <ErrorNote onRetry={() => void load()}>{t('sentFiles.loadError')}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && !next && <EmptyState screen icon={<Paperclip size={28} />} title={t('sentFiles.empty')} />}
        {items && items.length > 0 && <p className="mb-2 text-sm text-muted tabular-nums" data-testid="sent-files-total">{t('sentFiles.total', { size: formatSize(total, locale) })}</p>}
        {items && items.length > 0 && (
          <ul className="divide-y divide-line" data-testid="sent-files-list">
            {items.map((h) => {
              const Icon = h.file.kind === 'image' ? ImageIcon : FileIcon
              const gone = busy.has(h.messageId)
              return (
                <ListRow
                  key={h.file.id}
                  scale="page"
                  // while its message is being deleted: no way into it
                  to={gone ? undefined : roomFileHref(h)}
                  icon={<Icon />}
                  name={h.file.name}
                  // where it was sent is shortened first; the time and the size (what the list is sorted by) stay whole
                  meta={where(rooms.get(h.roomId), h.author?.id) || undefined}
                  metaKeep={[listTime(h.createdAt, locale, t('sidebar.yesterday')), formatSize(h.file.size, locale)].filter(Boolean).join(' · ')}
                  metaTestId="sent-file-meta"
                  disabled={gone}
                  actions={
                    <IconButton label={t('common.deleteNamed', { name: h.file.name })} disabled={gone} onClick={() => void remove(h)} data-testid="sent-file-delete">
                      <Trash2 size={16} />
                    </IconButton>
                  }
                  li={{ 'data-testid': 'sent-file', 'data-id': h.file.id, className: clsxGone(gone) }}
                />
              )
            })}
          </ul>
        )}
        {next && items && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" busy={more} onClick={() => void loadMore()} data-testid="sent-files-more">{t('common.loadMore')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** a row whose message is being deleted: greyed */
const clsxGone = (gone: boolean) => (gone ? 'opacity-50' : undefined)
