// Settings › 트리나에게 허용한 것 (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용", "Always allow on every card"): what I
// allowed the AI in advance ("Always allow" on a kind of card, a room's folder), mine
// only (GET /api/ai-allowances). One row each: "영업팀 → 영업/견적서" and under it "새 파일 저장 · 11월 8일", with [지우기]
// (no confirm: deleting only means being asked again). A room is named as I see it (a 1:1 by the other person). An empty
// list is one line. Lean: no cards or extra buttons. A row is a kind (room_files today), so other allowances (sites
// allowed for a conversation) can join the same list. On a phone this section also holds Browser and Dev environment
// sites (`folded`, pages/Settings.tsx): its own list is then the first part, under a heading of its own, and a row's
// 지우기 is an icon with a 44 px target.
// A connection's send card answered "Always allow" (connector_send) is a row too: "Gmail · 묻지 않고 보내기". Inside the
// desktop app the list also holds this computer's in-app browser sites (shared/src/desktop-bridge.ts
// DesktopBrowserSettings; docs/decisions/20261123-ask-registry-findings.md, decision 8): they stay on this computer, so
// their row says so ("example.com · 이 컴퓨터의 브라우저"), and Remove goes to the app (bridge.removeSite). Not on a phone's
// folded page, where the Browser part under it lists them already.
import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PRODUCT_NAMED_AFTER_AI, type AiAllowance, type CardAllowance, type RoomFilesAllowance, type SiteAllowance } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { browserSettingsBridge, type BrowserSettingsBridge, type DesktopBrowserSettings } from '../../lib/desktop'
import { formatMonthDay } from '../../lib/format'
import { useTeamPlace } from '../../lib/teamPlace'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, ErrorNote, IconButton, Skeleton, useMediaQuery } from '../ui'
import { useRoomTitle } from '../rooms/RoomIcon'

/** This computer's in-app browser sites as rows: public ones, then office-network ones not listed already. */
export function deviceSiteRows(s: DesktopBrowserSettings | null): { host: string; office: boolean }[] {
  if (!s) return []
  return [...s.always.map((host) => ({ host, office: s.privateAlways.includes(host) })), ...s.privateAlways.filter((h) => !s.always.includes(h)).map((host) => ({ host, office: true }))]
}

export function AiAllowances({ folded = false, bridge = browserSettingsBridge() }: { folded?: boolean; bridge?: BrowserSettingsBridge | null }) {
  const t = useT()
  // a room's folder in words ("My files › 공문"), never the disk path (QA TC-8922)
  const folderPlace = useTeamPlace()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const locale = useLocale()
  const title = useRoomTitle()
  const [items, setItems] = useState<AiAllowance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // the one shared notice (docs/decisions/20261123-shared-connector-warning-once.md): "공유 채팅 안내 확인함 · Falcon"
  const warnedLabel = (where: string) => (where ? `${t('allowances.connectorWarned')} · ${where}` : t('allowances.connectorWarned'))
  const load = () => api.call(API.listAiAllowances).then((r) => { setItems(r.items); setError(null) }, (e) => setError(errorText(e, locale, t('error.network'))))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // the desktop app's browser sites (not on a phone's folded page: its Browser part lists them)
  const device = folded ? null : bridge
  const [sites, setSites] = useState<DesktopBrowserSettings | null>(null)
  useEffect(() => {
    if (!device) return
    let live = true
    const off = device.onChange((x) => live && setSites(x))
    device.get().then((x) => live && x && setSites(x), () => {})
    return () => {
      live = false
      off()
    }
  }, [device])
  const deviceRows = deviceSiteRows(sites)
  const removeSite = async (host: string) => {
    if (!device) return
    setBusy(`device:${host}`)
    try {
      const next = await device.removeSite(host)
      if (next) setSites(next)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const deviceWhat = (office: boolean) => t(office ? 'allowances.deviceOffice' : 'allowances.deviceSite')
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
  const roomName = (a: RoomFilesAllowance) => (a.room.kind === 'dm' ? t('composer.roomDm', { name: title(a.room) }) : title(a.room))
  // "Always allow" on a kind of card (docs/DECISIONS.md "Always allow on every card"): what it covers, in plain words
  const cardName = (a: CardAllowance) => t(`allowances.card.${a.card}` as 'allowances.card.remember')
  // a site for good: the AI's web addresses, or the in-app browser's office-network addresses
  const siteWhat = (a: SiteAllowance) => t(a.place === 'office' ? 'allowances.siteOffice' : 'allowances.siteWeb')
  return (
    <section className="mb-8" data-testid="ai-allowances">
      {/* a phone's bar names the section already (SettingsDialog.tsx): there the title is for screen readers only */}
      <h2 className="mb-1 text-title font-semibold max-md:sr-only">{t(PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi')}</h2>
      {/* a phone's page with the other parts: this list's own heading, like theirs */}
      {folded && <h3 className="mb-1 text-title-sm font-semibold" data-testid="allowances-part">{t('allowances.part')}</h3>}
      <p className="mb-3 text-sm text-muted">{t('allowances.desc')}</p>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={2} />}
      {items && !items.length && !deviceRows.length && (
        <p className="text-sm text-muted" data-testid="allowances-empty">
          {t('allowances.empty')}
        </p>
      )}
      {items && (items.length > 0 || deviceRows.length > 0) && (
        // phones: plain rows under the section, like Security's devices (no frame around them)
        <ul className="divide-y divide-line md:rounded-xl md:border md:border-line" data-testid="allowance-list">
          {items.map((a) => {
            const place = a.kind === 'picture' ? a.picture : a.kind === 'card' ? cardName(a) : a.kind === 'person_alias' ? `${a.ref} → ${a.person.name}` : a.kind === 'connector_tool' ? `${a.connection} · ${a.all ? t('allowances.connectorAll') : a.warned !== undefined ? warnedLabel(a.warned) : a.shared ? t('allowances.connectorShared') : a.tool}` : a.kind === 'site' ? `${a.site} · ${siteWhat(a)}` : a.kind === 'connector_send' ? `${a.connection} · ${t('allowances.connectorSend')}` : `${roomName(a)} → ${folderPlace(a.folder)}`
            return (
              <li key={a.id} className={clsx('flex items-center gap-3 py-3 md:px-4', busy === a.id && 'opacity-60')} data-testid="allowance-row">
                <div className="min-w-0 flex-1">
                  {a.kind === 'card' ? (
                    <p className="text-sm font-medium [overflow-wrap:anywhere]">{cardName(a)}</p>
                  ) : a.kind === 'picture' ? (
                    // one picture that goes into documents without the card: "shared/brand/ceo-seal.png · ..."
                    <p className="text-sm [overflow-wrap:anywhere]" data-testid="allowance-picture">
                      <span className="font-medium">{a.picture}</span>
                      <span className="px-1.5 text-faint" aria-hidden>·</span>
                      <span>{t('allowances.picture')}</span>
                    </p>
                  ) : a.kind === 'connector_tool' ? (
                    // a connector tool's read card (docs/decisions/20261122-connector-always-allow.md): "Bright Data · Get post"
                    <p className="text-sm [overflow-wrap:anywhere]">
                      <span className="font-medium">{a.connection}</span>
                      <span className="px-1.5 text-faint" aria-hidden>·</span>
                      {/* the shared chat card's Always: the connection's answers, not one tool; "<connector> 전체 항상 허용":
                          every tool (docs/decisions/20261123-one-always-allow.md) */}
                      <span>{a.all ? t('allowances.connectorAll') : a.warned !== undefined ? warnedLabel(a.warned) : a.shared ? t('allowances.connectorShared') : a.tool}</span>
                    </p>
                  ) : a.kind === 'connector_send' ? (
                    // a connection's send card answered "Always allow": "Gmail · 묻지 않고 보내기"
                    <p className="text-sm [overflow-wrap:anywhere]" data-testid="allowance-send">
                      <span className="font-medium">{a.connection}</span>
                      <span className="px-1.5 text-faint" aria-hidden>·</span>
                      <span>{t('allowances.connectorSend')}</span>
                    </p>
                  ) : a.kind === 'person_alias' ? (
                    // a name the person taught for a teammate (docs/decisions/20261123-do-then-undo.md): "팀장 → QA Owner"
                    <p className="text-sm [overflow-wrap:anywhere]" data-testid="allowance-alias">
                      <span className="font-medium">{a.ref}</span>
                      <span className="px-1.5 text-faint" aria-hidden>→</span>
                      <span>{a.person.name}</span>
                    </p>
                  ) : a.kind === 'site' ? (
                    // a site for good (docs/decisions/20261122-always-allow-holds-everywhere.md): "example.com · 웹 주소 열기"
                    <p className="text-sm [overflow-wrap:anywhere]" data-testid="allowance-site">
                      <span className="font-medium">{a.site}</span>
                      <span className="px-1.5 text-faint" aria-hidden>·</span>
                      <span>{siteWhat(a)}</span>
                    </p>
                  ) : (
                    <p className="text-sm [overflow-wrap:anywhere]">
                      <span className="font-medium">{roomName(a)}</span>
                      <span className="px-1.5 text-faint" aria-hidden>→</span>
                      <span>{folderPlace(a.folder)}</span>
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted">
                    {t(a.kind === 'room_files' ? 'allowances.newFiles' : a.kind === 'person_alias' ? 'allowances.alias' : 'allowances.always')} · {formatMonthDay(a.createdAt, locale)}
                  </p>
                </div>
                {phone ? (
                  <IconButton label={t('allowances.deleteLabel', { place })} className="touch-hit shrink-0" disabled={!!busy} onClick={() => void remove(a)} data-testid="allowance-delete">
                    <Trash2 size={16} />
                  </IconButton>
                ) : (
                  <Button size="sm" variant="ghost" busy={busy === a.id} disabled={!!busy} aria-label={t('allowances.deleteLabel', { place })} onClick={() => void remove(a)} data-testid="allowance-delete">
                    {t('allowances.delete')}
                  </Button>
                )}
              </li>
            )
          })}
          {/* this computer's in-app browser sites (kept by the desktop app, not the team server) */}
          {deviceRows.map((r) => {
            const place = `${r.host} · ${deviceWhat(r.office)}`
            const key = `device:${r.host}`
            return (
              <li key={key} className={clsx('flex items-center gap-3 py-3 md:px-4', busy === key && 'opacity-60')} data-testid="allowance-row" data-device="">
                <div className="min-w-0 flex-1">
                  <p className="text-sm [overflow-wrap:anywhere]" data-testid="allowance-device-site">
                    <span className="font-medium">{r.host}</span>
                    <span className="px-1.5 text-faint" aria-hidden>·</span>
                    <span>{deviceWhat(r.office)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{t('allowances.always')}</p>
                </div>
                {phone ? (
                  <IconButton label={t('allowances.deleteLabel', { place })} className="touch-hit shrink-0" disabled={!!busy} onClick={() => void removeSite(r.host)} data-testid="allowance-delete">
                    <Trash2 size={16} />
                  </IconButton>
                ) : (
                  <Button size="sm" variant="ghost" busy={busy === key} disabled={!!busy} aria-label={t('allowances.deleteLabel', { place })} onClick={() => void removeSite(r.host)} data-testid="allowance-delete">
                    {t('allowances.delete')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
