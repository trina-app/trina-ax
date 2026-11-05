// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx): profile, language and theme, password, signed-in devices, the in-app browser's site setting (desktop
// app only: BrowserSettings.tsx), what the AI remembers, apps (the guide to add the app to the home
// screen, components/settings/InstallGuide.tsx, in a web browser only / desktop app download, none inside a Mac App
// Store build: only the App Store line),
// about (version, license, source code), the member's own AI connections when the team allows them (the team's
// connections are made by the owner in Admin > AI connections), and the MCP connections the AI may use with the
// member's own accounts (Integrations.tsx).
import clsx from 'clsx'
import { Brain, Download, Laptop, Monitor, Pencil, Plus, ShieldAlert, Smartphone, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EngineId, Me, Memory, Session, Theme } from '@mycel/shared/api'
import { RELEASE_CHANNEL } from '@mycel/shared'
import { api, API, errorText } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { deviceLabel } from '../lib/userAgent'
import { archNote, installSteps, offeredDownloads, orderDownloads, parseDownloads, showSteps, type DownloadItem } from '../lib/downloads'
import { installGuideShown, platform, type Platform } from '../lib/pwa'
import { LOCALES, useLocale, useT, type MessageKey } from '../i18n'
import { memoryChanged } from '../store/live'
import { canChooseEngine, useMeStrict, useSession } from '../store/session'
import { useEngines } from '../store/engines'
import { ENGINE_LABEL } from '../components/chat/EngineMenu'
import { toast } from '../store/ui'
import { ChangePasswordForm } from './Auth'
import { MyCredentials } from './admin/Credentials'
import { BrowserSettings } from './BrowserSettings'
import { browserSettingsBridge, storeApp } from '../lib/desktop'
import { Badge, Button, EmptyState, ErrorNote, Field, IconButton, Skeleton, confirmDialog, inputCls, noKeyRepeat } from '../components/ui'
import { SourceCodeLinks, useServerSource } from '../components/SourceCodeLink'
import { DriveConnection } from '../components/settings/DriveConnection'
import { Notifications } from '../components/settings/Notifications'
import { InstallGuide } from '../components/settings/InstallGuide'
import { MemoryForm } from '../components/settings/MemoryForm'
import ConnectorConnections from './ConnectorConnections'
import MyUsage from '../components/settings/MyUsage'
import Integrations from './Integrations'

/** One section of the Settings dialog (components/settings/SettingsDialog.tsx, which owns the list, the address and
 * which sections there are): `tab` is one of settingsTabs(). */
export default function SettingsPane({ tab }: { tab: string }) {
  const me = useMeStrict()
  const browser = browserSettingsBridge()
  return (
    <>
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'usage' && <MyUsage key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'browser' && browser && <BrowserSettings bridge={browser} />}
      {tab === 'memory' && <Memories />}
      {tab === 'drive' && <DriveConnection key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'integrations' && <Integrations key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'connectors' && <ConnectorConnections key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'notifications' && <Notifications key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'apps' && <Apps />}
      {tab === 'credentials' && <MyCredentials />}
      {tab === 'about' && <About />}
    </>
  )
}

function Section({ title, children, desc }: { title: string; children: React.ReactNode; desc?: string }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      {desc && <p className="mb-3 text-sm text-muted">{desc}</p>}
      <div className={desc ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

/** One setting, like Claude's Settings: what it is on the left, its control on the right, a hairline between rows (on a
 * phone the control goes under its name). */
function Row({ label, hint, htmlFor, hintId, children }: { label: string; hint?: string; htmlFor?: string; hintId?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm text-ink">
            {label}
          </label>
        ) : (
          <p className="text-sm text-ink">{label}</p>
        )}
        {hint && (
          <p id={hintId} className="mt-0.5 text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0 sm:w-72 sm:max-w-[60%] sm:shrink-0">{children}</div>
    </div>
  )
}

function Profile() {
  const t = useT()
  const ids = useId()
  const locale = useLocale()
  const me = useMeStrict()
  const signedIn = useSession((s) => s.signedIn)
  const setLocale = useSession((s) => s.setLocale)
  const setTheme = useSession((s) => s.setTheme)
  const [name, setName] = useState(me.user.name)
  const [email, setEmail] = useState(me.user.email ?? '')
  const [busy, setBusy] = useState(false)
  // Name and email are the only fields saved with a button (everything else on this tab saves at once): the button
  // sits in their own card and is off until one of them changed
  const changed = name.trim() !== me.user.name || (email.trim() || null) !== (me.user.email ?? null)
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!changed || !name.trim() || busy) return
    setBusy(true)
    try {
      signedIn(await api.call(API.updateMe, { body: { name: name.trim(), email: email.trim() || null } }))
      toast({ level: 'success', text: t('common.saved') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  const theme = me.user.prefs.theme ?? 'system'
  return (
    <>
      <Section title={t('settings.profile')}>
        {/* noValidate: the server checks the email and its answer shows in the app's own style, not a browser popup */}
        <form onSubmit={save} noValidate className="rounded-xl border border-line px-4 pb-4" data-testid="profile-form">
          <Row label={t('auth.name')} htmlFor={`${ids}-name`}>
            <input id={`${ids}-name`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Row>
          <Row label={t('settings.email')} hint={t('settings.emailHint')} htmlFor={`${ids}-email`} hintId={`${ids}-email-hint`}>
            <input id={`${ids}-email`} className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby={`${ids}-email-hint`} />
          </Row>
          <div className="flex justify-end pt-3">
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !changed}>
              {t('common.save')}
            </Button>
          </div>
        </form>
        <div className="mt-2">
          <Row label={t('auth.username')}>
            <span className="block truncate text-sm text-muted sm:text-right" data-testid="profile-username">
              {me.user.username}
            </span>
          </Row>
          <Row label={t('settings.role')}>
            <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted sm:justify-end">
              <Badge>{t(`role.${me.user.role}`)}</Badge> · {me.groups.map((g) => g.name).join(', ') || t('settings.noGroups')}
            </span>
          </Row>
        </div>
      </Section>
      <Section title={t('settings.language')} desc={t('settings.languageHint')}>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.language')}>
          {[null, ...LOCALES.map((l) => l.id)].map((choice) => {
            const checked = (me.user.localeChoice ?? null) === choice
            const label = choice ? LOCALES.find((l) => l.id === choice)!.label : t('settings.languageTeam', { language: LOCALES.find((l) => l.id === me.team.defaultLocale)?.label ?? me.team.defaultLocale })
            return (
              <button
                key={choice ?? 'team'}
                type="button"
                role="radio"
                aria-checked={checked}
                lang={choice ?? undefined}
                onClick={() => void setLocale(choice).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))}
                className={clsx('rounded-lg border px-3 py-2 text-sm', checked ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}
                data-testid={`locale-${choice ?? 'team'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </Section>
      {canChooseEngine(me) && <MyEngine />}
      <Section title={t('settings.theme')}>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.theme')}>
          {(['system', 'light', 'dark'] as Theme[]).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={theme === x} onClick={() => void setTheme(x).catch(() => {})} className={clsx('rounded-lg border px-3 py-2 text-sm', theme === x ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}>
              {t(`settings.theme.${x}`)}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

/** "내 기본 엔진/모델" (only for people who may pick the engine): what new chats start with; empty = the team default. */
function MyEngine() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const updatePrefs = useSession((s) => s.updatePrefs)
  const { loaded, engines, models, defaultEngine, defaultModel, load } = useEngines()
  useEffect(() => void load(), [load])
  const engine = me.user.prefs.engine && engines.includes(me.user.prefs.engine) ? me.user.prefs.engine : null
  const model = engine ? me.user.prefs.model ?? null : null
  const save = async (e: EngineId | null, m: string | null) => {
    try {
      await updatePrefs({ engine: e, model: e ? m : null })
      toast({ level: 'success', text: t('common.saved') })
    } catch (err) {
      toast({ level: 'error', text: errorText(err, locale, t('error.network')) })
    }
  }
  const teamLabel = ENGINE_LABEL[defaultEngine] + (defaultModel ? ` · ${models[defaultEngine]?.find((x) => x.id === defaultModel)?.label ?? defaultModel}` : '')
  return (
    <Section title={t('settings.myEngine')} desc={t('settings.myEngineHint')}>
      {!loaded ? (
        <Skeleton lines={2} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="my-engine">
          <Field label={t('settings.myEngine.engine')}>
            <select className={inputCls} value={engine ?? ''} onChange={(e) => void save((e.target.value || null) as EngineId | null, null)} data-testid="my-engine-select">
              <option value="">{t('settings.myEngine.team', { engine: teamLabel })}</option>
              {engines.map((id) => (
                <option key={id} value={id}>
                  {ENGINE_LABEL[id]}
                </option>
              ))}
            </select>
          </Field>
          {engine && (
            <Field label={t('settings.myEngine.model')}>
              <select className={inputCls} value={model ?? ''} onChange={(e) => void save(engine, e.target.value || null)} data-testid="my-model-select">
                <option value="">{t('composer.defaultModel')}</option>
                {(models[engine] ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
    </Section>
  )
}

function Security() {
  const t = useT()
  const locale = useLocale()
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    try {
      setSessions((await api.call(API.mySessions)).items)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ICON = { web: Monitor, desktop: Laptop, mobile: Smartphone } as const
  // tab 5: a reset by an admin (or the owner's recovery on the server Mac) stays visible here, so the person learns of it
  const reset = useMeStrict().passwordReset
  return (
    <>
      {reset && (
        <p className="mb-6 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="last-reset">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{reset.by ? t('settings.lastReset', { name: reset.by.name, date: formatDateTime(reset.at, locale) }) : t('settings.lastResetRecovery', { date: formatDateTime(reset.at, locale) })}</span>
        </p>
      )}
      <Section title={t('auth.changePassword')} desc={t('settings.passwordNote')}>
        <ChangePasswordForm onDone={() => toast({ level: 'success', text: t('settings.passwordChanged') })} />
      </Section>
      <Section title={t('settings.devices')} desc={t('settings.devicesHint')}>
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!sessions && !error && <Skeleton lines={3} />}
        <ul className="divide-y divide-line rounded-xl border border-line">
          {sessions?.map((s) => {
            const Icon = ICON[s.client]
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <Icon size={18} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  {/* a short name ("Chrome on macOS"); the raw user agent in the tooltip */}
                  <span className="block truncate" title={s.userAgent ?? undefined} data-testid="device-name">{deviceLabel(s.client, s.userAgent, t)}</span>
                  <span className="block text-xs text-faint">{t('settings.lastSeen', { date: formatDateTime(s.lastSeenAt, locale) })}</span>
                </span>
                {s.current ? (
                  <Badge tone="accent">{t('settings.thisDevice')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onKeyDown={noKeyRepeat}
                    onClick={async () => {
                      try {
                        await api.call(API.revokeMySession, { params: { id: s.id } })
                        void load()
                      } catch (e) {
                        toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
                      }
                    }}
                  >
                    {t('settings.signOutDevice')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </Section>
    </>
  )
}

/** What the AI remembers: newest first; add one, correct one in place (MemoryForm), forget one or all. */
function Memories() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<Memory[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the one form open: 'new', or the id of the memory being corrected
  const [editing, setEditing] = useState<string | null>(null)
  const load = async (more = false) => {
    try {
      const r = await api.call(API.listMemories, { query: { limit: 100, cursor: more ? cursor ?? undefined : undefined } })
      setItems((cur) => (more && cur ? [...cur, ...r.items] : r.items))
      setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    const off = memoryChanged.on(() => void load())
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const remove = async (m: Memory) => {
    try {
      await api.call(API.deleteMemory, { params: { id: m.id } })
      setItems((cur) => cur?.filter((x) => x.id !== m.id) ?? null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const clear = async () => {
    if (!(await confirmDialog({ title: t('memory.clearTitle'), body: t('memory.clearBody'), confirm: t('memory.clear'), danger: true }))) return
    try {
      await api.call(API.clearMemories)
      setItems([])
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  // the server's words go under the field (MemoryForm shows what is thrown)
  const saving = async (run: () => Promise<Memory>, done: (m: Memory) => void, said: string) => {
    let m: Memory
    try {
      m = await run()
    } catch (e) {
      throw new Error(errorText(e, locale, t('error.network')))
    }
    done(m)
    setEditing(null)
    toast({ level: 'success', text: said })
  }
  const add = (text: string) => saving(() => api.call(API.createMemory, { body: { text } }), (m) => setItems((cur) => [m, ...(cur ?? []).filter((x) => x.id !== m.id)]), t('memory.added'))
  const update = (id: string, text: string) => saving(() => api.call(API.updateMemory, { params: { id }, body: { text } }), (m) => setItems((cur) => cur?.map((x) => (x.id === m.id ? m : x)) ?? null), t('memory.updated'))
  const addButton = (
    <Button size="sm" onClick={() => setEditing('new')} disabled={editing === 'new'} data-testid="memory-add">
      <Plus size={14} aria-hidden /> {t('memory.add')}
    </Button>
  )
  return (
    <Section title={t('settings.memory')} desc={t('memory.desc')}>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={3} />}
      {items && (items.length > 0 || editing === 'new') && <div className="mb-3 flex justify-end">{addButton}</div>}
      {items && !items.length && editing !== 'new' && (
        <EmptyState icon={<Brain size={26} />} title={t('memory.empty')}>
          <div className="mt-3">{addButton}</div>
        </EmptyState>
      )}
      {items && (items.length > 0 || editing === 'new') && (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="memory-list">
            {editing === 'new' && (
              <li className="px-4 py-3 text-sm" data-testid="memory-new">
                <MemoryForm submitLabel={t('memory.add')} onSubmit={add} onCancel={() => setEditing(null)} testId="memory-form" />
              </li>
            )}
            {items.map((m) => editing === m.id ? (
              <li key={m.id} className="px-4 py-3 text-sm" data-testid="memory-item" data-editing="true">
                <MemoryForm initial={m.text} submitLabel={t('common.save')} onSubmit={(text) => update(m.id, text)} onCancel={() => setEditing(null)} testId="memory-form" />
              </li>
            ) : (
              <li key={m.id} className="group flex items-start gap-2 px-4 py-3 text-sm" data-testid="memory-item">
                <span className="min-w-0 flex-1">
                  <span className="block break-words whitespace-pre-wrap" data-testid="memory-text">{m.text}</span>
                  <span className="mt-0.5 block text-xs text-faint">
                    {formatDateTime(m.createdAt, locale)}
                    {m.sourceChatId && (
                      <>
                        {' · '}
                        <Link to={`/c/${m.sourceChatId}`} className="text-accent-text hover:underline">
                          {t('memory.source')}
                        </Link>
                      </>
                    )}
                  </span>
                </span>
                <IconButton label={t('memory.editLabel')} onClick={() => setEditing(m.id)} data-testid="memory-edit">
                  <Pencil size={15} />
                </IconButton>
                <IconButton label={t('memory.forget')} danger onClick={() => void remove(m)} onKeyDown={noKeyRepeat} data-testid="memory-forget">
                  <Trash2 size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            {cursor && (
              <Button size="sm" onClick={() => void load(true)}>
                {t('common.loadMore')}
              </Button>
            )}
            {items.length > 0 && (
              <Button size="sm" variant="danger" onClick={clear}>
                {t('memory.clear')}
              </Button>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

/** Version, license and where the source code is (AGPL-3.0 §13). */
function About() {
  const t = useT()
  const info = useServerSource()
  const { version } = info
  return (
    <Section title={t('settings.about')}>
      {version && <p className="text-sm" data-testid="about-version">{t('about.version', { version })}</p>}
      <p className="mt-2 text-sm text-muted">{t('about.license')}</p>
      <p className="mt-2 text-sm text-muted" data-testid="about-hwp">{t('about.hwp')}</p>
      <SourceCodeLinks info={info} className="mt-3 inline-block text-sm text-accent-text underline" />
    </Section>
  )
}

function Apps() {
  const t = useT()
  const p = platform()
  const me = useMeStrict()
  // a Mac App Store build: the store updates it, so no installer here at all (lib/downloads.ts offeredDownloads)
  const store = storeApp()
  const [downloads, setDownloads] = useState<DownloadItem[] | null | 'none'>(null)
  useEffect(() => {
    let live = true
    // signed-in people only (the session cookie goes along); a server with no installers answers 404
    fetch('/downloads/index.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(async (r) => (r.ok ? offeredDownloads(parseDownloads(await r.json()), store) : []))
      .then((d) => live && setDownloads(d.length ? orderDownloads(d, p) : 'none'), () => live && setDownloads('none'))
    return () => {
      live = false
    }
  }, [])
  return (
    <>
      {/* the desktop app and the phone app are already apps: no install guide there */}
      {installGuideShown() && (
        <Section title={t('apps.installTitle')} desc={t('apps.installDesc')}>
          <InstallGuide />
        </Section>
      )}
      <Section title={t('apps.desktopTitle')} desc={t('apps.desktopDesc')}>
        <DesktopDownloads downloads={downloads} store={store} owner={me.user.role === 'owner'} here={p}
          server={downloadsSourceOf(me.server)} />
      </Section>
    </>
  )
}

/** Where the team server's installers come from, for the owner's empty state: an office Mac (`teamax desktop add`), a
 * Linux server that takes the Windows app from the release feed by itself (GET /api/me server.windowsApp 'feed') or
 * one without a feed ('folder': desktop-refresh --from), a hosted tenant that takes it from the feed ('hosted-feed':
 * nothing to run, Diagnostics says why when it is missing) or one that does not ('hosted'). */
export type DownloadsSource = 'office' | 'feed' | 'folder' | 'hosted' | 'hosted-feed'
export const downloadsSourceOf = (server: Pick<Me['server'], 'deployment' | 'windowsApp'>): DownloadsSource =>
  server.deployment === 'hosted' ? (server.windowsApp === 'feed' ? 'hosted-feed' : 'hosted') : server.windowsApp ?? 'office'
const OWNER_HINT: Record<DownloadsSource, MessageKey | null> = { office: 'apps.noDownloadsOwner', feed: 'apps.noDownloadsOwnerFeed', folder: 'apps.noDownloadsOwnerLinux', hosted: null, 'hosted-feed': 'apps.noDownloadsOwnerHosted' }
const FEED_HOST = (() => { try { return new URL(RELEASE_CHANNEL.feed).host } catch { return RELEASE_CHANNEL.feed } })()

/** The installers under Settings > Apps > Desktop app (exported for tests). Inside a Mac App Store build only the App
 * Store line: no installer, no install steps, and not the empty state either (it asks for an installer and tells the
 * owner how to add the .dmg). */
export function DesktopDownloads({ downloads, store, owner, here, server = 'office' }: { downloads: DownloadItem[] | null | 'none'; store: boolean; owner: boolean; here: Platform; server?: DownloadsSource }) {
  const t = useT()
  const locale = useLocale()
  if (store) return <p className="text-sm text-muted">{t('apps.macStore')}</p>
  return (
    <>
      {downloads === null && <Skeleton lines={2} />}
      {downloads === 'none' && (
        <>
          <p className="text-sm text-muted">{t(!owner ? 'apps.noDownloads' : server === 'feed' || server === 'hosted-feed' ? 'apps.noDownloadsFeed' : 'apps.noDownloadsYet')}</p>
          {owner && OWNER_HINT[server] && <p className="mt-2 text-xs text-muted">{t(OWNER_HINT[server]!, { feed: FEED_HOST })}</p>}
        </>
      )}
      {Array.isArray(downloads) && (
        <ul className="space-y-4">
          {downloads.map((d) => (
            <li key={d.file}>
              <a href={`/downloads/${encodeURIComponent(d.file)}`} download className="inline-flex items-center gap-2 rounded-lg border border-field-border px-3 py-2 text-sm hover:bg-hover">
                <Download size={15} aria-hidden /> {t(d.platform === 'mac' ? 'apps.mac' : 'apps.windows')} · v{d.version}
                {d.size ? ` · ${formatSize(d.size, locale)}` : ''}
              </a>
              {d.platform === here && <Badge tone="accent" className="ml-2">{t('apps.thisComputer')}</Badge>}
              {archNote(d) && <Badge tone="warn" className="ml-2">{t(archNote(d)!)}</Badge>}
              {showSteps(downloads, d) && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
                  {installSteps(d).map((k) => (
                    <li key={k} className={k === 'apps.winSmartScreen' || k === 'apps.macGatekeeper' ? 'text-warn' : undefined}>{t(k)}</li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
