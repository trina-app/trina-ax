// "Where should this go?": the sheet behind a room file's "Save to team folder" (docs/decisions/
// 20261117-room-file-save-btn.md). Opened only by the person (the chip's icon, the file menu), never by itself. One
// folder is picked for them when the server finds one (Suggested: matched by name, no AI; or Recent), "Choose another
// folder…" opens the usual folder picker, and Save copies the message's files there. When people outside the
// conversation can see the folder it says how many; a file that looks personal gets no suggestion and a gentle note
// (among ordinary files: they keep theirs and it starts unticked); an identical copy says "Same file as above" and the
// toast says it was saved once (QA 11-17).
// One instance on the room page (pages/Room.tsx), driven by store/roomSaves.ts.
import { Folder, FileText } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { RoomSavePlan } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { sendWidening, widenedBy } from '../../lib/bulkFiles'
import { useFolderWords } from '../../lib/folderLabels'
import { filesToSave, idsToSend, leaderOf, saveRefusalKey, saveSummary, somePersonal, startFolder, startTicks } from '../../lib/roomSave'
import { formatSize } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { useRoomSaves } from '../../store/roomSaves'
import { toast } from '../../store/ui'
import FolderPicker from '../FolderPicker'
import { Button, confirmDialog, ErrorNote, Modal, Skeleton } from '../ui'

type Place = { path: string; why: 'suggested' | 'recent' | 'picked'; outside: number }

export function SaveToTeamSheet() {
  const sheet = useRoomSaves((s) => s.sheet)
  if (!sheet) return null
  return <Sheet key={sheet.key} roomId={sheet.roomId} fileIds={sheet.fileIds} />
}

function Sheet({ roomId, fileIds }: { roomId: string; fileIds: string[] }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const close = () => useRoomSaves.getState().close()
  const [plan, setPlan] = useState<RoomSavePlan | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState(0)
  const [ticked, setTicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    setError(null)
    api.call(API.roomSavePlan, { params: { id: roomId }, body: { fileIds } }).then(
      (p) => {
        if (!live) return
        setPlan(p)
        setPlace(startFolder(p))
        setTicked(startTicks(p))
      },
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, fileIds.join(','), rev])

  const pick = async (path: string) => {
    setPicking(false)
    setError(null)
    try {
      const p = await api.call(API.roomSavePlan, { params: { id: roomId }, body: { fileIds, folder: path } })
      if (p.folder) setPlace({ path: p.folder.path, why: 'picked', outside: p.folder.outside })
    } catch (e) {
      // the folder picked away from is not kept as the target: the person picks again
      setPlace(null)
      const key = saveRefusalKey(e)
      setError(key ? t(key) : errorText(e, locale, t('error.network')))
    }
  }

  const todo = plan ? filesToSave(plan) : []
  // a tick per file only when there is a choice to make (two files or more to save)
  const choosing = todo.filter((f) => plan && leaderOf(plan, f) === f.id).length > 1
  const sending = plan ? (choosing ? idsToSend(plan, ticked) : todo.map((f) => f.id)) : []
  const mixed = plan ? somePersonal(plan) : false
  const tick = (id: string, on: boolean) => setTicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const save = async () => {
    if (!place || !sending.length) return
    setBusy(true)
    setError(null)
    try {
      // people outside the conversation can see the folder (QA TC-ask2-6): asked once with how many, then sent confirmed
      const r = await sendWidening(
        (confirm) => api.call(API.saveRoomFilesToTeam, { params: { id: roomId }, body: { fileIds: sending, folder: place.path, askWiden: true, ...(confirm ? { confirm: true } : {}) } }),
        (n) => confirmDialog({ title: t('rooms.save.widenTitle'), body: t('rooms.save.widenBody', { n }), confirm: t('common.save') }),
      )
      useRoomSaves.getState().put(roomId, r.saved)
      // honest about what happened: identical files are one copy, a different file of the name kept its place
      const { same } = saveSummary(r.saved)
      const detail = [same > 0 ? t('rooms.save.savedSame', { n: same }) : '', r.saved.some((s) => s.nextTo) ? t('rooms.save.savedNextTo') : ''].filter(Boolean).join(' ')
      toast({ level: 'success', text: t('rooms.save.saved', { folder: words.path(place.path, ' › ') }), detail: detail || undefined })
      close()
    } catch (e) {
      // a no to that question: nothing saved, the sheet stays as it was
      if (widenedBy(e) !== null) {
        setBusy(false)
        return
      }
      const key = saveRefusalKey(e)
      setError(key ? t(key) : errorText(e, locale, t('rooms.save.failed')))
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open={!picking}
        onClose={close}
        title={t('rooms.save.title')}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" busy={busy} disabled={!place || !sending.length} onClick={save} data-testid="room-save-confirm">
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3" data-testid="room-save-sheet">
          {!plan && !error && <Skeleton lines={2} />}
          {plan && (
            <ul className="space-y-1 text-sm" data-testid="room-save-files">
              {plan.files.map((f) => {
                const copy = !f.savedPath && leaderOf(plan, f) !== f.id
                const box = choosing && !f.savedPath && !copy
                const note = f.savedPath ? t('rooms.save.already') : copy ? t('rooms.save.sameFile') : f.sensitive ? t('rooms.save.personal') : formatSize(f.size, locale)
                const Row = box ? 'label' : 'div'
                return (
                  <li key={f.id}>
                    <Row className={clsx('flex min-h-6 min-w-0 items-center gap-2 text-muted', box && 'cursor-pointer')}>
                      {box ? (
                        <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--c-accent)]" checked={ticked.has(f.id)} onChange={(e) => tick(f.id, e.target.checked)} data-testid="room-save-file-check" />
                      ) : (
                        <FileText size={15} className="shrink-0 text-faint" aria-hidden />
                      )}
                      <span className="min-w-0 truncate font-medium text-ink">{f.name}</span>
                      <span className={clsx('shrink-0 text-xs', f.sensitive && !f.savedPath && !copy ? 'text-warn' : 'text-faint')}>{note}</span>
                    </Row>
                  </li>
                )
              })}
            </ul>
          )}
          {plan && todo.length > 0 && (
            <>
              {place && (
                <div className="flex min-h-11 items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-sm" data-testid="room-save-place" data-why={place.why}>
                  <Folder size={16} className="shrink-0 text-accent-text" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink" title={words.path(place.path, ' › ')}>{words.path(place.path, ' › ')}</span>
                  {place.why !== 'picked' && <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-accent-text">{t(place.why === 'suggested' ? 'rooms.save.suggested' : 'rooms.save.recent')}</span>}
                </div>
              )}
              <Button variant={place ? 'ghost' : 'secondary'} onClick={() => setPicking(true)} className={place ? '-ml-2' : 'w-full'} data-testid="room-save-choose">
                {t(place ? 'rooms.save.choose' : 'rooms.save.chooseFirst')}
              </Button>
              {plan.sensitive && todo.some((f) => f.sensitive) && <p className="border-l-2 border-warn pl-3 text-sm text-muted" data-testid="room-save-sensitive">{t(mixed ? 'rooms.save.sensitiveSome' : 'rooms.save.sensitive')}</p>}
              {place && place.outside > 0 && <p className="text-sm text-muted" data-testid="room-save-audience">{t('rooms.save.outside', { n: place.outside })}</p>}
            </>
          )}
          {error && <ErrorNote onRetry={plan ? undefined : () => setRev((n) => n + 1)}>{error}</ErrorNote>}
        </div>
      </Modal>
      <FolderPicker open={picking} title={t('rooms.save.pickTitle')} confirmLabel={t('rooms.save.pick')} initial={place?.path ?? ''} onPick={(p) => void pick(p)} onClose={() => setPicking(false)} />
    </>
  )
}
