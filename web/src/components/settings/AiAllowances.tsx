// Settings › 트리나에게 허용한 것 (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"): what I allowed the AI in advance, mine
// only (GET /api/ai-allowances). One row each: "영업팀 → 영업/견적서" and under it "새 파일 저장 · 11월 8일", with [지우기]
// (no confirm: deleting only means being asked again). A room is named as I see it (a 1:1 by the other person). An empty
// list is one line. Lean: no cards or extra buttons. A row is a kind (room_files today), so other allowances (sites
// allowed for a conversation) can join the same list.
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { PRODUCT_NAMED_AFTER_AI, type AiAllowance } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatMonthDay } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, ErrorNote, Skeleton } from '../ui'
import { useRoomTitle } from '../rooms/RoomIcon'

export function AiAllowances() {
  const t = useT()
  const locale = useLocale()
  const title = useRoomTitle()
  const [items, setItems] = useState<AiAllowance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => api.call(API.listAiAllowances).then((r) => { setItems(r.items); setError(null) }, (e) => setError(errorText(e, locale, t('error.network'))))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const remove = async (a: AiAllowance) => {
    setBusy(a.id)
    try {
      await api.call(API.deleteAiAllowance, { params: { id: a.id } })
      setItems((cur) => cur?.filter((x) => x.id !== a.id) ?? null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const roomName = (a: AiAllowance) => (a.room.kind === 'dm' ? t('composer.roomDm', { name: title(a.room) }) : title(a.room))
  return (
    <section className="mb-8" data-testid="ai-allowances">
      {/* a phone's bar names the section already (SettingsDialog.tsx): there the title is for screen readers only */}
      <h2 className="mb-1 text-base font-semibold max-md:sr-only">{t(PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi')}</h2>
      <p className="mb-3 text-sm text-muted">{t('allowances.desc')}</p>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={2} />}
      {items && !items.length && (
        <p className="text-sm text-muted" data-testid="allowances-empty">
          {t('allowances.empty')}
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="allowance-list">
          {items.map((a) => {
            const place = `${roomName(a)} → ${a.folder}`
            return (
              <li key={a.id} className={clsx('flex items-center gap-3 px-4 py-3', busy === a.id && 'opacity-60')} data-testid="allowance-row">
                <div className="min-w-0 flex-1">
                  <p className="text-sm [overflow-wrap:anywhere]">
                    <span className="font-medium">{roomName(a)}</span>
                    <span className="px-1.5 text-faint" aria-hidden>→</span>
                    <span>{a.folder}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {t('allowances.newFiles')} · {formatMonthDay(a.createdAt, locale)}
                  </p>
                </div>
                <Button size="sm" variant="ghost" busy={busy === a.id} disabled={!!busy} aria-label={t('allowances.deleteLabel', { place })} onClick={() => void remove(a)} data-testid="allowance-delete">
                  {t('allowances.delete')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
