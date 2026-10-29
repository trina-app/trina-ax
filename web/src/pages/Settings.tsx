// Personal settings: profile, language and theme, password, signed-in devices, the in-app browser's site setting (desktop
// app only: BrowserSettings.tsx), what the AI remembers, scheduled tasks, apps (install as an app / desktop app download),
// about (version, license, source code), the member's own AI connections when the team allows them (the team's
// connections are made by the owner in Admin > AI connections), and the external services the AI may use with the
// member's own accounts (Integrations.tsx).
import clsx from 'clsx'
import { Brain, CalendarClock, Download, Laptop, Monitor, ShieldAlert, Smartphone, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router-dom'
import type { EngineId, Memory, Schedule, Session, Theme } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { archNote, installSteps, orderDownloads, parseDownloads, showSteps, type DownloadItem } from '../lib/downloads'
import { isStandalone, platform, useInstallPrompt } from '../lib/pwa'
import { LOCALES, useLocale, useT, type MessageKey } from '../i18n'
import { memoryChanged } from '../store/live'
import { canChooseEngine, useMeStrict, useSession } from '../store/session'
import { useEngines } from '../store/engines'
import { ENGINE_LABEL } from '../components/chat/EngineMenu'
import { toast } from '../store/ui'
import { ChangePasswordForm } from './Auth'
import { MyCredentials } from './admin/Credentials'
import { BrowserSettings } from './BrowserSettings'
import { settingsTabs } from './settingsTabs'
import { browserSettingsBridge } from '../lib/desktop'
import { Badge, Button, EmptyState, ErrorNote, Field, PageHeader, Skeleton, confirmDialog, inputCls } from '../components/ui'
import { SourceCodeLinks, useServerSource } from '../components/SourceCodeLink'
import { DriveConnection } from '../components/settings/DriveConnection'
import { ScheduleTemplates } from '../components/settings/ScheduleTemplates'
import { Notifications } from '../components/settings/Notifications'
import { ScheduleItem } from '../components/settings/ScheduleItem'
import ConnectorConnections from './ConnectorConnections'
import Integrations from './Integrations'

export default function Settings() {
  const t = useT()
  const me = useMeStrict()
  const { tab = 'profile' } = useParams()
  const [own, setOwn] = useState<boolean | null>(null)
  useEffect(() => {
    api.call(API.myCredentials).then((r) => setOwn(r.allowed || r.items.length > 0), () => setOwn(false))
  }, [])
  // the desktop app's site setting: only inside a desktop app that offers it (the value lives there)
  const browser = browserSettingsBridge()
  const tabs = settingsTabs(Boolean(browser), Boolean(own))
  // an old or mistyped link (/settings/devices), or /settings/browser outside the desktop app, would show an empty
  // page: open the profile instead
  if (tab === 'credentials' && own === null) return null
  if (!tabs.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('settings.title')} />
      <div className="flex flex-col gap-6 p-4 sm:p-6 md:flex-row">
        {/* phones: the tab strip runs to the screen edges, so a tab cut off at the right reads as "scroll for more" */}
        <nav aria-label={t('settings.title')} className="scroll-thin -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:w-48 md:flex-col md:px-0">
          {tabs.map((x) => (
            <NavLink key={x.id} to={`/settings/${x.id}`} className={({ isActive }) => clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:bg-hover', (isActive || (x.id === 'profile' && tab === 'profile')) && 'bg-hover font-medium')}>
              <x.icon size={15} aria-hidden /> {t(x.label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1 max-w-2xl">
          {tab === 'profile' && <Profile />}
          {tab === 'security' && <Security />}
          {tab === 'browser' && browser && <BrowserSettings bridge={browser} />}
          {tab === 'memory' && <Memories />}
          {tab === 'drive' && <DriveConnection key={`${me.user.id}:${me.session.id}`} />}
          {tab === 'integrations' && <Integrations key={`${me.user.id}:${me.session.id}`} />}
          {tab === 'connectors' && <ConnectorConnections key={`${me.user.id}:${me.session.id}`} />}
          {tab === 'schedules' && <Schedules key={`${me.user.id}:${me.session.id}`} />}
          {tab === 'notifications' && <Notifications key={`${me.user.id}:${me.session.id}`} />}
          {tab === 'apps' && <Apps />}
          {tab === 'credentials' && <MyCredentials />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
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

function Profile() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const signedIn = useSession((s) => s.signedIn)
  const setLocale = useSession((s) => s.setLocale)
  const setTheme = useSession((s) => s.setTheme)
  const [name, setName] = useState(me.user.name)
  const [email, setEmail] = useState(me.user.email ?? '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
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
        <div className="space-y-3">
          <Field label={t('auth.name')}>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label={t('settings.email')} hint={t('settings.emailHint')}>
            <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('auth.username')}>
            <input className={inputCls} value={me.user.username} disabled />
          </Field>
          <p className="text-xs text-faint">
            {t('settings.role')}: <Badge>{t(`role.${me.user.role}`)}</Badge> · {me.groups.map((g) => g.name).join(', ') || t('settings.noGroups')}
          </p>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={save}>
            {t('common.save')}
          </Button>
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
                  <span className="block truncate">{s.userAgent ?? t(`client.${s.client}`)}</span>
                  <span className="block text-xs text-faint">{t('settings.lastSeen', { date: formatDateTime(s.lastSeenAt, locale) })}</span>
                </span>
                {s.current ? (
                  <Badge tone="accent">{t('settings.thisDevice')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
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

function Schedules() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<Schedule[] | null>(null)
  const [tz, setTz] = useState('')
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), revision = useRef(0)
  const load = async () => {
    const generation = life.current, rev = ++revision.current
    try {
      const r = await api.call(API.listSchedules)
      if (generation !== life.current || rev !== revision.current) return
      setItems(r.items)
      setTz(r.timeZone)
      setError(null)
    } catch (e) {
      if (generation === life.current && rev === revision.current) setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    life.current++
    void load()
    return () => { life.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const weekday = (n: number) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))
  const when = (s: Schedule) => t(`schedules.repeat.${s.repeat}` as MessageKey, { time: s.time, date: s.date ?? '', day: String(s.day ?? ''), weekday: weekday(s.weekday ?? 0) })
  const toggle = async (s: Schedule) => {
    const generation = life.current
    try {
      const u = await api.call(API.updateSchedule, { params: { id: s.id }, body: { enabled: !s.enabled } })
      if (generation !== life.current) return
      revision.current++
      setItems((cur) => cur?.map((x) => (x.id === s.id ? u : x)) ?? null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const remove = async (s: Schedule) => {
    const generation = life.current
    if (!(await confirmDialog({ title: t('schedules.deleteTitle'), body: t('schedules.deleteBody', { title: s.title }), confirm: t('schedules.delete'), danger: true }))) return
    if (generation !== life.current) return
    try {
      await api.call(API.deleteSchedule, { params: { id: s.id } })
      if (generation !== life.current) return
      revision.current++
      setItems((cur) => cur?.filter((x) => x.id !== s.id) ?? null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return (
    <Section title={t('settings.schedules')} desc={t('schedules.desc')}>
      <ScheduleTemplates onCreated={schedule => { revision.current++; setItems(current => [schedule, ...(current ?? []).filter(item => item.id !== schedule.id)]) }} />
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={3} />}
      {items && !items.length && <EmptyState icon={<CalendarClock size={26} />} title={t('schedules.empty')} />}
      {items && items.length > 0 && (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="schedule-list">
            {items.map((s) => <ScheduleItem key={s.id} s={s} tz={tz} when={when(s)} onToggle={() => void toggle(s)} onRemove={() => void remove(s)} />)}
          </ul>
          {tz && <p className="mt-2 text-xs text-faint">{t('schedules.timeZone', { tz })}</p>}
        </>
      )}
    </Section>
  )
}

function Memories() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<Memory[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  return (
    <Section title={t('settings.memory')} desc={t('memory.desc')}>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={3} />}
      {items && !items.length && <EmptyState icon={<Brain size={26} />} title={t('memory.empty')} />}
      {items && items.length > 0 && (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="memory-list">
            {items.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-pre-wrap">{m.text}</span>
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
                <button type="button" aria-label={t('memory.forget')} title={t('memory.forget')} className="rounded p-1 text-faint hover:bg-hover hover:text-danger" onClick={() => remove(m)}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            {cursor && (
              <Button size="sm" onClick={() => void load(true)}>
                {t('common.loadMore')}
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={clear}>
              {t('memory.clear')}
            </Button>
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
      <SourceCodeLinks info={info} className="mt-3 inline-block text-sm text-accent-text underline" />
    </Section>
  )
}

function Apps() {
  const t = useT()
  const locale = useLocale()
  const install = useInstallPrompt()
  const p = platform()
  const me = useMeStrict()
  const [downloads, setDownloads] = useState<DownloadItem[] | null | 'none'>(null)
  useEffect(() => {
    let live = true
    // signed-in people only (the session cookie goes along); a server with no installers answers 404
    fetch('/downloads/index.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(async (r) => (r.ok ? parseDownloads(await r.json()) : []))
      .then((d) => live && setDownloads(d.length ? orderDownloads(d, p) : 'none'), () => live && setDownloads('none'))
    return () => {
      live = false
    }
  }, [])
  return (
    <>
      <Section title={t('apps.installTitle')} desc={t('apps.installDesc')}>
        {isStandalone() ? (
          <p className="text-sm text-ok">{t('apps.installed')}</p>
        ) : install.canPrompt ? (
          <Button variant="primary" onClick={() => void install.prompt()}>
            {t('apps.install')}
          </Button>
        ) : (
          <p className="text-sm text-muted">{t(p === 'ios' ? 'apps.howIos' : p === 'android' ? 'apps.howAndroid' : 'apps.howDesktop')}</p>
        )}
      </Section>
      <Section title={t('apps.desktopTitle')} desc={t('apps.desktopDesc')}>
        {downloads === null && <Skeleton lines={2} />}
        {downloads === 'none' && (
          <>
            <p className="text-sm text-muted">{t(me.user.role === 'owner' ? 'apps.noDownloadsYet' : 'apps.noDownloads')}</p>
            {me.user.role === 'owner' && <p className="mt-2 text-xs text-muted">{t('apps.noDownloadsOwner')}</p>}
          </>
        )}
        {Array.isArray(downloads) && (
          <ul className="space-y-4">
            {downloads.map((d) => (
              <li key={d.file}>
                <a href={`/downloads/${encodeURIComponent(d.file)}`} download className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-hover">
                  <Download size={15} aria-hidden /> {t(d.platform === 'mac' ? 'apps.mac' : 'apps.windows')} · v{d.version}
                  {d.size ? ` · ${formatSize(d.size, locale)}` : ''}
                </a>
                {d.platform === p && <Badge tone="accent" className="ml-2">{t('apps.thisComputer')}</Badge>}
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
      </Section>
    </>
  )
}
