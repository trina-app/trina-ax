// Chat trash: chats deleted within the team's chat retention (Admin > Team settings), restorable until they are purged.
import { RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'
import { chatTrashDays } from '../lib/chat-trash'
import { toast } from '../store/ui'
import { Button, EmptyState, ErrorNote, PageHeader, Skeleton } from '../components/ui'

export default function Trash() {
  const t = useT()
  const locale = useLocale()
  const days = chatTrashDays(useMe())
  const upsert = useChats((s) => s.upsertChat)
  const [items, setItems] = useState<Chat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = async () => {
    try {
      setItems((await api.call(API.listChats, { query: { trash: '1', limit: 100 } })).items)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('trash.title')} desc={t('trash.desc', { days })} />
      <div className="p-4 sm:p-6">
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && <EmptyState icon={<Trash2 size={28} />} title={t('trash.empty')} />}
        <ul className="divide-y divide-line">
          {items?.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.title || t('chat.untitled')}</span>
                {c.deletedAt && <span className="block text-xs text-faint">{t('trash.deletedAt', { date: formatDateTime(c.deletedAt, locale) })}</span>}
              </span>
              <Button
                size="sm"
                busy={busy === c.id}
                onClick={async () => {
                  setBusy(c.id)
                  try {
                    upsert(await api.call(API.restoreChat, { params: { id: c.id } }))
                    setItems((cur) => cur?.filter((x) => x.id !== c.id) ?? null)
                  } catch (e) {
                    toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                <RotateCcw size={14} aria-hidden /> {t('common.restore')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
