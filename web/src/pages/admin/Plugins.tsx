// Admin > Plugins (docs/PLUGINS.md): what the company has installed, the official list, and package files. Installing
// always goes through the permission prompt: the server checks the package first (official pin or signature, files,
// platform) and the admin approves exactly the digest and permissions shown. Optional permissions start ticked (as in
// Claude Code) and the prompt says so. Stage 1 turns plugins on for the whole company only.
// A phone (below 768 px): the sections without frames, one line per plugin (its name, its state and its main button),
// and what it does, who made it and its permissions open when the name is tapped; the install prompt shows the
// permissions again before anything is installed (docs/DECISIONS.md "Admin and Settings on phones").
import clsx from 'clsx'
import { AlertTriangle, Check, ChevronRight, FileUp, Minus, Puzzle, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { CatalogPlugin, InstalledPlugin, PluginList, PluginPlan } from '@mycel/shared/api'
import type { PluginPermission, PluginPlatform } from '@mycel/shared/plugins'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, EmptyState, Modal, confirmDialog, useMediaQuery } from '../../components/ui'
import { AdminPageHeader, Card, Loadable, useLoad } from './common'

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

/** A plugin's name on a phone: it opens and closes the rest of the row (what it does, who made it, its permissions). */
function PluginName({ name, open, onToggle, controls }: { name: string; open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle} className="-ml-1 flex min-h-11 min-w-0 items-center gap-1.5 rounded-md px-1 text-left font-medium hover:bg-hover" data-testid="plugin-open">
      <ChevronRight size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
      <span className="truncate">{name}</span>
    </button>
  )
}

const PHONE = '(max-width: 767.98px)'

function InstalledRow({ p, reload, initiallyOpen }: { p: InstalledPlugin; reload: () => void; initiallyOpen: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast({ level: 'success', text: ok }); reload() } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }) } finally { setBusy(false) }
  }
  const phone = useMediaQuery(PHONE)
  const [open, setOpen] = useState(initiallyOpen)
  const detailsId = useId()
  const status = p.status === 'enabled' ? <Badge tone="ok">{t('plugins.status.enabled')}</Badge>
    : p.status === 'disabled' ? <Badge>{t('plugins.status.disabled')}</Badge>
    : <Badge tone="warn">{p.enabled ? t('plugins.status.enabled') + ' · ' : ''}{t('plugins.status.unsupported')}</Badge>
  const onOff = p.enabled
    ? <Button size="sm" className="max-md:h-11" busy={busy} onClick={() => void run(() => api.call(API.disablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.disabled', { name: p.name }))} data-testid="plugin-disable">{t('plugins.disable')}</Button>
    : <Button size="sm" className="max-md:h-11" variant="primary" busy={busy} disabled={p.status === 'unsupported'} onClick={() => void run(() => api.call(API.enablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.enabled', { name: p.name }))} data-testid="plugin-enable">{t('plugins.enable')}</Button>
  const about = (
    <>
      <p className="text-sm text-muted">{p.description}</p>
      <HwpWriting id={p.id} />
      <p className="text-xs text-faint">
        {t('plugins.publisher', { name: p.publisher.name })} · {p.kinds.map((k) => t(`plugins.kind.${k}` as MessageKey)).join(', ')} · {t('plugins.platforms', { list: platformText(t, p.platforms) })}
      </p>
    </>
  )
  const unsupported = p.unsupported && <p className="text-sm text-warn" data-testid="plugin-unsupported">{t(`plugins.unsupported.${p.unsupported}` as MessageKey)}</p>
  const access = (
    <>
      <Permissions items={p.permissions} showGrant />
      {p.skills.length > 0 && <p className="text-xs text-muted">{t('plugins.skills', { list: p.skills.map((s) => s.split('/').slice(-2, -1)[0]).join(', ') })}</p>}
    </>
  )
  const others = (
    <>
      {p.previousVersion && (
        <Button size="sm" className="max-md:h-11" busy={busy} onClick={() => void run(() => api.call(API.rollbackPlugin, { params: { id: p.id }, body: {} }), t('plugins.done.rolledBack', { name: p.name, version: p.previousVersion! }))} data-testid="plugin-rollback">
          <RotateCcw size={14} aria-hidden /> {t('plugins.rollback', { version: p.previousVersion })}
        </Button>
      )}
      <Button size="sm" className="max-md:h-11" variant="ghost" busy={busy} data-testid="plugin-remove" onClick={async () => {
        if (!(await confirmDialog({ title: t('plugins.removeTitle', { name: p.name }), body: t('plugins.removeBody'), confirm: t('plugins.remove'), danger: true }))) return
        await run(() => api.call(API.uninstallPlugin, { params: { id: p.id } }), t('plugins.done.removed', { name: p.name }))
      }}>
        <Trash2 size={14} aria-hidden /> {t('plugins.remove')}
      </Button>
    </>
  )
  // a phone: the name (it opens the rest), its state and turn on / off on one line; a trust warning or why it cannot
  // run stays in sight; the rest, with roll back and remove, opens under it
  if (phone)
    return (
      <li className="py-1.5" data-testid="plugin-installed" data-plugin={p.id}>
        <div className="flex items-center gap-2">
          <PluginName name={p.name} open={open} onToggle={() => setOpen(!open)} controls={detailsId} />
          <span className="flex shrink-0 items-center">{status}</span>
          <span className="ml-auto flex shrink-0">{onOff}</span>
        </div>
        {p.trust !== 'official' && <p className="pb-1 pl-5"><TrustBadge trust={p.trust} verifiedBy={p.verifiedBy} /></p>}
        {unsupported && <div className="pb-1 pl-5">{unsupported}</div>}
        {open && (
          <div id={detailsId} className="space-y-2 pb-2 pl-5" data-testid="plugin-details">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {t('plugins.version', { version: p.version })}
              {p.trust === 'official' && <TrustBadge trust={p.trust} verifiedBy={p.verifiedBy} />}
            </p>
            {about}
            {access}
            <div className="flex flex-wrap gap-2 pt-1">{others}</div>
          </div>
        )}
      </li>
    )
  return (
    <li className="space-y-2 px-4 py-3" data-testid="plugin-installed" data-plugin={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-muted">{t('plugins.version', { version: p.version })}</span>
        <TrustBadge trust={p.trust} verifiedBy={p.verifiedBy} />
        {status}
      </div>
      {about}
      {unsupported}
      {access}
      <div className="flex flex-wrap gap-2 pt-1">
        {onOff}
        {others}
      </div>
    </li>
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

function CatalogRow({ c, review, fileInstall, initiallyOpen }: { c: CatalogPlugin; review: (id: string) => Promise<void>; fileInstall: boolean; initiallyOpen: boolean }) {
  const t = useT()
  const phone = useMediaQuery(PHONE)
  const [open, setOpen] = useState(initiallyOpen)
  const detailsId = useId()
  // the server may first download the package from the release feed
  const [busy, setBusy] = useState(false)
  // installed and up to date: the full text is already in "Installed" above, so here one line and a link to it
  if (c.installedVersion && !c.updateAvailable) {
    return (
      <li className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm max-md:px-0" data-testid="plugin-catalog" data-plugin={c.id} data-compact>
        <span className="font-medium">{c.name}</span>
        <Badge tone="ok">{t('plugins.installedVersion', { version: c.installedVersion })}</Badge>
        <button
          type="button"
          className="ml-auto text-xs font-medium text-accent-text underline-offset-2 hover:underline max-md:min-h-11"
          onClick={() => {
            const el = [...document.querySelectorAll<HTMLElement>('[data-testid="plugin-installed"]')].find((x) => x.dataset.plugin === c.id)
            if (!el) return
            el.tabIndex = -1
            el.scrollIntoView({ block: 'center' })
            el.focus({ preventScroll: true })
          }}
          data-testid="plugin-catalog-show-installed"
        >
          {/* the visible words start the name (a voice command says them); the plugin name follows for screen readers */}
          {t('adminux.plugins.showInstalled')}
          <span className="sr-only">: {c.name}</span>
        </button>
      </li>
    )
  }
  const recommended = c.recommended && <span data-testid="plugin-recommended"><Badge tone="accent">{t('plugins.recommended')}</Badge></span>
  const installed = c.installedVersion && <Badge>{t('plugins.installedVersion', { version: c.installedVersion })}</Badge>
  const about = (
    <>
      <p className="text-sm text-muted">{c.description}</p>
      <HwpWriting id={c.id} />
      <PluginMeta text={`${t('plugins.publisher', { name: c.publisher.name })} · ${t('plugins.platforms', { list: platformText(t, c.platforms) })}`} license={c.license} />
      {c.recommended && <p className="text-xs text-muted">{t('plugins.recommendedHint')}</p>}
      <Permissions items={c.permissions} />
    </>
  )
  const install = c.availability === 'available' && (!c.installedVersion || c.updateAvailable) && (
    <Button size="sm" className="max-md:h-11" variant="primary" busy={busy} disabled={busy} onClick={async () => { setBusy(true); try { await review(c.id) } finally { setBusy(false) } }} data-testid="plugin-catalog-install">{c.installedVersion ? t('plugins.update', { version: c.version }) : t('plugins.install')}</Button>
  )
  const availability = (
    <>
      {c.availability === 'file' && (!c.installedVersion || c.updateAvailable) && (
        <p className="text-sm text-muted" data-testid="plugin-from-file">{t(fileInstall ? 'plugins.availability.file' : 'plugins.availability.fileHosted')}</p>
      )}
      {c.availability === 'pending_clearance' && <p className="text-sm text-warn" data-testid="plugin-not-yet">{t('plugins.availability.pending')}</p>}
      {c.availability === 'unsupported' && (
        <p className="text-sm text-warn" data-testid="plugin-not-supported">{t('plugins.availability.unsupported')} {c.unsupported ? t(`plugins.unsupported.${c.unsupported}` as MessageKey) : ''}</p>
      )}
    </>
  )
  // a phone: the name (it opens the rest), Recommended and Install on one line; why it cannot be installed stays in
  // sight; the rest opens under it
  if (phone)
    return (
      <li className="py-1.5" data-testid="plugin-catalog" data-plugin={c.id}>
        <div className="flex items-center gap-2">
          <PluginName name={c.name} open={open} onToggle={() => setOpen(!open)} controls={detailsId} />
          {(recommended || installed) && <span className="flex shrink-0 items-center gap-1.5">{recommended}{installed}</span>}
          {install && <span className="ml-auto flex shrink-0">{install}</span>}
        </div>
        <div className="space-y-2 pl-5 empty:hidden">{availability}</div>
        {open && (
          <div id={detailsId} className="space-y-2 pt-1 pb-2 pl-5" data-testid="plugin-details">
            <p className="text-xs text-muted">{t('plugins.version', { version: c.version })}</p>
            {about}
          </div>
        )}
      </li>
    )
  return (
    <li className="space-y-2 px-4 py-3" data-testid="plugin-catalog" data-plugin={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-muted">{t('plugins.version', { version: c.version })}</span>
        {recommended}
        {installed}
      </div>
      {about}
      {install}
      {availability}
    </li>
  )
}

export default function Plugins() {
  const t = useT()
  const locale = useLocale()
  const phone = useMediaQuery(PHONE)
  const state = useLoad(() => api.call(API.listPlugins))
  const [plan, setPlan] = useState<PluginPlan | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const reload = () => void state.reload()
  // ?focus=<plugin id> (an Admin Home to-do): bring that plugin's card into view once the list is there
  const focus = useSearchParams()[0].get('focus')
  const listed = state.data !== null
  useEffect(() => {
    if (!focus || !listed) return
    const el = [...document.querySelectorAll<HTMLElement>('[data-plugin]')].find((e) => e.dataset.plugin === focus)
    if (!el) return
    el.tabIndex = -1
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
  }, [focus, listed])
  const inspect = async (fn: () => Promise<PluginPlan>) => {
    try { setPlan(await fn()) } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }) }
  }
  return (
    <>
    <AdminPageHeader title={t('admin.plugins')} />
    <Loadable state={state}>
      {(d: PluginList) => (
        <>
          {d.trustWarnings.length > 0 && (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm text-warn" role="alert" data-testid="plugin-dev-trust">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {t('plugins.devTrust', { list: d.trustWarnings.map((w) => t(`plugins.devTrust.${w}`)).join(', ') })}
            </p>
          )}
          <Card flat title={t('plugins.installed')} desc={d.trust.hosted ? t('plugins.hosted') : t('plugins.desc')} actions={d.fileInstall && (
            <>
              <input ref={file} type="file" accept=".trinaplugin" className="hidden" data-testid="plugin-file-input" onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void inspect(() => api.call(API.inspectPluginFile, { body: { fields: {}, file: f, filename: f.name } }))
              }} />
              <Button size="sm" className="max-md:h-11" onClick={() => file.current?.click()} data-testid="plugin-install-file"><FileUp size={14} aria-hidden /> {t('plugins.installFile')}</Button>
            </>
          )}>
            {d.installed.length
              ? <ul className="-m-4 divide-y divide-line max-md:m-0" data-testid="plugins-installed">{d.installed.map((p) => <InstalledRow key={p.id} p={p} reload={reload} initiallyOpen={focus === p.id} />)}</ul>
              // a phone: one line, not a block of its own above the plugins to install
              : phone ? <p className="text-sm text-faint" data-testid="plugins-installed-empty">{t('plugins.installedEmpty')}</p> : <EmptyState icon={<Puzzle size={26} />} title={t('plugins.installedEmpty')} />}
          </Card>
          <Card flat title={t('plugins.catalog')} desc={t(`plugins.catalog.${d.catalogSource}` as MessageKey)}>
            {d.catalog.length
              ? <ul className="-m-4 divide-y divide-line max-md:m-0" data-testid="plugins-catalog">{d.catalog.map((c) => <CatalogRow key={c.id} c={c} fileInstall={d.fileInstall} initiallyOpen={focus === c.id} review={(id) => inspect(() => api.call(API.inspectPluginSource, { body: { source: 'catalog', id } }))} />)}</ul>
              : <p className="text-sm text-muted">{t('plugins.catalog.none')}</p>}
          </Card>
          {d.imports.length > 0 && (
            <Card flat title={t('plugins.imports')} desc={t('plugins.importsDesc')}>
              <ul className="-m-4 divide-y divide-line max-md:m-0">
                {d.imports.map((f) => (
                  <li key={f.name} className="flex items-center gap-2 px-4 py-2 text-sm max-md:px-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
                    <span className="text-xs text-faint">{formatSize(f.size, locale)}</span>
                    <Button size="sm" className="max-md:h-11" onClick={() => void inspect(() => api.call(API.inspectPluginSource, { body: { source: 'import', name: f.name } }))}>{t('plugins.review')}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {plan && <PlanDialog plan={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); reload() }} />}
        </>
      )}
    </Loadable>
    </>
  )
}
