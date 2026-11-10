// What Admin's Home (computers) and Admin's list (phones, PhoneRoot.tsx) both read and say: the "needs attention" rows
// and each area's state, from the same sources with the same ranges, so the two never disagree. Home's rules are
// unchanged (see Home.tsx's comment). The answers are kept in memory for the session: going back to the list shows
// them at once while they are read again (no jump on a phone's Back), and the owner's server checks are not asked again
// within a minute (they run every check on the server).
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CredentialState, EngineStatus, Locale, UpdateStatus } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatShortDateTime, intlTag, localDay, localDayRange } from '../../lib/format'
import { turnWhen } from '../../lib/updateTurn'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { Button } from '../../components/ui'
import { useAction } from './common'
import { useUpdateInstall } from './jobs'

/** AI connection states an admin should act on (a member's own connection is theirs to fix, so team ones only) */
const CREDENTIAL_PROBLEMS: CredentialState[] = ['expiring', 'expired', 'invalid', 'needs_reconnect', 'over_limit']
/** an engine nobody set up: no program or API settings, or no sign-in or AI connection of its kind (the API engine's
 * not_logged_in is its key refused: set up, and broken) */
const notSetUp = (e: EngineStatus) => e.status === 'not_installed' || (e.status === 'not_logged_in' && e.id !== 'api')

export const names = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '')

/** After-update to-dos this client has text for (server/src/system/after-update.ts sends ids; unknown ones are not shown) */
const AFTER_UPDATE_IDS = ['hwp-plugin']

/** Where in the day a window starts, for the words: dawn (before 06:00), night (18:00 on), else the day. */
const partOfDay = (window: string) => {
  const h = +window.slice(0, 2)
  return h < 6 ? 'dawn' : h >= 18 ? 'night' : 'day'
}

/** When a release waiting for this server's turn in its staged roll-out installs (turnAt), in the day words of an
 * ordinary automatic update, with the date when it is further away than tomorrow; null when it cannot be said. */
function turnLine(t: (k: MessageKey, v?: Record<string, string | number>) => string, locale: Locale, u: UpdateStatus): string | null {
  if (!u.turnAt || !u.window || !u.timeZone) return null
  const w = turnWhen(u.turnAt, u.window, u.timeZone)
  if (!w) return null
  const window = u.window.replace('-', '–')
  const date = new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(w.date)
  return t(`adminHome.when.${w.day}.${partOfDay(u.window)}` as MessageKey, { window, date })
}

/** What the Home item says about a new version: when it installs by itself, that the timer does it, or that nothing will. */
function updateLine(t: (k: MessageKey, v?: Record<string, string | number>) => string, locale: Locale, u: UpdateStatus, version: string) {
  if (u.needsRoot) {
    if (u.hold === 'root_failed') return t('adminHome.update.rootFailed', { version })
    // the update timer keeps the staged roll-out too (turnAt): on this server's turn, or never by itself (null: the
    // command then)
    if (!u.auto || u.turnAt === null) return t('adminHome.update.rootManual', { version })
    const when = turnLine(t, locale, u)
    return when ? t('adminHome.update.rootAt', { version, when }) : t('adminHome.update.root', { version })
  }
  if (!u.auto || u.nextWindow === null) return t('adminHome.update.off', { version })
  if (u.hold === 'rollout') {
    // this server's turn in the staged roll-out (server/src/system/rollout.ts), when the server says when; null: this
    // release's roll-out never reaches this server by itself (Install now still does)
    if (u.turnAt === null) return t('adminHome.update.rolloutNever', { version })
    const when = turnLine(t, locale, u)
    return when ? t('adminHome.update.rolloutAt', { version, when }) : t('adminHome.update.rollout', { version })
  }
  if (u.hold === 'failed' || u.hold === 'root_failed') return t('adminHome.update.failed', { version })
  const n = u.nextWindow
  const window = u.window ? u.window.replace('-', '–') : ''
  const when = !u.window || !n ? t('adminHome.when.window')
    : n.day === 'now' ? t('adminHome.when.now')
    : t(`adminHome.when.${n.day}.${partOfDay(u.window)}` as MessageKey, { window })
  return t('adminHome.update.auto', { version, when })
}

export type State<T> = { data: T | null; error: string | null }
const settled = (...s: State<unknown>[]) => s.every((x) => x.data !== null || x.error !== null)

/** The answers read this session, by what was asked (the session's id is part of the key: another sign-in starts empty). */
const memo = new Map<string, { at: number; data: unknown }>()

/** Tests only. */
export const clearOverviewMemo = () => memo.clear()

/** useLoad (common.tsx) that starts from the last answer this session and reads again, unless that answer is younger
 * than `fresh` ms. */
function useKeptLoad<T>(key: string, fn: () => Promise<T>, fresh = 0) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<T | null>(() => (memo.get(key)?.data as T | undefined) ?? null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const d = await fn()
      memo.set(key, { at: Date.now(), data: d })
      setData(d)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    const kept = memo.get(key)
    if (kept) setData(kept.data as T)
    if (kept && Date.now() - kept.at < fresh) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])
  return { data, error, reload }
}

export interface AttentionItem { key: string; text: string; to: string; actions?: ReactNode; job?: string | null }

/** The admin page a link opens ('' for /admin itself; null outside Admin). */
export function sectionOf(to: string): string | null {
  const path = to.split(/[?#]/)[0] ?? ''
  if (path === '/admin') return ''
  return path.startsWith('/admin/') ? path.slice('/admin/'.length).split('/')[0]! : null
}

export function useAdminOverview() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const owner = isOwner(me)
  const k = (what: string) => `${me.session.id}:${what}`
  // "No AI": the people who cannot use any AI connection now (the same list as Admin › Members)
  const users = useKeptLoad(k('users'), () => api.call(API.listUsers, { query: { noAi: '1' } }))
  const invites = useKeptLoad(k('invites'), async () => (await api.call(API.listInvites)).items)
  const engines = useKeptLoad(k('engines'), () => api.call(API.engines))
  const credentials = useKeptLoad(k('credentials'), async () => (await api.call(API.listCredentials)).items.filter((c) => c.scope === 'team'))
  const services = useKeptLoad(k('services'), async () => (await api.call(API.listTeamIntegrations)).items)
  const plugins = useKeptLoad(k('plugins'), async () => (await api.call(API.listPlugins)).installed)
  const usage = useKeptLoad(k('usage'), () => api.call(API.usage, { query: { groupBy: 'user', ...localDayRange(localDay(new Date(Date.now() - 29 * 86400_000)), localDay(new Date())) } }))
  const audit = useKeptLoad(k('audit'), async () => (await api.call(API.audit, { query: { limit: 3 } })).items)
  const storage = useKeptLoad(k('storage'), () => api.call(API.storage))
  // the owner's server checks run every check on the server: not again within a minute
  const diagnostics = useKeptLoad(k(`diagnostics:${owner}`), async () => (owner ? (await api.call(API.diagnostics)).checks : []), 60_000)
  // A new version (the owner's; Admin > System installs it). Never blocks Home: no `settled`, and an error is no item.
  // Office mode has its own banner and update card, so it is skipped there (the office status is null outside it).
  const update = useKeptLoad(k(`update:${owner}`), async () => (owner ? { u: await api.call(API.updateStatus) } : { u: null }))
  const office = useKeptLoad(k(`office:${owner}`), async () => (owner ? { v: await api.call(API.officeUpdateStatus) } : { v: null }))
  // What a release left for an admin to do (server/src/system/after-update.ts); not needed for Home to show.
  const after = useKeptLoad(k('after'), async () => (await api.call(API.afterUpdateActions)).items)
  const navigate = useNavigate()
  const act = useAction()

  const item = (name: string, state: string) => t('adminHome.item', { name, state })
  const active = users.data?.items.filter((u) => u.status === 'active') ?? []
  const noAiPeople = users.data ? users.data.items.filter((u) => users.data?.noAi?.includes(u.id)) : []
  const noAi = noAiPeople.map((u) => u.name)
  // every one of them only waits for a limit to end (noAiUntil): the line says until when (the last end: all have AI then)
  const noAiEnds = noAiPeople.map((u) => users.data?.noAiUntil?.[u.id])
  const noAiEnd = noAiEnds.length && noAiEnds.every(Boolean) ? (noAiEnds as string[]).sort().at(-1) : undefined
  const openInvites = invites.data?.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > Date.now()).length ?? 0
  // An engine that is on but never set up (notSetUp) is not a problem while another engine is set up (answers, or only
  // waits for a limit to end): a team on Claude alone has nothing to fix. It is when it is the team default; when no
  // engine is set up at all, one line says so instead of one per engine. A broken engine (error, untested version,
  // failed lockdown, a refused API key) always has its own line. A connection that stopped working has its own line
  // below (badCredentials).
  const onEngines = engines.data?.engines.filter((e) => e.enabled) ?? []
  const anyEngineSetUp = onEngines.some((e) => e.status === 'ok' || e.status === 'limited')
  const badEngines = onEngines.filter((e) => e.status !== 'ok' && e.status !== 'limited'
    && (notSetUp(e) ? anyEngineSetUp && e.id === engines.data?.defaultEngine : true))
  const noEngine = !!engines.data && !anyEngineSetUp && onEngines.some(notSetUp)
  // An engine at its limit: the people line (or a credential over its limit) already says it; else one line of its own.
  const limitCovered = noAi.length > 0 || (credentials.data ?? []).some((c) => !c.disabled && c.state === 'over_limit')
  const limitedEngines = limitCovered ? [] : onEngines.filter((e) => e.status === 'limited')
  const badCredentials = credentials.data?.filter((c) => !c.disabled && CREDENTIAL_PROBLEMS.includes(c.state)) ?? []
  const badServices = services.data?.filter((s) => s.status !== 'connected') ?? []
  const storageBad = !!storage.data && (storage.data.level !== 'ok' || storage.data.writesRefused)
  const failedChecks = diagnostics.data?.filter((c) => c.status === 'fail') ?? []
  const checksToLook = diagnostics.data?.filter((c) => c.status === 'fail' || c.status === 'warn') ?? []

  const upd = update.data?.u
  const newVersion = upd && !upd.managed && office.data && !office.data.v ? upd.available?.version : undefined
  // "Install now" is the same install as Admin > System's (jobs.tsx); not when the release needs root (the timer does it)
  const install = useUpdateInstall({ version: newVersion, onDone: () => void update.reload() })
  // by hand it works when automatic updates are off or will not install it (a window that never opens, not this server's turn, on hold)
  const canInstall = !!newVersion && !upd?.needsRoot && (!upd?.auto || upd.nextWindow === null || upd.hold === 'rollout' || upd.hold === 'failed')

  const attention: AttentionItem[] = [
    ...badEngines.map((e) => ({ key: `engine-${e.id}`, text: item(e.label, t(`engines.status.${e.status}`)), to: '/admin/providers' })),
    ...(noEngine ? [{ key: 'no-engine', text: t('adminHome.noEngine'), to: '/admin/providers' }] : []),
    ...limitedEngines.map((e) => ({ key: `engine-${e.id}`, to: '/admin/providers', text: e.limitedUntil
      ? t('adminHome.engineLimit', { name: e.label, time: formatShortDateTime(e.limitedUntil, locale) })
      : t('adminHome.engineLimitNoTime', { name: e.label }) })),
    ...(noAi.length ? [{ key: 'no-ai', to: '/admin/providers', text: noAiEnd
      ? t('adminHome.noAiLimit', { count: noAi.length, names: names(noAi), time: formatShortDateTime(noAiEnd, locale) })
      : t('adminHome.noAi', { count: noAi.length, names: names(noAi) }) }] : []),
    ...badCredentials.map((c) => ({ key: `credential-${c.id}`, text: item(c.label, t(`credentials.state.${c.state}`)), to: '/admin/providers?engine=claude-code' })),
    ...badServices.map((s) => ({ key: `service-${s.id}`, text: item(s.name, t(`integrations.status.${s.status}`)), to: '/admin/connectors' })),
    ...(storageBad && storage.data ? [{ key: 'storage', text: t('adminHome.storage', { percent: Math.round(storage.data.percent) }), to: '/admin/system' }] : []),
    ...failedChecks.map((c) => ({ key: `check-${c.id}`, text: c.label, to: '/admin/system' })),
    ...(newVersion && upd ? [{
      key: 'update', text: updateLine(t, locale, upd, newVersion), to: '/admin/system', job: install.jobId,
      actions: canInstall ? <Button size="sm" variant="primary" disabled={!!install.jobId} onClick={() => install.ask('update')} data-testid="home-update-install">{t('adminHome.update.install')}</Button> : undefined,
    }] : []),
    ...(after.data ?? []).filter((a) => AFTER_UPDATE_IDS.includes(a.id)).map((a) => ({
      key: `after-${a.id}`, text: t(`adminHome.after.${a.id}` as MessageKey), to: a.to,
      actions: (
        <>
          <Button size="sm" variant="primary" onClick={() => navigate(a.to)} data-testid={`home-after-${a.id}-go`}>{t(`adminHome.after.${a.id}.go` as MessageKey)}</Button>
          <Button size="sm" variant="ghost" onClick={() => void act(async () => { await api.call(API.dismissAfterUpdate, { params: { id: a.id }, body: {} }); return null }).then((r) => { if (r !== undefined) void after.reload() })} aria-label={t('adminHome.after.dismiss.label', { todo: t(`adminHome.after.${a.id}` as MessageKey) })} data-testid={`home-after-${a.id}-dismiss`}>{t('adminHome.after.dismiss')}</Button>
        </>
      ),
    })),
  ]
  const ready = settled(users, engines, credentials, services, storage, diagnostics)
  // A source of the list above that did not load: the list may miss something, so Home never says all is well then
  const unchecked = [users, engines, credentials, services, storage, diagnostics].some((s) => s.error !== null)
  const defaultEngine = engines.data?.engines.find((e) => e.id === engines.data?.defaultEngine)?.label
  const latest = audit.data?.[0]
  /** How many of the attention rows open this admin page (the phone list's "N to fix", never apart from the rows) */
  const toFix = (section: string) => attention.filter((a) => sectionOf(a.to) === section).length

  return {
    owner, users, engines, credentials, services, plugins, usage, audit, storage, diagnostics,
    active, openInvites, noAi, badEngines, noEngine, limitedEngines, badCredentials, badServices, storageBad, checksToLook,
    attention, ready, unchecked, defaultEngine, latest, install, toFix,
  }
}
