// Admin > Plugins (docs/PLUGINS.md), laid out like Connected apps (components/integrations/ConnectorsView.tsx): the
// title row (search, Install from file), "Installed" as cards (not shown while nothing is installed), "Discover" with
// the official list as cards, and a plugin's page in place of both (what it is, what it will do, the details). Installing
// always goes through the permission prompt: the server checks the package first (official pin or signature, files,
// platform) and the admin approves exactly the digest and permissions shown. Optional permissions start ticked (as in
// Claude Code) and the prompt says so. Stage 1 turns plugins on for the whole company only.
import { AlertTriangle, ArrowLeft, ArrowUpCircle, BadgeCheck, BookOpen, Cable, Check, Cpu, FileText, FileUp, Globe, Languages, Loader2, Minus, Plus, Puzzle, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { CatalogPlugin, InstalledPlugin, PluginList, PluginPlan } from '@mycel/shared/api'
import type { PluginKind, PluginPermission, PluginPlatform } from '@mycel/shared/plugins'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, EmptyState, IconButton, Modal, StickyHeader, confirmDialog, inputCls } from '../../components/ui'
import { Tooltip } from '../../components/Tooltip'
import { CardMenu } from '../../components/integrations/AppConnectorCard'
import { Loadable, useLoad } from './common'
import { useAdminBar, useUpTo } from './phoneBar'

type T = ReturnType<typeof useT>

/** A refusal in the admin's language: the server's params.reason, else the generic text. */
function refusal(t: T, e: unknown, locale: ReturnType<typeof useLocale>): string {
  const reason = isApiError(e) ? e.body.params?.reason : undefined
  const key = `plugins.error.${String(reason)}`
  if (typeof reason === 'string' && key in DICTS.en) return t(key as MessageKey)
  return isApiError(e) ? t('plugins.error') : errorText(e, locale, t('error.network'))
}

function platformText(t: T, platforms: PluginPlatform[] | null): string {
  if (!platforms?.length) return t('plugins.platform.any')
  return platforms.map((p) => {
    const os = p.os === 'darwin' ? 'macOS' : p.os === 'linux' ? 'Linux' : t('plugins.platform.any')
    const arch = p.arch === 'any' ? '' : ` ${p.arch}`
    return `${os}${arch}${p.libc ? ` (${t('plugins.platform.glibc', { version: p.libc.minVersion })})` : ''}`
  }).join(' · ')
}

/** Official, test build or unverified; an official package the release vouches for says so. */
function TrustBadge({ trust, verifiedBy }: { trust: InstalledPlugin['trust']; verifiedBy: InstalledPlugin['verifiedBy'] }) {
  const t = useT()
  return (
    <>
      <Badge tone={trust === 'official' ? 'ok' : 'warn'}>{t(`plugins.trust.${trust}`)}</Badge>
      {trust === 'official' && verifiedBy === 'release' && <span className="text-xs text-faint" data-testid="plugin-verified-release">{t('plugins.trust.release')}</span>}
    </>
  )
}

/** What the HWP plugin also turns on, from core (its package text describes the preview only and is pinned): writing
 * and filling Hangul documents (docs/DECISIONS.md "Hangul writing and filling come with the HWP plugin"). */
function HwpWriting({ id, className = '' }: { id: string; className?: string }) {
  const t = useT()
  if (id !== HWP_PLUGIN_ID) return null
  return <p className={`text-sm text-muted ${className}`} data-testid="plugin-hwp-writing">{t('plugins.hwpWriting')}</p>
}

/** `showGrant`: an installed plugin — an optional permission the admin did not allow is shown as such. */
function Permissions({ items, choose, showGrant }: { items: { id: PluginPermission; required: boolean; new?: boolean; granted?: boolean }[]; choose?: { chosen: Set<PluginPermission>; set: (p: PluginPermission, on: boolean) => void }; showGrant?: boolean }) {
  const t = useT()
  return (
    <ul className="space-y-1.5 text-sm" data-testid="plugin-permissions">
      {items.map((p) => {
        const off = showGrant && !p.required && !p.granted
        return (
          <li key={p.id} className={off ? 'flex items-start gap-2 text-muted' : 'flex items-start gap-2'}>
            {choose && !p.required
              ? <input type="checkbox" className="mt-1" checked={choose.chosen.has(p.id)} onChange={(e) => choose.set(p.id, e.target.checked)} aria-label={t(`plugins.perm.${p.id}` as MessageKey)} data-testid={`plugin-optional-${p.id}`} />
              : off ? <Minus size={14} className="mt-1 shrink-0" aria-hidden /> : <Check size={14} className="mt-1 shrink-0 text-ok" aria-hidden />}
            <span>
              {t(`plugins.perm.${p.id}` as MessageKey)}
              {!p.required && <Badge className="ml-1.5">{off ? t('plugins.perm.off') : t('plugins.perm.optional')}</Badge>}
              {p.new && <Badge tone="warn" className="ml-1.5">{t('plugins.perm.new')}</Badge>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** The permission prompt: what this exact package will do, who gets it, what it contains. */
function PlanDialog({ plan, onClose, onDone }: { plan: PluginPlan; onClose: () => void; onDone: (p: InstalledPlugin) => void }) {
  const t = useT()
  const locale = useLocale()
  const [chosen, setChosen] = useState(() => new Set<PluginPermission>(plan.permissions.map((p) => p.id)))
  const [busy, setBusy] = useState<'on' | 'only' | null>(null)
  const install = async (enable: boolean) => {
    setBusy(enable ? 'on' : 'only')
    try {
      const permissions = plan.permissions.filter((p) => p.required || chosen.has(p.id)).map((p) => p.id)
      const r = await api.call(API.installPlugin, { body: { token: plan.token, manifestSha256: plan.manifestSha256, enable, permissions } })
      toast({ level: 'success', text: t('plugins.done.installed', { name: r.name }) })
      onDone(r)
    } catch (e) {
      toast({ level: 'error', text: refusal(t, e, locale) })
    } finally { setBusy(null) }
  }
  const title = plan.update ? t('plugins.prompt.updateTitle', { name: plan.name, from: plan.update.from, to: plan.version }) : t('plugins.prompt.title', { name: plan.name })
  return (
    <Modal open onClose={onClose} title={title} width={560} footer={
      <>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        {plan.supported && !plan.update && <Button busy={busy === 'only'} disabled={!!busy} onClick={() => void install(false)} data-testid="plugin-install-only">{t('plugins.prompt.installOnly')}</Button>}
        {plan.supported && <Button variant="primary" busy={busy === 'on'} disabled={!!busy} onClick={() => void install(true)} data-testid="plugin-install-enable">{plan.update ? t('plugins.prompt.updateConfirm') : t('plugins.prompt.installEnable')}</Button>}
      </>
    }>
      <div className="space-y-4 text-sm" data-testid="plugin-plan">
        <div>
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{plan.name}</span>
            <span className="text-muted">{t('plugins.version', { version: plan.version })}</span>
            <TrustBadge trust={plan.trust} verifiedBy={plan.verifiedBy} />
          </p>
          <p className="mt-1 text-muted">{plan.description}</p>
          <HwpWriting id={plan.id} className="mt-1" />
          <p className="mt-1 text-xs text-faint">{t('plugins.publisher', { name: plan.publisher.name })} · {t('plugins.prompt.size', { size: formatSize(plan.sizeBytes, locale) })} · {t('plugins.platforms', { list: platformText(t, plan.platforms) })}</p>
        </div>
        {!plan.supported && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn" role="alert" data-testid="plugin-plan-unsupported">
            {t('plugins.prompt.cannot')} {plan.unsupported ? t(`plugins.unsupported.${plan.unsupported}` as MessageKey) : ''}
          </p>
        )}
        {plan.trust !== 'official' && <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn">{t(plan.trust === 'test' ? 'plugins.prompt.test' : 'plugins.prompt.unverified')}</p>}
        {plan.trust === 'official' && plan.verifiedBy === 'release' && <p className="text-muted" data-testid="plugin-plan-release">{t('plugins.prompt.release')}</p>}
        {plan.permissions.some((p) => p.new) && <p className="text-warn">{t('plugins.prompt.newAccess')}</p>}
        <div>
          <p className="mb-1.5 font-medium">{t('plugins.prompt.does')}</p>
          <Permissions items={plan.permissions} choose={{ chosen, set: (p, on) => setChosen((s) => { const n = new Set(s); if (on) n.add(p); else n.delete(p); return n }) }} />
          {plan.supported && plan.permissions.some((p) => !p.required) && <p className="mt-1.5 text-xs text-muted" data-testid="plugin-optional-on">{t('plugins.prompt.optionalOn')}</p>}
        </div>
        {plan.skills.length > 0 && <p>{t('plugins.prompt.skills', { list: plan.skills.join(', ') })}</p>}
        <p className="text-muted">{t('plugins.prompt.who')}</p>
        {plan.components.length > 0 && (
          <div>
            <p className="mb-1 font-medium">{t('plugins.prompt.components')}</p>
            <ul className="text-xs text-muted">{plan.components.map((c) => <li key={c.name}>{c.name}{c.version ? ` ${c.version}` : ''} · {c.license}</li>)}</ul>
          </div>
        )}
        <p className="font-mono text-micro break-all text-faint">{t('plugins.prompt.digest', { digest: plan.manifestSha256.slice(0, 16) })}</p>
      </div>
    </Modal>
  )
}

/** One licence ("MIT") stays on the line; a list of them ("MIT AND Apache-2.0 AND …") is long and noisy there. */
export const longLicense = (license: string) => /\s(AND|OR)\s/i.test(license) || license.length > 24

/** The publisher and platforms line. A long licence list is "Licenses" there: the full list in its tooltip, and under
 * the line when pressed (a phone has no tooltip). */
export function PluginMeta({ text, license }: { text: string; license: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (!longLicense(license)) return <p className="text-xs text-faint">{text} · {license}</p>
  return (
    <div className="text-xs text-faint">
      <p>
        {text} ·{' '}
        <button type="button" aria-expanded={open} aria-controls={listId} title={license} onClick={() => setOpen((v) => !v)} className="underline decoration-dotted underline-offset-2 hover:text-ink" data-testid="plugin-licenses">
          {t('plugins.licenses')}
        </button>
      </p>
      {open && <p id={listId} className="mt-1 break-words" data-testid="plugin-license-list">{license}</p>}
    </div>
  )
}

/** A plugin has no logo of its own: a tile with the icon of what it is (a file preview, skills, a program…), the size
 * and corner of a connector's logo tile. */
const KIND_ICONS: [PluginKind, LucideIcon][] = [['preview', FileText], ['skill-pack', BookOpen], ['connector-preset', Cable], ['region-pack', Globe], ['locale-pack', Languages], ['native-tool', Cpu]]
function PluginTile({ kinds, big }: { kinds: PluginKind[]; big?: boolean }) {
  const Icon = KIND_ICONS.find(([k]) => kinds.includes(k))?.[1] ?? Puzzle
  return (
    <span className={`flex shrink-0 items-center justify-center border border-line bg-surface text-ink ${big ? 'size-16 rounded-xl' : 'size-11 rounded-lg'}`} data-testid="plugin-tile">
      <Icon size={big ? 28 : 20} strokeWidth={1.75} aria-hidden />
    </span>
  )
}

/** The check next to an official plugin's name, as next to an official connector's. */
function OfficialMark({ size }: { size: number }) {
  const t = useT()
  return <Tooltip label={t('plugins.trust.official')}><BadgeCheck size={size} className="shrink-0 text-muted" role="img" aria-label={t('plugins.trust.official')} /></Tooltip>
}

/** Turn on / off, roll back and remove for an installed plugin: one at a time, each with its toast. */
function useInstalledActions(reload: () => void) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast({ level: 'success', text: ok }); reload(); return true } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }); return false } finally { setBusy(false) }
  }
  return {
    busy,
    enable: (p: InstalledPlugin) => run(() => api.call(API.enablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.enabled', { name: p.name })),
    disable: (p: InstalledPlugin) => run(() => api.call(API.disablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.disabled', { name: p.name })),
    rollback: (p: InstalledPlugin) => run(() => api.call(API.rollbackPlugin, { params: { id: p.id }, body: {} }), t('plugins.done.rolledBack', { name: p.name, version: p.previousVersion ?? '' })),
    /** true once it was removed (the admin may also cancel) */
    remove: async (p: InstalledPlugin) => {
      if (!(await confirmDialog({ title: t('plugins.removeTitle', { name: p.name }), body: t('plugins.removeBody'), confirm: t('plugins.remove'), danger: true }))) return false
      return run(() => api.call(API.uninstallPlugin, { params: { id: p.id } }), t('plugins.done.removed', { name: p.name }))
    },
  }
}

function Toggle({ p, a }: { p: InstalledPlugin; a: ReturnType<typeof useInstalledActions> }) {
  const t = useT()
  return p.enabled
    ? <Button size="sm" busy={a.busy} onClick={() => void a.disable(p)} data-testid="plugin-disable">{t('plugins.disable')}</Button>
    : <Button size="sm" variant="primary" busy={a.busy} disabled={p.status === 'unsupported'} onClick={() => void a.enable(p)} data-testid="plugin-enable">{t('plugins.enable')}</Button>
}

/** ⋯ of an installed plugin: what an admin rarely does with it. `update`: the official list has a newer version that
 * can be installed here. */
function InstalledMenu({ p, a, update, onRemoved }: { p: InstalledPlugin; a: ReturnType<typeof useInstalledActions>; update?: { version: string; run: () => void }; onRemoved?: () => void }) {
  const t = useT()
  return (
    <CardMenu label={t('appConnectors.more', { name: p.name })} testId="plugin-more" items={[
      ...(update ? [{ label: t('plugins.update', { version: update.version }), onSelect: update.run, disabled: a.busy, testId: 'plugin-update' }] : []),
      ...(p.previousVersion ? [{ label: t('plugins.rollback', { version: p.previousVersion }), onSelect: () => void a.rollback(p), disabled: a.busy, testId: 'plugin-rollback' }] : []),
      { label: t('plugins.remove'), onSelect: () => void a.remove(p).then((gone) => { if (gone) onRemoved?.() }), danger: true, disabled: a.busy, testId: 'plugin-remove' },
    ]} />
  )
}

/** A card of either section, in the style of a Discover card of Connected apps: the tile, the name, a line or two, and
 * the actions on the right. The card opens the plugin's page. */
function PluginCard({ id, testId, kinds, name, official, line, lineTone, foot, actions, onOpen }: {
  id: string
  testId: string
  kinds: PluginKind[]
  name: string
  official: boolean
  line: ReactNode
  lineTone?: 'warn'
  foot?: ReactNode
  actions: ReactNode
  onOpen: () => void
}) {
  return (
    // a phone: a flat row with a hairline between (no grey frame), the line cut to one, the rest on the plugin's page
    <li className="relative flex items-start gap-3 rounded-xl bg-subtle p-3 transition hover:bg-hover max-md:items-center max-md:rounded-none max-md:bg-transparent max-md:px-0 max-md:py-1.5 max-md:hover:bg-transparent" data-testid={testId} data-plugin={id}>
      <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left -outline-offset-2 max-md:min-h-12 max-md:items-center" onClick={onOpen} data-testid="plugin-open">
        <PluginTile kinds={kinds} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-medium">
            <span className="truncate">{name}</span>
            {official && <OfficialMark size={14} />}
          </span>
          <span className={`mt-0.5 line-clamp-2 text-xs max-md:line-clamp-1 ${lineTone === 'warn' ? 'text-warn' : 'text-muted'}`} data-testid="plugin-line">{line}</span>
          {foot && <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint max-md:hidden">{foot}</span>}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11">{actions}</span>
    </li>
  )
}

/** on, off, or installed but not usable on this server */
function statusText(t: T, p: InstalledPlugin): string {
  if (p.status === 'enabled') return t('plugins.status.enabled')
  if (p.status === 'disabled') return t('plugins.status.disabled')
  return `${p.enabled ? `${t('plugins.status.enabled')} · ` : ''}${t('plugins.status.unsupported')}`
}

/** The newer version of the official list, when it can be installed on this server from the list. */
const updateFor = (c: CatalogPlugin | undefined) => (c?.installedVersion && c.updateAvailable && c.availability === 'available' ? c.version : null)

function InstalledCard({ p, c, reload, review, onOpen }: { p: InstalledPlugin; c: CatalogPlugin | undefined; reload: () => void; review: (id: string) => Promise<void>; onOpen: () => void }) {
  const t = useT()
  const a = useInstalledActions(reload)
  const newer = updateFor(c)
  return (
    <PluginCard id={p.id} testId="plugin-installed" kinds={p.kinds} name={p.name} official={p.trust === 'official'} onOpen={onOpen}
      line={statusText(t, p)} lineTone={p.status === 'unsupported' ? 'warn' : undefined}
      foot={<>
        <span>{t('plugins.version', { version: p.version })}</span>
        {p.trust !== 'official' && <Badge tone="warn">{t(`plugins.trust.${p.trust}`)}</Badge>}
        {newer && <span data-testid="plugin-update-badge"><Badge tone="accent">{t('plugins.update', { version: newer })}</Badge></span>}
      </>}
      actions={<>
        <Toggle p={p} a={a} />
        <InstalledMenu p={p} a={a} update={newer ? { version: newer, run: () => void review(p.id) } : undefined} />
      </>}
    />
  )
}

/** The right side of a Discover card and the main action of a plugin's page that is not installed (or has an update):
 * install through the permission prompt, or why not here. The server may first download the package. */
function useReview(review: (id: string) => Promise<void>, id: string) {
  const [busy, setBusy] = useState(false)
  return { busy, run: async () => { setBusy(true); try { await review(id) } finally { setBusy(false) } } }
}

function DiscoverCard({ c, review, onOpen }: { c: CatalogPlugin; review: (id: string) => Promise<void>; onOpen: () => void }) {
  const t = useT()
  const r = useReview(review, c.id)
  const newer = updateFor(c)
  const todo = !c.installedVersion || c.updateAvailable
  return (
    <PluginCard id={c.id} testId="plugin-catalog" kinds={c.kinds} name={c.name} official onOpen={onOpen} line={c.description}
      foot={<>
        <span>{t('plugins.publisher', { name: c.publisher.name })}</span>
        {c.recommended && <span data-testid="plugin-recommended"><Badge tone="accent">{t('plugins.recommended')}</Badge></span>}
      </>}
      actions={!todo ? (
        <Tooltip label={t('plugins.discover.added', { name: c.name })}>
          <span className="flex size-8 items-center justify-center text-ok" role="img" aria-label={t('plugins.discover.added', { name: c.name })} data-testid="plugin-added">
            <Check size={16} aria-hidden />
          </span>
        </Tooltip>
      ) : c.availability === 'available' ? (
        <IconButton label={newer ? t('plugins.update', { version: newer }) : t('plugins.discover.add', { name: c.name })} disabled={r.busy} aria-busy={r.busy || undefined} onClick={() => void r.run()} data-testid="plugin-catalog-install">
          {r.busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : newer ? <ArrowUpCircle size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
        </IconButton>
      ) : (
        <span className="pt-1.5 text-xs text-faint" data-testid="plugin-card-off">
          {t(c.availability === 'unsupported' ? 'plugins.status.unsupported' : c.availability === 'file' ? 'plugins.card.file' : 'plugins.card.pending')}
        </span>
      )}
    />
  )
}

/** A plugin's page in place of the lists, like a connector's page: back, a big tile, the name with its version and
 * publisher, the main action on the right; then what it is, what it will do, and the details. `p`: installed here;
 * `c`: its entry in the official list (a plugin from a file has none). */
function PluginDetail({ p, c, fileInstall, reload, review, onBack }: { p: InstalledPlugin | undefined; c: CatalogPlugin | undefined; fileInstall: boolean; reload: () => void; review: (id: string) => Promise<void>; onBack: () => void }) {
  const t = useT()
  const titleId = useId()
  const back = useRef<HTMLButtonElement>(null)
  const a = useInstalledActions(reload)
  const of = (p ?? c)!
  const r = useReview(review, of.id)
  // the card that opened this page is gone: the keyboard starts on the way back
  useEffect(() => { back.current?.focus() }, [])
  const newer = updateFor(c)
  const todo = !!c && (!c.installedVersion || c.updateAvailable)
  const official = p ? p.trust === 'official' : true
  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid="plugin-detail" data-plugin={of.id}>
      <div className="rounded-2xl bg-subtle p-5 sm:p-6">
        {/* a phone: the bar's ‹ above is the way back (the page has its own address) */}
        <button ref={back} type="button" className="mb-4 flex items-center gap-1.5 text-sm text-muted hover:text-ink max-md:hidden" onClick={onBack} data-testid="plugin-back">
          <ArrowLeft size={15} aria-hidden /> {t('admin.plugins')}
        </button>
        <div className="flex flex-wrap items-center gap-4">
          <PluginTile kinds={of.kinds} big />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="truncate">{of.name}</span>
              {official && <OfficialMark size={18} />}
            </h3>
            <p className="mt-0.5 text-sm text-muted">{t('plugins.version', { version: of.version })} · {t('plugins.publisher', { name: of.publisher.name })}</p>
          </div>
          {/* a phone: the buttons on their own line under the name, so the name is never squeezed beside them */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:basis-full max-md:[&_button]:min-h-11">
            {todo && c?.availability === 'available' && (
              <Button variant="primary" busy={r.busy} onClick={() => void r.run()} data-testid="plugin-detail-install">{newer ? t('plugins.update', { version: newer }) : t('plugins.install')}</Button>
            )}
            {p && <Toggle p={p} a={a} />}
            {p && <InstalledMenu p={p} a={a} onRemoved={c ? undefined : onBack} />}
          </div>
        </div>
        {(p || c?.recommended) && (
          <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="plugin-detail-state">
            {p && <Badge tone={p.status === 'enabled' ? 'ok' : p.status === 'disabled' ? 'neutral' : 'warn'}>{statusText(t, p)}</Badge>}
            {p && <TrustBadge trust={p.trust} verifiedBy={p.verifiedBy} />}
            {!p && c?.recommended && <span data-testid="plugin-recommended"><Badge tone="accent">{t('plugins.recommended')}</Badge></span>}
            {!p && c?.recommended && <span className="text-xs text-muted">{t('plugins.recommendedHint')}</span>}
          </div>
        )}
        {p?.unsupported && <p className="mt-3 text-sm text-warn" data-testid="plugin-unsupported">{t(`plugins.unsupported.${p.unsupported}` as MessageKey)}</p>}
        {todo && c?.availability === 'file' && <p className="mt-3 text-sm text-muted" data-testid="plugin-from-file">{t(fileInstall ? 'plugins.availability.file' : 'plugins.availability.fileHosted')}</p>}
        {c?.availability === 'pending_clearance' && <p className="mt-3 text-sm text-warn" data-testid="plugin-not-yet">{t('plugins.availability.pending')}</p>}
        {c?.availability === 'unsupported' && (
          <p className="mt-3 text-sm text-warn" data-testid="plugin-not-supported">{t('plugins.availability.unsupported')} {c.unsupported ? t(`plugins.unsupported.${c.unsupported}` as MessageKey) : ''}</p>
        )}
      </div>
      <div className="max-w-3xl space-y-2">
        <p className="text-sm leading-relaxed text-ink/90">{of.description}</p>
        <HwpWriting id={of.id} />
      </div>
      <div>
        <h4 className="mb-3 text-base font-semibold">{t('plugins.prompt.does')}</h4>
        {p ? <Permissions items={p.permissions} showGrant /> : <Permissions items={of.permissions} />}
        {p && p.skills.length > 0 && <p className="mt-3 text-sm text-muted">{t('plugins.skills', { list: p.skills.map((s) => s.split('/').slice(-2, -1)[0]).join(', ') })}</p>}
      </div>
      <div>
        <h4 className="mb-2 text-base font-semibold">{t('plugins.details')}</h4>
        <PluginMeta text={`${of.kinds.map((k) => t(`plugins.kind.${k}` as MessageKey)).join(', ')} · ${t('plugins.platforms', { list: platformText(t, of.platforms) })}`} license={of.license} />
      </div>
    </section>
  )
}

const sectionTitle = 'mb-3 text-sm font-semibold'
/** two columns of cards; a phone, one row each with a hairline between (as Connectors' Discover) */
const pluginListCls = 'grid gap-3 md:grid-cols-2 max-md:gap-0 max-md:divide-y max-md:divide-line max-md:border-y max-md:border-line'

export default function Plugins() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.listPlugins))
  const [plan, setPlan] = useState<PluginPlan | null>(null)
  const [query, setQuery] = useState('')
  // a plugin's page: its own address, /admin/plugins/<id> (?focus=<plugin id>, a link from elsewhere in Admin, leads
  // there: AdminLayout.tsx), in place of the lists; Back or its way back return to them
  const sub = useParams().sub
  const open = sub ? decodeURIComponent(sub) : null
  const navigate = useNavigate()
  const upTo = useUpTo()
  const setOpen = (id: string | null) => {
    if (id === null) { if (open !== null) upTo('/admin/plugins'); return }
    if (id !== open) navigate(`/admin/plugins/${encodeURIComponent(id)}`)
  }
  // the phone's bar names the plugin whose page this is
  const named = open ? (state.data?.installed.find((x) => x.id === open) ?? state.data?.catalog.find((x) => x.id === open))?.name : undefined
  useAdminBar(named ?? null)
  // an address of a plugin this server does not list (removed, a typo): the lists
  const unknown = open !== null && !!state.data && !named
  useEffect(() => { if (unknown) navigate('/admin/plugins', { replace: true }) }, [unknown, navigate])
  const file = useRef<HTMLInputElement>(null)
  const installedId = useId()
  const discoverId = useId()
  const reload = () => void state.reload()
  const inspect = async (fn: () => Promise<PluginPlan>) => {
    try { setPlan(await fn()) } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }) }
  }
  const review = (id: string) => inspect(() => api.call(API.inspectPluginSource, { body: { source: 'catalog', id } }))
  // back from a plugin's page: the keyboard returns to the card that opened it (once the lists show again: going back
  // in the history takes a moment)
  const back = () => {
    const id = open
    setOpen(null)
    const focus = (frames: number) => requestAnimationFrame(() => {
      const card = [...document.querySelectorAll<HTMLElement>('[data-plugin]')].find((e) => e.dataset.plugin === id && e.dataset.testid !== 'plugin-detail')
      const button = card?.querySelector<HTMLElement>('[data-testid="plugin-open"]')
      if (button) button.focus()
      else if (frames > 1) focus(frames - 1)
    })
    focus(20)
  }
  return (
    <>
    <StickyHeader className="-mt-3 mb-2 flex flex-wrap items-center gap-x-4 gap-y-3 py-3" testId="plugins-header">
      {/* a phone: the bar above says the name, so only the search row stays here */}
      <h2 className="text-lg font-semibold tracking-tight max-md:sr-only">{t('admin.plugins')}</h2>
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null) }} placeholder={t('plugins.search')} aria-label={t('plugins.search')} className={`${inputCls} pl-9`} data-testid="plugin-search" />
        </div>
        {state.data?.fileInstall && (
          <>
            <input ref={file} type="file" accept=".trinaplugin" className="hidden" data-testid="plugin-file-input" onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void inspect(() => api.call(API.inspectPluginFile, { body: { fields: {}, file: f, filename: f.name } }))
            }} />
            <Tooltip label={t('plugins.installFile')}>
              <Button className="shrink-0 max-md:size-11 max-md:px-0" aria-label={t('plugins.installFile')} onClick={() => file.current?.click()} data-testid="plugin-install-file"><FileUp size={15} aria-hidden /> <span className="max-md:hidden">{t('plugins.installFile')}</span></Button>
            </Tooltip>
          </>
        )}
      </div>
    </StickyHeader>
    <Loadable state={state}>
      {(d: PluginList) => {
        const shownPage = open ? { p: d.installed.find((x) => x.id === open), c: d.catalog.find((x) => x.id === open) } : null
        const q = query.trim().toLocaleLowerCase()
        const fits = (x: { name: string; description: string }) => !q || `${x.name} ${x.description}`.toLocaleLowerCase().includes(q)
        const installed = d.installed.filter(fits)
        const catalog = d.catalog.filter(fits)
        const imports = d.imports.filter((f) => !q || f.name.toLocaleLowerCase().includes(q))
        return (
          <>
            {d.trustWarnings.length > 0 && (
              <p className="mb-4 flex items-start gap-2 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm text-warn" role="alert" data-testid="plugin-dev-trust">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                {t('plugins.devTrust', { list: d.trustWarnings.map((w) => t(`plugins.devTrust.${w}`)).join(', ') })}
              </p>
            )}
            {shownPage && (shownPage.p || shownPage.c) ? (
              <PluginDetail key={open} p={shownPage.p} c={shownPage.c} fileInstall={d.fileInstall} reload={reload} review={review} onBack={back} />
            ) : q && !installed.length && !catalog.length && !imports.length ? (
              <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
            ) : (
              <>
                {/* what plugins are and who installs them, right under the title */}
                {!q && <p className="mb-5 max-w-3xl text-sm text-muted" data-testid="plugins-note">{d.trust.hosted ? t('plugins.hosted') : t('plugins.desc')}</p>}
                {/* nothing installed yet: no heading and no empty box, Discover leads (as on Connected apps) */}
                {installed.length > 0 && (
                  <section aria-labelledby={installedId} data-testid="plugins-installed-section">
                    <h3 id={installedId} className={sectionTitle}>{t('plugins.installed')}</h3>
                    <ul className={pluginListCls} data-testid="plugins-installed">
                      {installed.map((p) => <InstalledCard key={p.id} p={p} c={d.catalog.find((x) => x.id === p.id)} reload={reload} review={review} onOpen={() => setOpen(p.id)} />)}
                    </ul>
                  </section>
                )}
                {(catalog.length > 0 || (!q && d.catalogSource === 'none')) && (
                  <section aria-labelledby={discoverId} className={installed.length > 0 ? 'mt-6 border-t border-line pt-6' : undefined} data-testid="plugins-discover">
                    <h3 id={discoverId} className={sectionTitle}>{t('connectors.discover')}</h3>
                    <div className="mb-3 flex items-center gap-2">
                      <h4 className="flex items-center gap-2 text-sm font-medium text-muted">
                        {q ? t('connectors.results') : t('plugins.catalog')}
                        <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums" data-testid="plugin-count">{catalog.length}</span>
                      </h4>
                    </div>
                    {catalog.length > 0
                      ? <ul className={pluginListCls} data-testid="plugins-catalog">{catalog.map((c) => <DiscoverCard key={c.id} c={c} review={review} onOpen={() => setOpen(c.id)} />)}</ul>
                      : <p className="text-sm text-muted">{t('plugins.catalog.none')}</p>}
                    {d.catalogSource !== 'none' && <p className="mt-4 text-xs text-faint" data-testid="plugins-catalog-source">{t(`plugins.catalog.${d.catalogSource}` as MessageKey)}</p>}
                  </section>
                )}
                {imports.length > 0 && (
                  <section className="mt-6 border-t border-line pt-6" data-testid="plugins-imports">
                    <h3 className="text-sm font-semibold">{t('plugins.imports')}</h3>
                    <p className="mt-1 mb-2 text-xs text-muted">{t('plugins.importsDesc')}</p>
                    <ul className="-mx-2 divide-y divide-line">
                      {imports.map((f) => (
                        <li key={f.name} className="flex items-center gap-2 px-2 py-2 text-sm">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
                          <span className="text-xs text-faint">{formatSize(f.size, locale)}</span>
                          <Button size="sm" onClick={() => void inspect(() => api.call(API.inspectPluginSource, { body: { source: 'import', name: f.name } }))}>{t('plugins.review')}</Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
            {plan && <PlanDialog plan={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); reload() }} />}
          </>
        )
      }}
    </Loadable>
    </>
  )
}
