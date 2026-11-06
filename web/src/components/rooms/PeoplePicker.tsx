// "새 1:1 대화": the team's people (GET /api/people) with a search box; picking one opens our DM (POST /api/rooms,
// the existing one when there is one) and goes there. A bottom sheet on phones (Modal).
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { usePeople, usePeopleList } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { ErrorNote, inputCls, Modal, Skeleton } from '../ui'

export function PeoplePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <PeopleDialog onClose={onClose} />
}

function PeopleDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const people = usePeopleList()
  const failed = usePeople((s) => s.failed)
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const others = useMemo(() => (people ?? []).filter((p) => p.id !== me?.user.id), [people, me?.user.id])
  const shown = useMemo(() => {
    const s = q.trim().toLocaleLowerCase()
    const list = s ? others.filter((p) => p.name.toLocaleLowerCase().includes(s) || !!p.title?.toLocaleLowerCase().includes(s)) : others
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [others, q])

  const pick = async (userId: string) => {
    if (busy) return
    setBusy(userId)
    try {
      const room = await useRooms.getState().openDm(userId)
      onClose()
      navigate(`/rooms/${room.id}`)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(null)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('rooms.newDm')} width={420}>
      <div className="-mx-5 -mt-5 border-b border-line px-5 py-3">
        <label className="relative block">
          <span className="sr-only">{t('rooms.people.search')}</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('rooms.people.search')} className={`${inputCls} pl-9`} data-testid="people-search" />
        </label>
      </div>
      {!people && <Skeleton lines={4} className="pt-4" />}
      {people && failed && !others.length && (
        <div className="pt-4">
          <ErrorNote onRetry={() => void usePeople.getState().load(true)}>{t('error.network')}</ErrorNote>
        </div>
      )}
      {people && !failed && !others.length && <p className="pt-4 text-sm text-muted">{t('rooms.people.none')}</p>}
      {people && !!others.length && !shown.length && <p className="pt-4 text-sm text-muted">{t('rooms.people.noMatch')}</p>}
      {!!shown.length && (
        <ul className="-mx-5 -mb-5 divide-y divide-line" data-testid="people-list">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={!!busy} onClick={() => void pick(p.id)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-hover disabled:opacity-60" data-testid="people-row">
                <Avatar user={p} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  {p.title && <span className="block truncate text-xs text-muted">{p.title}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
