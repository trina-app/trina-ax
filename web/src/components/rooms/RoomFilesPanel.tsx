// A room's Files list (docs/decisions/20261120-project-is-room.md D8): the header's Files opens it on the room's right,
// in the side chat's place (pages/Room.tsx; one of the two at a time), a sheet over the room in a narrow window and the
// whole screen on a phone, as the thread and the side chat are. The files sent in a channel, a 1:1 or a group chat that
// I can see now (GET /api/rooms/:id/files: newest first, in pages), each a row with its name, who sent it, when and its
// size; a row opens it in the file viewer as its chip in the message does (lib/imageViewer.ts roomFileItem: ← → walks
// the list), and the viewer's bar says who sent it and when. Read again when a new message comes. A team room of a
// group with a folder I can open has that folder's link at the top (the header's own folder button became this one).
// A project's chat room has no Files list: its header has the project's button (its files are the project's, in Files).
import { ChevronLeft, File as FileIcon, Files, Folder, Image as ImageIcon, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RoomFileSearchHit, RoomFilesPage } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatSize, listTime } from '../../lib/format'
import { roomFileItem, type ViewerMetaValue } from '../../lib/imageViewer'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { ImageGroup, useViewerItem, ViewerMeta } from '../ImageViewer'
import { ListRow } from '../list/List'
import { Button, EmptyState, ErrorNote, IconButton, Skeleton } from '../ui'

/** `refresh`: changes when the room has a new message (its newest message's id): the first page is read again.
 * `groupFolder`: a team room's group folder I can open (Room.groupFolder). */
export function RoomFilesPanel({ roomId, refresh, groupFolder, onClose }: { roomId: string; refresh?: string | null; groupFolder?: string | null; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<RoomFileSearchHit[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const life = useRef(0)
  const take = (p: RoomFilesPage, add: boolean) => {
    setItems((cur) => (add && cur ? [...cur, ...p.items.filter((x) => !cur.some((y) => y.file.id === x.file.id))] : p.items))
    setNext(p.nextCursor)
  }
  const load = useCallback(async () => {
    const n = ++life.current
    setError(null)
    try {
      const p = await api.call(API.listRoomFiles, { params: { id: roomId }, query: {} })
      if (n === life.current) take(p, false)
    } catch (e) {
      if (n === life.current) setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])
  useEffect(() => {
    void load()
    return () => { life.current++ }
  }, [load, refresh])
  const loadMore = async () => {
    if (!next) return
    setMore(true)
    const n = life.current
    try {
      const p = await api.call(API.listRoomFiles, { params: { id: roomId }, query: { cursor: next } })
      if (n === life.current) take(p, true)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setMore(false)
    }
  }
  const folderName = groupFolder?.split('/').pop() ?? groupFolder
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="room-files">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 max-md:pl-0.5 md:px-4">
        <IconButton tip label={t('rooms.files.close')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="room-files-back">
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate text-title-sm font-semibold text-ink">{t('rooms.files.title')}</h2>
        <IconButton tip label={t('rooms.files.close')} onClick={onClose} className="touch-hit max-md:hidden" data-testid="room-files-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2 md:px-3">
        {groupFolder && (
          <Link to={`/files?path=${encodeURIComponent(groupFolder)}`} className="mb-1 flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm text-muted hover:bg-hover hover:text-ink md:min-h-9" data-testid="room-files-folder">
            <Folder size={16} className="shrink-0" aria-hidden />
            <span className="truncate">{t('rooms.groupFilesTip', { name: folderName ?? '' })}</span>
          </Link>
        )}
        {error && <div className="px-1 pt-2"><ErrorNote onRetry={() => void load()}>{t('rooms.files.loadError')}</ErrorNote></div>}
        {!items && !error && <Skeleton lines={4} className="px-1 pt-2" />}
        {items && !items.length && !next && (
          <EmptyState icon={<Files size={24} aria-hidden />} title={t('rooms.files.empty')}>
            <p>{t('rooms.files.emptyHint')}</p>
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <ImageGroup>
            <ul data-testid="room-files-list">
              {items.map((h) => <FileRow key={h.file.id} roomId={roomId} hit={h} />)}
            </ul>
          </ImageGroup>
        )}
        {next && items && (
          <div className="mt-2 flex justify-center pb-2">
            <Button size="sm" busy={more} onClick={() => void loadMore()} data-testid="room-files-more">{t('common.loadMore')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** One file: its name, who sent it, when and its size; it opens in the viewer, in the list's order. */
function FileRow({ roomId, hit }: { roomId: string; hit: RoomFileSearchHit }) {
  return (
    <ViewerMeta sender={hit.author ? { kind: 'user', user: hit.author } : undefined} at={hit.createdAt} messageId={hit.messageId} rootId={hit.threadRootId ?? hit.messageId}>
      <FileRowBody roomId={roomId} hit={hit} />
    </ViewerMeta>
  )
}
function FileRowBody({ roomId, hit }: { roomId: string; hit: RoomFileSearchHit }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const f = hit.file
  const viewer = useViewerItem((meta: ViewerMetaValue) => roomFileItem(roomId, f, me, meta))
  const Icon = f.kind === 'image' ? ImageIcon : FileIcon
  return (
    <ListRow
      onClick={() => viewer.open()}
      rowRef={viewer.ref}
      icon={<Icon />}
      // what a tap does, for a screen reader after the name it reads (as the file's chip in the message says it)
      name={<>{f.name}<span className="sr-only"> {t('common.preview')}</span></>}
      nameTitle={f.name}
      // who sent it is shortened first; when and the size stay whole
      meta={hit.author?.name ?? t('rooms.goneUser')}
      metaKeep={[listTime(hit.createdAt, locale, t('sidebar.yesterday')), formatSize(f.size, locale)].filter(Boolean).join(' · ')}
      metaTestId="room-files-meta"
      li={{ 'data-testid': 'room-files-row', 'data-file-name': f.name }}
    />
  )
}
