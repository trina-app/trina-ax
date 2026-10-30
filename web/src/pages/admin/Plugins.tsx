// Admin > Plugins (docs/PLUGINS.md): what the company has installed, the official list, and package files. Installing
// always goes through the permission prompt: the server checks the package first (official pin or signature, files,
// platform) and the admin approves exactly the digest and permissions shown. Optional permissions start ticked (as in
// Claude Code) and the prompt says so. Stage 1 turns plugins on for the whole company only.
import { AlertTriangle, Check, FileUp, Minus, Puzzle, RotateCcw, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { CatalogPlugin, InstalledPlugin, PluginList, PluginPlan } from '@mycel/shared/api'
import type { PluginPermission, PluginPlatform } from '@mycel/shared/plugins'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, EmptyState, Modal, confirmDialog } from '../../components/ui'
import { Card, Loadable, useLoad } from './common'

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
        <p className="font-mono text-[11px] break-all text-faint">{t('plugins.prompt.digest', { digest: plan.manifestSha256.slice(0, 16) })}</p>
      </div>
    </Modal>
  )
}

function InstalledRow({ p, reload }: { p: InstalledPlugin; reload: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast({ level: 'success', text: ok }); reload() } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }) } finally { setBusy(false) }
  }
  const status = p.status === 'enabled' ? <Badge tone="ok">{t('plugins.status.enabled')}</Badge>
    : p.status === 'disabled' ? <Badge>{t('plugins.status.disabled')}</Badge>
    : <Badge tone="warn">{p.enabled ? t('plugins.status.enabled') + ' · ' : ''}{t('plugins.status.unsupported')}</Badge>
  return (
    <li className="space-y-2 px-4 py-3" data-testid="plugin-installed" data-plugin={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-muted">{t('plugins.version', { version: p.version })}</span>
        <TrustBadge trust={p.trust} verifiedBy={p.verifiedBy} />
        {status}
      </div>
      <p className="text-sm text-muted">{p.description}</p>
      <p className="text-xs text-faint">
        {t('plugins.publisher', { name: p.publisher.name })} · {p.kinds.map((k) => t(`plugins.kind.${k}` as MessageKey)).join(', ')} · {t('plugins.platforms', { list: platformText(t, p.platforms) })}
      </p>
      {p.unsupported && <p className="text-sm text-warn" data-testid="plugin-unsupported">{t(`plugins.unsupported.${p.unsupported}` as MessageKey)}</p>}
      <Permissions items={p.permissions} showGrant />
      {p.skills.length > 0 && <p className="text-xs text-muted">{t('plugins.skills', { list: p.skills.map((s) => s.split('/').slice(-2, -1)[0]).join(', ') })}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {p.enabled
          ? <Button size="sm" busy={busy} onClick={() => void run(() => api.call(API.disablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.disabled', { name: p.name }))} data-testid="plugin-disable">{t('plugins.disable')}</Button>
          : <Button size="sm" variant="primary" busy={busy} disabled={p.status === 'unsupported'} onClick={() => void run(() => api.call(API.enablePlugin, { params: { id: p.id }, body: {} }), t('plugins.done.enabled', { name: p.name }))} data-testid="plugin-enable">{t('plugins.enable')}</Button>}
        {p.previousVersion && (
          <Button size="sm" busy={busy} onClick={() => void run(() => api.call(API.rollbackPlugin, { params: { id: p.id }, body: {} }), t('plugins.done.rolledBack', { name: p.name, version: p.previousVersion! }))} data-testid="plugin-rollback">
            <RotateCcw size={14} aria-hidden /> {t('plugins.rollback', { version: p.previousVersion })}
          </Button>
        )}
        <Button size="sm" variant="ghost" busy={busy} data-testid="plugin-remove" onClick={async () => {
          if (!(await confirmDialog({ title: t('plugins.removeTitle', { name: p.name }), body: t('plugins.removeBody'), confirm: t('plugins.remove'), danger: true }))) return
          await run(() => api.call(API.uninstallPlugin, { params: { id: p.id } }), t('plugins.done.removed', { name: p.name }))
        }}>
          <Trash2 size={14} aria-hidden /> {t('plugins.remove')}
        </Button>
      </div>
    </li>
  )
}

function CatalogRow({ c, review, fileInstall }: { c: CatalogPlugin; review: (id: string) => Promise<void>; fileInstall: boolean }) {
  const t = useT()
  // the server may first download the package from the release feed
  const [busy, setBusy] = useState(false)
  return (
    <li className="space-y-2 px-4 py-3" data-testid="plugin-catalog" data-plugin={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-muted">{t('plugins.version', { version: c.version })}</span>
        {c.recommended && <span data-testid="plugin-recommended"><Badge tone="accent">{t('plugins.recommended')}</Badge></span>}
        {c.installedVersion && <Badge>{t('plugins.installedVersion', { version: c.installedVersion })}</Badge>}
      </div>
      <p className="text-sm text-muted">{c.description}</p>
      <p className="text-xs text-faint">{t('plugins.publisher', { name: c.publisher.name })} · {t('plugins.platforms', { list: platformText(t, c.platforms) })} · {c.license}</p>
      {c.recommended && <p className="text-xs text-muted">{t('plugins.recommendedHint')}</p>}
      <Permissions items={c.permissions} />
      {c.availability === 'available' && (!c.installedVersion || c.updateAvailable) && (
        <Button size="sm" variant="primary" busy={busy} disabled={busy} onClick={async () => { setBusy(true); try { await review(c.id) } finally { setBusy(false) } }} data-testid="plugin-catalog-install">{c.installedVersion ? t('plugins.update', { version: c.version }) : t('plugins.install')}</Button>
      )}
      {c.availability === 'file' && (!c.installedVersion || c.updateAvailable) && (
        <p className="text-sm text-muted" data-testid="plugin-from-file">{t(fileInstall ? 'plugins.availability.file' : 'plugins.availability.fileHosted')}</p>
      )}
      {c.availability === 'pending_clearance' && <p className="text-sm text-warn" data-testid="plugin-not-yet">{t('plugins.availability.pending')}</p>}
      {c.availability === 'unsupported' && (
        <p className="text-sm text-warn" data-testid="plugin-not-supported">{t('plugins.availability.unsupported')} {c.unsupported ? t(`plugins.unsupported.${c.unsupported}` as MessageKey) : ''}</p>
      )}
    </li>
  )
}

export default function Plugins() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(() => api.call(API.listPlugins))
  const [plan, setPlan] = useState<PluginPlan | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const reload = () => void state.reload()
  const inspect = async (fn: () => Promise<PluginPlan>) => {
    try { setPlan(await fn()) } catch (e) { toast({ level: 'error', text: refusal(t, e, locale) }) }
  }
  return (
    <Loadable state={state}>
      {(d: PluginList) => (
        <>
          {d.trustWarnings.length > 0 && (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm text-warn" role="alert" data-testid="plugin-dev-trust">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {t('plugins.devTrust', { list: d.trustWarnings.map((w) => t(`plugins.devTrust.${w}`)).join(', ') })}
            </p>
          )}
          <Card title={t('plugins.installed')} desc={d.trust.hosted ? t('plugins.hosted') : t('plugins.desc')} actions={d.fileInstall && (
            <>
              <input ref={file} type="file" accept=".trinaplugin" className="hidden" data-testid="plugin-file-input" onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void inspect(() => api.call(API.inspectPluginFile, { body: { fields: {}, file: f, filename: f.name } }))
              }} />
              <Button size="sm" onClick={() => file.current?.click()} data-testid="plugin-install-file"><FileUp size={14} aria-hidden /> {t('plugins.installFile')}</Button>
            </>
          )}>
            {d.installed.length
              ? <ul className="-m-4 divide-y divide-line" data-testid="plugins-installed">{d.installed.map((p) => <InstalledRow key={p.id} p={p} reload={reload} />)}</ul>
              : <EmptyState icon={<Puzzle size={26} />} title={t('plugins.installedEmpty')} />}
          </Card>
          <Card title={t('plugins.catalog')} desc={t(`plugins.catalog.${d.catalogSource}` as MessageKey)}>
            {d.catalog.length
              ? <ul className="-m-4 divide-y divide-line" data-testid="plugins-catalog">{d.catalog.map((c) => <CatalogRow key={c.id} c={c} fileInstall={d.fileInstall} review={(id) => inspect(() => api.call(API.inspectPluginSource, { body: { source: 'catalog', id } }))} />)}</ul>
              : <p className="text-sm text-muted">{t('plugins.catalog.none')}</p>}
          </Card>
          {d.imports.length > 0 && (
            <Card title={t('plugins.imports')} desc={t('plugins.importsDesc')}>
              <ul className="-m-4 divide-y divide-line">
                {d.imports.map((f) => (
                  <li key={f.name} className="flex items-center gap-2 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
                    <span className="text-xs text-faint">{formatSize(f.size, locale)}</span>
                    <Button size="sm" onClick={() => void inspect(() => api.call(API.inspectPluginSource, { body: { source: 'import', name: f.name } }))}>{t('plugins.review')}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {plan && <PlanDialog plan={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); reload() }} />}
        </>
      )}
    </Loadable>
  )
}
