// The sections of the personal Settings dialog (components/settings/SettingsDialog.tsx): profile, language, theme and text size, password, signed-in devices, the sites the AI can open (the
// desktop app's in-app browser, and "Allow all websites" for the AI's web reads when the team allows it: BrowserSettings.tsx), what the AI remembers, what I allowed the AI in advance (AiAllowances.tsx), apps (the
// team address, every phone and desktop app with one way to get it, components/settings/AppList.tsx, and in a web browser
// only the guide to install the page as an app, components/settings/InstallGuide.tsx),
// about (version, license, source code), the member's own AI connections when the team allows them (the team's
// connections are made by the owner in Admin > AI connections). Connectors is its own page now (pages/Connectors.tsx;
// its section here leads there). Profile ends with "계정 삭제 요청", its own page under the profile
// (/settings/account/delete, components/settings/AccountDeletion.tsx).
// Phones (below 768 px; docs/AGENTS/plan/20261111-1748-phone-settings-rows.md): rows and switches like the iPhone's
// Settings, not a web page's buttons. Language and theme are checkmark lists; Security & devices is two rows that open
// pages under it (the password form, every signed-in device); Memory has its "+" in the bar, a row opens its edit sheet
// (forgetting one asks first) and "Forget all" is a red row; 트리나에게 허용한 것 also holds Browser and Dev environment
// sites (`fold`); Apps in the phone app sends the Apps page to a computer instead of offering Mac and Windows files.
import clsx from 'clsx'
import { Brain, KeyRound, Laptop, LogOut, Monitor, Pencil, Plus, Send, ShieldAlert, Smartphone, Tablet, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EngineId, Memory, Session, TextSize, Theme } from '@mycel/shared/api'
import { APP_DOWNLOADS, PROFILE_TITLE_MAX } from '@mycel/shared'
import { api, API, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { deviceKind, deviceLabel } from '../lib/userAgent'
import { offeredDownloads, parseDownloads, type DownloadItem } from '../lib/downloads'
import { phoneApps, type AppClient } from '../lib/apps'
import { browser, canInstallIn, installGuideShown, isStandalone, platform } from '../lib/pwa'
import { LOCALES, useLocale, useT } from '../i18n'
import { memoryChanged } from '../store/live'
import { canChooseEngine, useMeStrict, useSession } from '../store/session'
import { useEngines } from '../store/engines'
import { ENGINE_LABEL } from '../components/chat/EngineMenu'
import { toast } from '../store/ui'
import { ChangePasswordForm } from './Auth'
import { MyCredentials } from './admin/Credentials'
import { BrowserSettings } from './BrowserSettings'
import { browserTabShown } from './settingsTabs'
import { browserSettingsBridge, clientKind, desktop, storeApp } from '../lib/desktop'
import { mobileApp } from '../lib/mobile'
import { pickTextSize, TEXT_SIZE_PERCENT, TEXT_SIZES, useTextSize } from '../lib/textSize'
import { teamAddressHost } from '../lib/team-address'
import { Badge, Button, CopyButton, EmptyState, Field, IconButton, Modal, PhoneTargets, Skeleton, confirmDialog, inputCls, noKeyRepeat, useCopy, useMediaQuery } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { SourceCodeLinks, useServerSource } from '../components/SourceCodeLink'
import { Avatar } from '../components/Avatar'
import { squarePhoto, type Photo } from '../lib/avatar'
import { Notifications } from '../components/settings/Notifications'
import { DevEnvSites } from '../components/settings/DevEnvSites'
import { AiAllowances } from '../components/settings/AiAllowances'
import { AccountDeletion } from '../components/settings/AccountDeletion'
import { InstallGuide } from '../components/settings/InstallGuide'
import { ComputerApps, PhoneApps, downloadsSourceOf } from '../components/settings/AppList'
import { MemoryForm } from '../components/settings/MemoryForm'
import AiApps from './AiApps'
import { PhoneListGroup, PhoneListRow } from '../components/phone/PhoneList'
import { PhoneChecks } from '../components/phone/PhoneChecks'
import { SettingsBarAction } from '../components/settings/SettingsBar'
import { useGoBack } from '../lib/back'
import MyUsage from '../components/settings/MyUsage'

/** What a phone's 트리나에게 허용한 것 holds besides its own list: the Browser and Dev environment sites sections, each
 * while the dialog shows it (SettingsDialog.tsx PHONE_FOLDED). */
export interface SettingsFold { browser: boolean; devEnvSites: boolean }

/** One section of the Settings dialog (components/settings/SettingsDialog.tsx, which owns the list, the address and
 * which sections there are): `tab` is one of settingsTabs(), or a page under a section ('account-delete' under the
 * profile, 'security-password' and 'security-devices' under 보안·기기). */
export default function SettingsPane({ tab, fold }: { tab: string; fold?: SettingsFold }) {
  const me = useMeStrict()
  const browser = browserSettingsBridge()
  // the form-like sections: 44 px buttons on a phone (components/ui.tsx PhoneTargets); the list-like ones are their own
  return (
    <PhoneTargets.Provider value={FORM_TABS.has(tab)}>
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'security-password' && <PasswordPage />}
      {tab === 'security-devices' && <Security all />}
      {tab === 'usage' && <MyUsage key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'browser' && browserTabShown(Boolean(browser), me.team.webAllowAll) && <BrowserSettings bridge={browser} />}
      {tab === 'memory' && <Memories />}
      {tab === 'allowances' && <AiAllowances key={`${me.user.id}:${me.session.id}`} folded={!!fold} />}
      {/* a phone: the sites the AI may open are parts of this page (Settings' list has no rows of their own for them) */}
      {tab === 'allowances' && fold?.browser && <BrowserSettings bridge={browser} part />}
      {tab === 'allowances' && fold?.devEnvSites && <DevEnvSites key={`dev-env:${me.user.id}:${me.session.id}`} part />}
      {tab === 'ai-apps' && <AiApps key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'dev-env-sites' && <DevEnvSites key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'notifications' && <Notifications key={`${me.user.id}:${me.session.id}`} />}
      {tab === 'apps' && <Apps />}
      {tab === 'providers' && <MyCredentials />}
      {tab === 'about' && <About />}
      {tab === 'account-delete' && <AccountDeletion key={`${me.user.id}:${me.session.id}`} />}
    </PhoneTargets.Provider>
  )
}

const FORM_TABS = new Set(['profile', 'security', 'security-password', 'security-devices', 'browser', 'memory', 'allowances', 'notifications', 'about', 'account-delete'])

/** `page`: the title is the section's own name, which a phone's bar already shows (SettingsDialog.tsx): there it is
 * kept for screen readers only. */
function Section({ title, children, desc, page }: { title: string; children: React.ReactNode; desc?: string; page?: boolean }) {
  return (
    <section className="mb-8">
      <h2 className={clsx('mb-1 text-base font-semibold', page && 'max-md:sr-only')}>{title}</h2>
      {desc && <p className="mb-3 text-sm text-muted">{desc}</p>}
      <div className={clsx(!desc && 'mt-3', !desc && page && 'max-md:mt-0')}>{children}</div>
    </section>
  )
}

/** One setting, like Claude's Settings: what it is on the left, its control on the right, a hairline between rows (below
 * 768 px the control goes under its name). `framed`: a field with its own frame (the profile form's), which needs no
 * hairline under it on a phone. `quietHint`: on a phone the hint is for screen readers only (an error still shows).
 * `value`: a value to read, not a control (the username): it stays on the right on a phone too. */
function Row({ label, hint, htmlFor, hintId, hintError, framed, quietHint, value, children }: { label: string; hint?: string; htmlFor?: string; hintId?: string; hintError?: boolean; framed?: boolean; quietHint?: boolean; value?: boolean; children: React.ReactNode }) {
  return (
    <div className={clsx('flex border-b border-line py-3 last:border-b-0 md:flex-row md:items-center md:justify-between md:gap-6', value ? 'items-start justify-between gap-4' : 'flex-col gap-2', framed && 'max-md:border-b-0')}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm text-ink">
            {label}
          </label>
        ) : (
          <p className="text-sm text-ink">{label}</p>
        )}
        {hint && (
          <p id={hintId} className={clsx('mt-0.5 text-xs', hintError ? 'text-danger' : 'text-muted', quietHint && !hintError && 'max-md:sr-only')} role={hintError ? 'alert' : undefined}>
            {hint}
          </p>
        )}
      </div>
      <div className={clsx('min-w-0 md:w-72 md:max-w-[60%] md:shrink-0', value && 'max-md:max-w-[60%] max-md:text-right')}>{children}</div>
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
  const [title, setTitle] = useState(me.user.title ?? '')
  const [email, setEmail] = useState(me.user.email ?? '')
  // the photo: untouched (null), a new one waiting for Save, or taken away (also waiting for Save)
  const [photo, setPhoto] = useState<Photo | 'remove' | null>(null)
  const [photoNote, setPhotoNote] = useState<string | null>(null)
  const pick = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const previewUrl = photo && photo !== 'remove' ? photo.url : null
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])
  // Everything here is saved with the one Save button (the other tabs' settings save at once): it shows once something
  // changed
  // the one-line status is no longer asked for here (kept on the account, shown nowhere)
  const profileChanged = name.trim() !== me.user.name || title.trim() !== (me.user.title ?? '')
  const changed = profileChanged || (email.trim() || null) !== (me.user.email ?? null) || photo !== null
  const hasPhoto = photo === 'remove' ? false : !!(photo || me.user.avatarVersion)
  const choose = async (file: File | undefined) => {
    if (!file) return
    setPhotoNote(null)
    const p = await squarePhoto(file)
    if (!p) return setPhotoNote(t('profile.photoProblem'))
    setPhoto(p)
  }
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!changed || !name.trim() || busy) return
    setBusy(true)
    try {
      if (profileChanged) await api.call(API.updateMyProfile, { body: { name: name.trim(), title: title.trim() } })
      if (photo === 'remove') await api.call(API.deleteMyAvatar)
      else if (photo) await api.call(API.putMyAvatar, { query: { type: photo.type }, body: photo.blob })
      // the email is the one field of the older call
      if ((email.trim() || null) !== (me.user.email ?? null)) signedIn(await api.call(API.updateMe, { body: { email: email.trim() || null } }))
      else signedIn(await api.call(API.me))
      setPhoto(null)
      toast({ level: 'success', text: t('common.saved') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  const theme = me.user.prefs.theme ?? 'system'
  const phone = useMediaQuery('(max-width: 767.98px)')
  return (
    <>
      <Section title={t('settings.profile')} page>
        {/* noValidate: the server checks the email and its answer shows in the app's own style, not a browser popup */}
        <form onSubmit={save} noValidate data-testid="profile-form">
          <Row label={t('profile.photo')} hint={photoNote ?? t('profile.photoHint')} hintId={`${ids}-photo-hint`} hintError={!!photoNote} framed quietHint>
            <div className="flex items-center gap-3">
              {previewUrl ? (
                <img src={previewUrl} alt="" width={56} height={56} className="size-14 shrink-0 rounded-full object-cover" data-testid="profile-photo-preview" />
              ) : (
                <Avatar user={{ id: me.user.id, name, avatarVersion: photo === 'remove' ? undefined : me.user.avatarVersion }} size={56} />
              )}
              <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
                <Button type="button" size="sm" onClick={() => pick.current?.click()} aria-describedby={`${ids}-photo-hint`} data-testid="profile-photo-pick">
                  {hasPhoto ? t('profile.photoChange') : t('profile.photoChoose')}
                </Button>
                {hasPhoto && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setPhotoNote(null); setPhoto(me.user.avatarVersion && photo !== 'remove' ? 'remove' : null) }} data-testid="profile-photo-remove">
                    {t('profile.photoRemove')}
                  </Button>
                )}
              </div>
              <input ref={pick} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" tabIndex={-1} aria-hidden data-testid="profile-photo-input" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = '' }} />
            </div>
          </Row>
          <Row label={t('auth.name')} htmlFor={`${ids}-name`} framed>
            <input id={`${ids}-name`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Row>
          <Row label={t('profile.title')} htmlFor={`${ids}-title`} framed>
            <input id={`${ids}-title`} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={PROFILE_TITLE_MAX} placeholder={t('profile.titleHint')} />
          </Row>
          <Row label={t('settings.email')} hint={t('settings.emailHint')} htmlFor={`${ids}-email`} hintId={`${ids}-email-hint`} framed>
            <input id={`${ids}-email`} className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby={`${ids}-email-hint`} />
          </Row>
          <p className="pt-3 text-xs text-muted">{t('profile.visible')}</p>
          {changed && (
            <div className="flex justify-end pt-3 max-sm:[&>button]:w-full">
              <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()} data-testid="profile-save">
                {t('common.save')}
              </Button>
            </div>
          )}
        </form>
        <div className="mt-2">
          <Row label={t('auth.username')} value>
            <span className="block truncate text-sm text-muted md:text-right" data-testid="profile-username">
              {me.user.username}
            </span>
          </Row>
          <Row label={t('settings.role')} value>
            {/* phones: the role in words, not a badge */}
            {phone ? (
              <span className="block text-sm text-muted md:text-right">
                {t(`role.${me.user.role}`)} · {me.groups.map((g) => g.name).join(', ') || t('settings.noGroups')}
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted md:justify-end">
                <Badge>{t(`role.${me.user.role}`)}</Badge> · {me.groups.map((g) => g.name).join(', ') || t('settings.noGroups')}
              </span>
            )}
          </Row>
          {/* the team owner and the admins delete accounts: this asks them (App Store review 5.1.1(v)) */}
          <Row label={t('accountDeletion.row')} hint={t('accountDeletion.rowHint')}>
            <Link to="/settings/account/delete" className="block text-sm text-accent-text underline-offset-2 hover:underline max-md:flex max-md:min-h-11 max-md:items-center md:text-right" data-testid="account-deletion-link">
              {t('accountDeletion.title')}
            </Link>
          </Row>
        </div>
      </Section>
      {phone ? (
        // a phone: the language as a checkmark list (the team's default first)
        <PhoneSection className="-mt-6" testId="profile-language-part">
          <PhoneChecks title={t('settings.language')} footer={t('settings.languageHint')} label={t('settings.language')} testId="profile-language"
            value={me.user.localeChoice ?? 'team'}
            options={(['team', ...LOCALES.map((l) => l.id)] as const).map((choice) => ({
              value: choice,
              label: choice === 'team' ? t('settings.languageTeam', { language: LOCALES.find((l) => l.id === me.team.defaultLocale)?.label ?? me.team.defaultLocale }) : LOCALES.find((l) => l.id === choice)!.label,
              lang: choice === 'team' ? undefined : choice,
              testId: `locale-${choice}`,
            }))}
            onChange={(choice) => void setLocale(choice === 'team' ? null : choice).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))} />
        </PhoneSection>
      ) : (
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
                className={clsx('rounded-lg border px-3 py-2 text-sm max-md:min-h-11', checked ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}
                data-testid={`locale-${choice ?? 'team'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </Section>
      )}
      {canChooseEngine(me) && <MyEngine />}
      {/* a phone: the theme as a checkmark list (its saving is the same setTheme as the buttons') */}
      {phone && <PhoneTheme theme={theme} />}
      {!phone && (
      <Section title={t('settings.theme')}>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.theme')}>
          {(['system', 'light', 'dark'] as Theme[]).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={theme === x} onClick={() => void setTheme(x).catch(() => {})} className={clsx('rounded-lg border px-3 py-2 text-sm max-md:min-h-11', theme === x ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}>
              {t(`settings.theme.${x}`)}
            </button>
          ))}
        </div>
      </Section>
      )}
      <TextSizeSetting />
    </>
  )
}

/** A phone's part of a section in the phone list look (phone/PhoneList.tsx): from edge to edge of the screen, its first
 * group where the section starts. */
function PhoneSection({ children, testId, className }: { children: React.ReactNode; testId?: string; className?: string }) {
  return <div className={clsx('-mx-4 mb-8', className)} data-testid={testId}>{children}</div>
}

/** 테마 on a phone: a checkmark list. Picking one is the theme buttons' setTheme. */
function PhoneTheme({ theme }: { theme: Theme }) {
  const t = useT()
  const locale = useLocale()
  const setTheme = useSession((s) => s.setTheme)
  return (
    <PhoneSection className="-mt-6">
      <PhoneChecks title={t('settings.theme')} label={t('settings.theme')} testId="profile-theme" value={theme}
        options={(['system', 'light', 'dark'] as Theme[]).map((x) => ({ value: x, label: t(`settings.theme.${x}`), testId: `theme-${x}` }))}
        onChange={(x) => void setTheme(x).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))} />
    </PhoneSection>
  )
}

/** 글자 크기, like a phone's Text Size: a slider from a small to a large letter, five steps (lib/textSize.ts). The line
 * under it reads at the chosen size. The whole app takes the size when the slider is let go, or at once with the keyboard
 * or a tap (its change event): taking it during a drag would move the slider under the pointer. 기본 is the way back (no
 * reset button). Saved to the account a moment after the last change, so a few quick steps are one save. */
function TextSizeSetting() {
  const t = useT()
  const locale = useLocale()
  const setTextSize = useSession((s) => s.setTextSize)
  // what the app uses (also when the account's size arrives while this is open), and what the slider points at
  const applied = useTextSize()
  const [size, setSize] = useState<TextSize>(applied)
  useEffect(() => setSize(applied), [applied])
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef<{ size: TextSize; timer: ReturnType<typeof setTimeout> } | null>(null)
  const save = (s: TextSize) => void setTextSize(s).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  const commit = (s: TextSize) => {
    setSize(s)
    pickTextSize(s)
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = { size: s, timer: setTimeout(() => { pending.current = null; save(s) }, 400) }
  }
  const latest = useRef(commit)
  latest.current = commit
  useEffect(() => {
    const el = input.current
    const onChange = () => latest.current(TEXT_SIZES[Number(el?.value)] ?? 'default')
    el?.addEventListener('change', onChange)
    return () => {
      el?.removeEventListener('change', onChange)
      // closing Settings right after a change still saves it
      const p = pending.current
      if (p) { clearTimeout(p.timer); save(p.size) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ticks = useId()
  const glyph = t('settings.textSize.glyph')
  // during a drag the line under the slider shows the size it points at
  const ratio = TEXT_SIZE_PERCENT[size] / TEXT_SIZE_PERCENT[applied]
  return (
    <Section title={t('settings.textSize')}>
      <div className="flex max-w-md items-center gap-3">
        <span aria-hidden className="w-6 shrink-0 text-center text-xs text-muted">{glyph}</span>
        <input
          ref={input}
          type="range"
          min={0}
          max={TEXT_SIZES.length - 1}
          step={1}
          value={TEXT_SIZES.indexOf(size)}
          onChange={(e) => setSize(TEXT_SIZES[Number(e.target.value)] ?? 'default')}
          // a touch that turned into a scroll ends with no change event: the slider goes back to the size in use
          onPointerCancel={() => setSize(applied)}
          list={ticks}
          aria-label={t('settings.textSize')}
          aria-valuetext={t(`settings.textSize.${size}`)}
          className="h-8 min-w-0 flex-1 cursor-pointer accent-accent"
          data-testid="text-size"
        />
        <datalist id={ticks}>
          {TEXT_SIZES.map((x, i) => <option key={x} value={i} />)}
        </datalist>
        <span aria-hidden className="w-6 shrink-0 text-center text-xl text-muted">{glyph}</span>
      </div>
      <p
        className="mt-2 text-reading leading-reading"
        style={ratio === 1 ? undefined : { fontSize: `calc(var(--text-reading) * ${ratio})`, lineHeight: `calc(var(--leading-reading) * ${ratio})` }}
        data-testid="text-size-sample"
      >
        <span className="font-medium">{t(`settings.textSize.${size}`)}</span>
        <span className="text-muted"> · {t('settings.textSize.sample')}</span>
      </p>
    </Section>
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

/** A signed-in device's icon, from what its user agent says it is (Safari on an iPhone is a phone, not a monitor). */
const DEVICE_ICON = { phone: Smartphone, tablet: Tablet, laptop: Laptop, computer: Monitor } as const

/** 보안·기기. A computer: the password form and every device, as before. A phone: "Change password" and the devices as
 * rows: this device, then one row with the others that opens them all (`all`: that page, /settings/security/devices,
 * where a tap on a device asks before it is signed out). */
function Security({ all = false }: { all?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [sessions, setSessions] = useState<Session[] | null>(null)
  // what the read threw, kept until a read works (components/LoadError.tsx)
  const [error, setError] = useState<unknown>(null)
  const load = async () => {
    try {
      setSessions((await api.call(API.mySessions)).items)
      setError(null)
    } catch (e) {
      setError(e ?? new Error('failed'))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // tab 5: a reset by an admin (or the owner's recovery on the server Mac) stays visible here, so the person learns of it
  const reset = useMeStrict().passwordReset
  const phone = useMediaQuery('(max-width: 767.98px)')
  const name = (s: Session) => deviceLabel(s.client, s.userAgent, t)
  const signOut = async (s: Session) => {
    try {
      await api.call(API.revokeMySession, { params: { id: s.id } })
      void load()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  // a phone: a tap is easily made by mistake there, so a question before the device is signed out
  const askSignOut = async (s: Session) => {
    if (await confirmDialog({ title: t('settings.signOutDeviceConfirm', { device: name(s) }), body: t('settings.signOutDeviceConfirmBody'), confirm: t('settings.signOutDevice'), danger: true })) void signOut(s)
  }
  const current = sessions?.filter((x) => x.current) ?? []
  const others = sessions?.filter((x) => !x.current) ?? []
  const resetLine = reset && (
    <p className="mb-6 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="last-reset">
      <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{reset.by ? t('settings.lastReset', { name: reset.by.name, date: formatDateTime(reset.at, locale) }) : t('settings.lastResetRecovery', { date: formatDateTime(reset.at, locale) })}</span>
    </p>
  )
  const loading = (
    <>
      {!!error && <LoadError error={error} onRetry={load} what="settings-devices" />}
      {!sessions && !error && <Skeleton lines={3} />}
    </>
  )
  if (phone) {
    // one device as a row: its icon, its name and when it was last used; `onSignOut`: a tap asks to sign it out
    const deviceRow = (s: Session, onSignOut?: () => void) => {
      const Icon = DEVICE_ICON[deviceKind(s.client, s.userAgent)]
      return (
        <PhoneListRow key={s.id} icon={<Icon size={16} />} testId="device-row" onClick={onSignOut}
          ariaLabel={onSignOut ? `${t('settings.signOutDevice')} · ${name(s)}` : undefined}
          title={<span className="block min-w-0"><span className="block truncate" title={s.userAgent ?? undefined} data-testid="device-name">{name(s)}</span><span className="block truncate text-xs text-faint">{t('settings.lastSeen', { date: formatDateTime(s.lastSeenAt, locale) })}</span></span>}
          value={s.current ? t('settings.thisDevice') : undefined}
          end={onSignOut ? <LogOut size={16} className="shrink-0 text-faint" aria-hidden data-testid="device-sign-out" /> : undefined} />
      )
    }
    if (all) return (
      <>
        <h2 className="sr-only">{t('settings.devices')}</h2>
        {loading}
        {sessions && (
          <PhoneSection className="-mt-4" testId="security-devices-page">
            <PhoneListGroup footer={t('settings.devicesHint')} testId="security-devices-all">
              {current.map((s) => deviceRow(s))}
              {others.map((s) => deviceRow(s, () => void askSignOut(s)))}
            </PhoneListGroup>
          </PhoneSection>
        )}
      </>
    )
    return (
      <>
        {resetLine}
        <PhoneSection className="-mt-4" testId="security-phone">
          <PhoneListGroup testId="security-password">
            <PhoneListRow icon={<KeyRound size={16} />} title={t('auth.changePassword')} to="/settings/security/password" testId="password-open" />
          </PhoneListGroup>
          <PhoneListGroup title={t('settings.devices')} labelId="security-devices-title" footer={t('settings.devicesHint')} testId="security-devices">
            {current.map((s) => deviceRow(s))}
            {others.length > 0 && (
              <PhoneListRow icon={<Laptop size={16} />} title={t('settings.devicesOther')} value={String(others.length)} to="/settings/security/devices" testId="devices-more" />
            )}
          </PhoneListGroup>
        </PhoneSection>
        {loading}
      </>
    )
  }
  return (
    <>
      {resetLine}
      {!all && (
        <Section title={t('auth.changePassword')} desc={t('settings.passwordNote')}>
          <ChangePasswordForm onDone={() => toast({ level: 'success', text: t('settings.passwordChanged') })} />
        </Section>
      )}
      <Section title={t('settings.devices')} desc={t('settings.devicesHint')}>
        {loading}
        <ul className="divide-y divide-line md:rounded-xl md:border md:border-line">
          {sessions?.map((s) => {
            const Icon = DEVICE_ICON[deviceKind(s.client, s.userAgent)]
            return (
              <li key={s.id} className="flex items-center gap-3 py-3 text-sm md:px-4">
                <Icon size={18} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  {/* a short name ("Chrome on macOS"); the raw user agent in the tooltip */}
                  <span className="block truncate" title={s.userAgent ?? undefined} data-testid="device-name">{name(s)}</span>
                  <span className="block text-xs text-faint">{t('settings.lastSeen', { date: formatDateTime(s.lastSeenAt, locale) })}</span>
                </span>
                {s.current ? (
                  <Badge tone="accent">{t('settings.thisDevice')}</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onKeyDown={noKeyRepeat} onClick={() => void signOut(s)} data-testid="device-sign-out">
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

/** A phone's password page under 보안·기기 (/settings/security/password): the note and the form; done, back to the
 * section. */
function PasswordPage() {
  const t = useT()
  const back = useGoBack('/settings/security')
  return (
    <Section title={t('auth.changePassword')} desc={t('settings.passwordNote')} page>
      <ChangePasswordForm onDone={() => { toast({ level: 'success', text: t('settings.passwordChanged') }); back() }} />
    </Section>
  )
}

/** What the AI remembers: newest first; add one, correct one in place (MemoryForm), forget one or all. A phone: rows,
 * "+" in the bar, a row opens a sheet to correct it with "Forget" (which asks first), "Forget all" a red row. */
function Memories() {
  const t = useT()
  const locale = useLocale()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [items, setItems] = useState<Memory[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  // what the read threw, kept until a read works (components/LoadError.tsx); `failedMore`: it was "더 보기", which is
  // what reads again (not the first page, which would shorten the list)
  const [error, setError] = useState<unknown>(null)
  const failedMore = useRef(false)
  // the one form open: 'new', or the id of the memory being corrected
  const [editing, setEditing] = useState<string | null>(null)
  const load = async (more = false) => {
    failedMore.current = more
    try {
      const r = await api.call(API.listMemories, { query: { limit: 100, cursor: more ? cursor ?? undefined : undefined } })
      setItems((cur) => (more && cur ? [...cur, ...r.items] : r.items))
      setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      setError(e ?? new Error('failed'))
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
  if (phone) {
    const open = editing && editing !== 'new' ? items?.find((x) => x.id === editing) : undefined
    const forget = async (m: Memory) => {
      if (!(await confirmDialog({ title: t('memory.forgetTitle'), body: m.text, confirm: t('memory.forget'), danger: true }))) return
      setEditing(null)
      await remove(m)
    }
    return (
      <Section title={t('settings.memory')} page>
        {/* the bar's one action: add */}
        <SettingsBarAction>
          <IconButton label={t('memory.add')} className="size-11" onClick={() => setEditing('new')} data-testid="memory-add">
            <Plus size={20} />
          </IconButton>
        </SettingsBarAction>
        <p className="mb-2 text-sm text-muted">{t('memory.desc')}</p>
        {!!error && <LoadError error={error} onRetry={() => load(failedMore.current)} what="settings-memory" />}
        {!items && !error && <Skeleton lines={3} />}
        {items && !items.length && <EmptyState icon={<Brain size={26} />} title={t('memory.empty')} />}
        {items && items.length > 0 && (
          <PhoneSection className="-mt-2">
            <PhoneListGroup testId="memory-list">
              {items.map((m) => (
                <PhoneListRow key={m.id} wrap testId="memory-item" onClick={() => setEditing(m.id)} chevron ariaLabel={`${t('memory.editLabel')}: ${m.text}`}
                  title={<span className="block min-w-0"><span className="line-clamp-3 break-words" data-testid="memory-text">{m.text}</span><span className="mt-0.5 block text-xs text-faint">{formatDateTime(m.createdAt, locale)}</span></span>} />
              ))}
              {cursor && <PhoneListRow title={<span className="text-accent-text">{t('common.loadMore')}</span>} onClick={() => void load(true)} testId="memory-more" />}
            </PhoneListGroup>
            {/* forgetting everything: a red row of its own (it asks first) */}
            <PhoneListGroup testId="memory-clear-group">
              <PhoneListRow title={<span className="text-danger">{t('memory.clear')}</span>} onClick={() => void clear()} testId="memory-clear" />
            </PhoneListGroup>
          </PhoneSection>
        )}
        {editing === 'new' && (
          <Modal open title={t('memory.add')} onClose={() => setEditing(null)}>
            <MemoryForm submitLabel={t('memory.add')} onSubmit={add} onCancel={() => setEditing(null)} testId="memory-form" />
          </Modal>
        )}
        {open && (
          <Modal open title={t('memory.editLabel')} onClose={() => setEditing(null)}>
            <div data-testid="memory-sheet">
              <MemoryForm initial={open.text} submitLabel={t('common.save')} onSubmit={(text) => update(open.id, text)} onCancel={() => setEditing(null)} testId="memory-form" />
              {open.sourceChatId && (
                <Link to={`/c/${open.sourceChatId}`} className="mt-3 flex min-h-11 items-center text-sm text-accent-text" data-testid="memory-source">{t('memory.source')}</Link>
              )}
              <Button variant="danger" className="mt-3 w-full" onKeyDown={noKeyRepeat} onClick={() => void forget(open)} data-testid="memory-forget">
                <Trash2 size={15} aria-hidden /> {t('memory.forget')}
              </Button>
            </div>
          </Modal>
        )}
      </Section>
    )
  }
  return (
    <Section title={t('settings.memory')} desc={t('memory.desc')} page>
      {!!error && <LoadError error={error} onRetry={() => load(failedMore.current)} what="settings-memory" />}
      {!items && !error && <Skeleton lines={3} />}
      {items && (items.length > 0 || editing === 'new') && <div className="mb-3 flex justify-end">{addButton}</div>}
      {items && !items.length && editing !== 'new' && (
        <EmptyState icon={<Brain size={26} />} title={t('memory.empty')}>
          <div className="mt-3">{addButton}</div>
        </EmptyState>
      )}
      {items && (items.length > 0 || editing === 'new') && (
        <>
          {/* phones: plain rows under the section, like the devices (no frame around them) */}
          <ul className="divide-y divide-line md:rounded-xl md:border md:border-line" data-testid="memory-list">
            {editing === 'new' && (
              <li className="py-3 text-sm md:px-4" data-testid="memory-new">
                <MemoryForm submitLabel={t('memory.add')} onSubmit={add} onCancel={() => setEditing(null)} testId="memory-form" />
              </li>
            )}
            {items.map((m) => editing === m.id ? (
              <li key={m.id} className="py-3 text-sm md:px-4" data-testid="memory-item" data-editing="true">
                <MemoryForm initial={m.text} submitLabel={t('common.save')} onSubmit={(text) => update(m.id, text)} onCancel={() => setEditing(null)} testId="memory-form" />
              </li>
            ) : (
              <li key={m.id} className="group flex items-start gap-2 py-3 text-sm md:px-4" data-testid="memory-item">
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
    <Section title={t('settings.about')} page>
      {version && <p className="text-sm" data-testid="about-version">{t('about.version', { version })}</p>}
      <p className="mt-2 text-sm text-muted">{t('about.license')}</p>
      <p className="mt-2 text-sm text-muted" data-testid="about-hwp">{t('about.hwp')}</p>
      <SourceCodeLinks info={info} className="mt-3 inline-block text-sm text-accent-text underline" />
    </Section>
  )
}

function Apps() {
  const t = useT()
  const me = useMeStrict()
  // a Mac App Store or Microsoft Store build: the store updates it, so no installer here at all (lib/downloads.ts
  // offeredDownloads); the phone app knows which phone it is
  const store = storeApp()
  const kind = clientKind()
  // the device: the phone app and the desktop app say which they are; a browser, its user agent
  const os = desktop()?.platform
  const here = kind === 'mobile' ? mobileApp()?.platform ?? platform() : os ? (os === 'darwin' ? 'mac' : os === 'win32' ? 'windows' : 'other') : platform()
  const client: AppClient = { kind, here, store }
  // a phone (the phone app, or a phone's browser): the Mac and Windows apps are for a computer, so the way to send the
  // Apps page there, not their files and not the owner's hint about the server's installers
  const phone = useMediaQuery('(max-width: 767.98px)') || kind === 'mobile'
  const [downloads, setDownloads] = useState<DownloadItem[] | null | 'none'>(null)
  useEffect(() => {
    let live = true
    // signed-in people only (the session cookie goes along); a server with no installers answers 404
    fetch('/downloads/index.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(async (r) => (r.ok ? offeredDownloads(parseDownloads(await r.json()), store) : []))
      .then((d) => live && setDownloads(d.length ? d : 'none'), () => live && setDownloads('none'))
    return () => {
      live = false
    }
  }, [])
  return (
    <>
      <TeamAddressRow address={me.team.address} />
      {phoneApps(APP_DOWNLOADS, client).rows.length > 0 && (
        <Section title={t('apps.phoneTitle')}>
          <PhoneApps links={APP_DOWNLOADS} client={client} />
        </Section>
      )}
      {phone ? (
        <PhoneSection className="-mt-6" testId="apps-computer-phone">
          <PhoneListGroup title={t('apps.desktopTitle')} footer={t('apps.sendToComputerHint')}>
            <SendToComputer address={me.team.address} />
          </PhoneListGroup>
        </PhoneSection>
      ) : (
      <Section title={t('apps.desktopTitle')} desc={t('apps.desktopDesc')}>
        <ComputerApps links={APP_DOWNLOADS} client={client} downloads={downloads} owner={me.user.role === 'owner'}
          server={downloadsSourceOf(me.server)} installHere={installGuideShown() && !isStandalone() && canInstallIn(browser())} />
      </Section>
      )}
      {/* a web browser only: the desktop app and the phone app are already apps */}
      {installGuideShown() && (
        <Section title={t('apps.installTitle')} desc={t('apps.installDesc')}>
          <InstallGuide />
        </Section>
      )}
    </>
  )
}

/** A phone's row that sends the team's Apps page to a computer: the phone's share sheet where there is one, else the
 * link is copied (and a toast says so). Opened on the computer, the person signs in and gets the Mac or Windows app
 * there. The address is the team's (GET /api/me team.address), else this page's. */
function SendToComputer({ address }: { address: string | undefined }) {
  const t = useT()
  const { copy } = useCopy()
  const link = (() => {
    try { return `${new URL(address ?? window.location.origin).origin}/settings/apps` } catch { return `${window.location.origin}/settings/apps` }
  })()
  const send = async () => {
    const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void> }
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ url: link, title: t('apps.desktopTitle') })
        return
      } catch (e) {
        // closed without sending: nothing more; a share sheet that failed: the link is copied instead
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    await copy(link)
    toast({ level: 'success', text: t('apps.linkCopied') })
  }
  return <PhoneListRow icon={<Send size={16} />} title={t('apps.sendToComputer')} onClick={() => void send()} testId="apps-send-to-computer" />
}

/**
 * The team's address, for a new device (docs/AGENTS/plan/20261108-0930-first-run-one-box.md): the desktop and phone
 * apps take it in their one box. It comes from the server (GET /api/me team.address: the relay's or the public
 * address), never from the address this page is at, and shows as the URL API gives it (punycode). No address known
 * (the office network only): no row.
 */
export function TeamAddressRow({ address }: { address: string | undefined }) {
  const t = useT()
  const host = teamAddressHost(address)
  if (!address || !host) return null
  return (
    <div className="mb-6" data-testid="apps-team-address">
      <Row label={t('apps.teamAddress')} hint={t('apps.teamAddressHint')}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-ink" data-testid="apps-team-address-host">{host}</span>
          <CopyButton text={new URL(address).origin} showLabel className="shrink-0" />
        </div>
      </Row>
    </div>
  )
}
