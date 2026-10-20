// Personal settings: profile, language and theme, password, signed-in devices, what the AI remembers, apps
// (install as an app / desktop app download). There is no screen for connecting a personal AI account: the owner
// connects the engines once in the admin screens.
import clsx from 'clsx'
import { Brain, Download, Laptop, Monitor, Smartphone, Trash2, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router-dom'
import type { Locale, Memory, Session, Theme } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatDateTime, formatSize } from '../lib/format'
import { isStandalone, platform, useInstallPrompt } from '../lib/pwa'
import { LOCALES, useLocale, useT, type MessageKey } from '../i18n'
import { memoryChanged } from '../store/live'
import { useMeStrict, useSession } from '../store/session'
import { toast } from '../store/ui'
import { ChangePasswordForm } from './Auth'
import { Badge, Button, EmptyState, ErrorNote, Field, PageHeader, Skeleton, confirmDialog, inputCls } from '../components/ui'

const TABS: { id: string; label: MessageKey; icon: typeof User }[] = [
  { id: 'profile', label: 'settings.profile', icon: User },
  { id: 'security', label: 'settings.security', icon: Laptop },
  { id: 'memory', label: 'settings.memory', icon: Brain },
  { id: 'apps', label: 'settings.apps', icon: Download },
]

export default function Settings() {
  const t = useT()
  const { tab = 'profile' } = useParams()
  // an old or mistyped link (/settings/devices) would show an empty page: open the profile instead
  if (!TABS.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('settings.title')} />
      <div className="flex flex-col gap-6 p-4 sm:p-6 md:flex-row">
        <nav aria-label={t('settings.title')} className="flex gap-1 overflow-x-auto md:w-48 md:flex-col">
          {TABS.map((x) => (
            <NavLink key={x.id} to={`/settings/${x.id}`} className={({ isActive }) => clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:bg-hover', (isActive || (x.id === 'profile' && tab === 'profile')) && 'bg-hover font-medium')}>
              <x.icon size={15} aria-hidden /> {t(x.label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1 max-w-2xl">
          {tab === 'profile' && <Profile />}
          {tab === 'security' && <Security />}
          {tab === 'memory' && <Memories />}
          {tab === 'apps' && <Apps />}
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
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={locale === l.id}
              onClick={() => void setLocale(l.id as Locale).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))}
              className={clsx('rounded-lg border px-3 py-2 text-sm', locale === l.id ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}
              data-testid={`locale-${l.id}`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Section>
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
  return (
    <>
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

interface DownloadItem { platform: 'mac' | 'windows'; file: string; version: string; size?: number; signed?: boolean }

function Apps() {
  const t = useT()
  const locale = useLocale()
  const install = useInstallPrompt()
  const p = platform()
  const [downloads, setDownloads] = useState<DownloadItem[] | null | 'none'>(null)
  useEffect(() => {
    let live = true
    fetch('/downloads/index.json', { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? ((await r.json()) as { items?: DownloadItem[] }).items ?? [] : 'none'))
      .then((d) => live && setDownloads(d === 'none' || !d.length ? 'none' : d), () => live && setDownloads('none'))
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
        {downloads === 'none' && <p className="text-sm text-muted">{t('apps.noDownloads')}</p>}
        {Array.isArray(downloads) && (
          <ul className="space-y-2">
            {downloads.map((d) => (
              <li key={d.file}>
                <a href={`/downloads/${encodeURIComponent(d.file)}`} download className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-hover">
                  <Download size={15} aria-hidden /> {t(d.platform === 'mac' ? 'apps.mac' : 'apps.windows')} · v{d.version}
                  {d.size ? ` · ${formatSize(d.size, locale)}` : ''}
                </a>
                {d.platform === 'windows' && d.signed === false && <p className="mt-1 text-xs text-warn">{t('apps.unsigned')}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
