import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { InboxNotification, Locale, NotificationPreferences } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { firstRunText } from '../../lib/teamGoal'
import { useLocale, useT } from '../../i18n'
import { accessChanged, reloadAsked } from '../../store/live'
import { useInboxUnread } from '../../store/inbox'
import { ErrorNote, Skeleton, Switch } from '../ui'
import { changeRoomSound, useRoomSoundOn } from '../../store/roomSound'
import { PushNotifications } from './PushNotifications'
import { DesktopNotifications } from './DesktopNotifications'
import { isDesktop } from '../../lib/desktop'
import { deletionNoticeText } from './AccountDeletion'
import { PrefRow, PrefSection } from './PrefRows'
import { RoomNotifySettings } from './RoomNotifySettings'
import { roomNoticeLink } from './RoomNoticeRow'
import { handoverNoticeNode } from '../handover/HandoverNotice'
import { isolate } from '../handover/isolate'
import { builtInName } from '../../lib/googleApps'

/** 작업·연결 알림: the server's switches for what is not a conversation (the rooms' are in RoomNotifySettings) */
const workKeys = ['scheduleSuccess', 'scheduleFailure', 'connectionReconnect', 'skillSuggestions'] as const

/** A conversation notice from a server that does not say where and why (RoomNoticeRow does), or one whose message I may
 * no longer read: who wrote it when the server still names them, no text. */
const roomText = (item: InboxNotification, t: ReturnType<typeof useT>) => {
  const from = item.room?.from
  if (item.code === 'room.mention') return from ? t('notifications.event.room.mentionNamed', { name: from }) : t('notifications.event.room.mention')
  return from ? t('notifications.event.room.dmNamed', { name: from }) : t('notifications.event.room.dm')
}

/** What an admin did to the team's AI (or to a member's own connection): the page knows these actions; one it does not
 * (a newer server) is a generic line rather than a missing text. */
const CREDENTIAL_ACTIONS = ['added', 'replaced', 'removed', 'disabled', 'reassigned', 'zero_limit', 'shared_on', 'engine', 'personal_disabled', 'personal_removed', 'personal_login_stopped'] as const
export const credentialChangeText = (c: NonNullable<InboxNotification['credentialChange']>, t: ReturnType<typeof useT>) =>
  (CREDENTIAL_ACTIONS as readonly string[]).includes(c.action)
    ? t(`notifications.credentialChange.${c.action as typeof CREDENTIAL_ACTIONS[number]}`, { who: c.who, subject: c.subject })
    : t('notifications.event.credential.change')

/** A suggestion to review opens in the review tab, an own result in "my suggestions" (the Skills screen checks access). */
/** A skill notice's link: a suggestion to review (a member's batch of skill folders: Skills › 검토 at that person,
 * docs/DECISIONS.md "MC"), or the result of one of mine. */
export const skillsLink = (item: Pick<InboxNotification, 'code' | 'sourceId' | 'contribution'>) =>
  `/skills?${item.code === 'skill.suggested' ? (item.contribution ? 'batch' : 'review') : 'mine'}=${encodeURIComponent(item.sourceId)}`

/** Settings › MCP: a request opens as ?request=, a connection template (its notice, or a scheduled run that needed it)
 * opens its Connect as ?template=. */
export const integrationsLink = (item: Pick<InboxNotification, 'sourceId' | 'template' | 'needsKey'>) => {
  const template = item.template?.id ?? item.needsKey?.templateId
  return template ? `/connectors?template=${encodeURIComponent(template)}` : `/connectors?request=${encodeURIComponent(item.sourceId)}`
}

export type DevEnvEndReason = 'timeout' | 'oom' | 'stopped' | 'idle' | 'disk' | 'setting' | 'expired' | 'lost'
export const END_REASONS: ReadonlySet<string> = new Set<DevEnvEndReason>(['timeout', 'oom', 'stopped', 'idle', 'disk', 'setting', 'expired', 'lost'])

/** The text of a dev environment notice: with the job or the project while the person can still read that project. */
const devEnvText = (item: InboxNotification, t: ReturnType<typeof useT>) => {
  const d = item.devEnv
  // srt runner: a job with no exit code says why it ended (a reason the page does not know is the old text)
  if (d?.job && d.job.exitCode === null && d.job.reason && END_REASONS.has(d.job.reason)) return t('notifications.event.dev_env.jobReason', { name: d.job.name, why: t(`devEnv.end.${d.job.reason as DevEnvEndReason}`) })
  if (d?.job) return d.job.exitCode === null ? t('notifications.event.dev_env.jobNoCode', { name: d.job.name }) : t('notifications.event.dev_env.jobEnded', { name: d.job.name, code: d.job.exitCode })
  if (d?.stopCode === 'disk') return t('notifications.event.dev_env.boxDisk', { project: d.projectName })
  if (d?.stopCode === 'busy_max') return t('notifications.event.dev_env.boxBusy', { project: d.projectName })
  return t(`notifications.event.${item.code as 'dev_env.job' | 'dev_env.box'}`)
}

type T = ReturnType<typeof useT>

/** A member's ask to add an app (shared/src/api/service-requests.ts): to an owner or admin, who asks ("Alice and 2
 * others asked to add Gmail"); to the member who asked, that it is ready. Never an admin's name. */
const serviceRequestText = (item: InboxNotification, sr: NonNullable<InboxNotification['serviceRequest']>, t: T) => {
  const service = builtInName(sr.service)
  if (item.code === 'service.ready') return t('notifications.event.service.readyNamed', { service })
  if (!sr.name) return t('notifications.event.service.requestSomeone', { service })
  return sr.others ? t('notifications.event.service.requestMore', { name: sr.name, n: sr.others, service }) : t('notifications.event.service.requestNamed', { name: sr.name, service })
}

/** Where an app's setup is in Admin › Connected apps: Google Drive's page, or a Google app's. */
export const serviceSetupLink = (service: NonNullable<InboxNotification['serviceRequest']>['service']) =>
  service === 'google-drive' ? '/admin/connectors?drive=1' : `/admin/connectors?app=${encodeURIComponent(service)}`

/** Someone started to see a project I am in (docs/DECISIONS.md "Project contents only for members": an owner or admin
 * who added themselves, or anyone through a group): who, while their account is there, and the project, while I still
 * see it; "누군가" and "프로젝트" for the part the server leaves out. */
export function projectJoinedText(j: NonNullable<InboxNotification['projectJoined']>, t: T): string {
  if (j.name && j.project) return t('notifications.event.project.joinedNamed', { name: j.name, project: j.project.name })
  if (j.name) return t('notifications.event.project.joinedName', { name: j.name })
  if (j.project) return t('notifications.event.project.joinedProject', { project: j.project.name })
  return t('notifications.event.project.joined')
}

/** A password reset link made for me (QA TC-202): who made it and, while it still works, how to stop it. */
export const resetLinkText = (r: NonNullable<InboxNotification['resetLink']>, t: T) => {
  const who = r.server ? t('notifications.resetLink.server') : r.by ? t('notifications.resetLink.by', { name: r.by }) : t('notifications.resetLink.admin')
  return r.open ? `${who} ${t('notifications.resetLink.openHint')}` : who
}

/** The words of a notice of the app's own. A scheduled run names its task while the task is there (the person's own
 * words, in <bdi>); without it, "a scheduled task" as before. */
export function noticeText(item: InboxNotification, t: T, locale: Locale): ReactNode {
  if (item.handover) return handoverNoticeNode(locale, item.handover)
  if (item.code === 'credential.change' && item.credentialChange) return credentialChangeText(item.credentialChange, t)
  if (item.code === 'room.dm' || item.code === 'room.mention') return roomText(item, t)
  if (item.code === 'dev_env.job' || item.code === 'dev_env.box') return devEnvText(item, t)
  // "tried to use Trina but it isn't set up yet" (POST /api/me/ai-not-ready/tell), with the name while the account is there
  if (item.code === 'onboarding.ai_request' && item.notReady) return item.requester ? t('notifications.event.onboarding.ai_notReadyNamed', { name: item.requester.name }) : t('notifications.event.onboarding.ai_notReady')
  if (item.code === 'onboarding.ai_request' && item.requester) return t('notifications.event.onboarding.ai_requestNamed', { name: item.requester.name })
  if (item.code === 'skills.merge_waiting' && item.merges) return t('notifications.event.skills.merge_waitingN', { n: item.merges.n })
  if (item.code === 'skill.suggested' && item.contribution) return item.contribution.name ? t('notifications.event.skill.contributed', { name: item.contribution.name, n: item.contribution.n }) : t('notifications.event.skill.contributedGone', { n: item.contribution.n })
  if (item.code === 'team.joined') return item.joined ? t('teamLink.joinedNotice', { name: item.joined.name }) : t('teamLink.joinedNoticeGone')
  if (item.code === 'project.joined' && item.projectJoined) return projectJoinedText(item.projectJoined, t)
  if (item.code === 'onboarding.first_run') return firstRunText(t, locale, item)
  if (item.code === 'account.deletion_request') return deletionNoticeText(t, item)
  if (item.code === 'account.reset_link' && item.resetLink) return resetLinkText(item.resetLink, t)
  if (item.code === 'integration.request' && item.request) return t('notifications.event.integration.requestNamed', { name: item.request.name, host: item.request.host })
  if (item.code === 'drive.share_reconnect' && item.driveShare) return t('notifications.event.drive.share_reconnectNamed', { name: item.driveShare.name })
  if ((item.code === 'service.request' || item.code === 'service.ready') && item.serviceRequest) return serviceRequestText(item, item.serviceRequest, t)
  if (item.template) return t(item.code === 'integration.template_reconnect' ? 'notifications.event.integration.template_reconnectNamed' : 'notifications.event.integration.templateNamed', { name: item.template.name })
  const title = item.schedule?.title
  if (item.code === 'schedule.failure' && item.needsKey) return title
    ? isolate(locale, 'notifications.event.schedule.needsKeyNamed', { title, name: item.needsKey.name }, ['title', 'name'])
    : t('notifications.event.schedule.needsKey', { name: item.needsKey.name })
  // a run that did not start because its owner no longer sees the task's project
  if (item.code === 'schedule.failure' && item.projectGone) return title
    ? isolate(locale, 'notifications.event.schedule.projectGoneNamed', { title }, ['title'])
    : t('notifications.event.schedule.projectGone')
  // a task whose save folder lapsed: check it again on the Scheduled page (its runs save in the own folder meanwhile)
  if (item.code === 'schedule.failure' && item.saveLapsed) return title
    ? isolate(locale, 'notifications.event.schedule.saveLapsedNamed', { title }, ['title'])
    : t('notifications.event.schedule.saveLapsed')
  if (item.code === 'schedule.failure' && item.review) return t('notifications.event.schedule.review')
  if (item.code === 'schedule.success' || item.code === 'schedule.failure') {
    const kind = item.code === 'schedule.success' ? 'success' : item.outcome === 'problems' ? 'problems' : 'failure'
    return title ? isolate(locale, `notifications.event.schedule.${kind}Named`, { title }, ['title']) : t(`notifications.event.schedule.${kind}`)
  }
  return t(`notifications.event.${item.code}`)
}

/** Where a notice of the app's own opens, with its link's test id: the result chat of a scheduled run, the page of the
 * rest. Null: nowhere (a source I may no longer read, a notice that only tells), and its row is no link. */
export function noticeLink(item: InboxNotification): { to: string; testId: string } | null {
  if (item.link === 'chat' && item.chatId) return { to: `/c/${encodeURIComponent(item.chatId)}`, testId: 'notification-chat-link' }
  if (item.link === 'room' && item.room) return { to: roomNoticeLink(item.room), testId: 'notification-room-link' }
  if (item.link === 'project' && item.devEnv) return { to: `/projects/${encodeURIComponent(item.devEnv.projectId)}`, testId: 'notification-project-link' }
  if (item.code === 'project.joined' && item.projectJoined?.project) return { to: `/projects/${encodeURIComponent(item.projectJoined.project.id)}`, testId: 'notification-project-link' }
  if (item.review) return { to: '/scheduled', testId: 'notification-review-link' }
  if (item.saveLapsed) return { to: '/scheduled', testId: 'notification-save-lapsed-link' }
  if (item.link === 'connections') return { to: '/connectors/google-drive', testId: 'notification-connections-link' }
  // a member's ask: the app's setup while one waits (an owner or admin), the app's page once it is ready (the member)
  if (item.code === 'service.request' && item.serviceRequest?.open) return { to: serviceSetupLink(item.serviceRequest.service), testId: 'notification-service-request-link' }
  if (item.code === 'service.ready' && item.serviceRequest) return { to: `/connectors/${encodeURIComponent(item.serviceRequest.service)}`, testId: 'notification-service-ready-link' }
  if (item.link === 'integrations') return { to: integrationsLink(item), testId: item.template || item.needsKey ? 'notification-template-link' : 'notification-request-link' }
  if (item.link === 'admin_connectors') return { to: '/admin/connectors?drive=1', testId: 'notification-drive-share-link' }
  if (item.link === 'admin_credentials') return { to: '/admin/providers', testId: item.code === 'credential.change' ? 'notification-credential-link' : 'notification-ai-request-link' }
  if (item.code === 'team.joined') return { to: '/admin/members', testId: 'notification-joined-link' }
  // a reset link made for me that still works: Settings › 보안·기기, where changing the password ends it
  if (item.code === 'account.reset_link' && item.resetLink?.open) return { to: '/settings/security', testId: 'notification-reset-link-link' }
  if (item.link === 'admin_members') return { to: `/admin/members?member=${encodeURIComponent(item.sourceId)}`, testId: 'notification-deletion-link' }
  if (item.link === 'skills') return { to: skillsLink(item), testId: 'notification-skills-link' }
  return null
}

export function Notifications() {
  const t = useT(), locale = useLocale()
  const sound = useRoomSoundOn()
  const unread = useInboxUnread()
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), sequence = useRef(0), writing = useRef(false)
  /** changes made while one is saving: sent together right after it (nothing waits for the server on screen) */
  const queued = useRef<Partial<NotificationPreferences> | null>(null)
  /** what the server has, as its last answer said (a read, or a save's answer): what a failed save goes back to */
  const saved = useRef<NotificationPreferences | null>(null)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])
  /** `keepError`: the read after a failed save, which leaves that save's message up */
  const load = useCallback(async (keepError = false) => {
    const generation = life.current, seq = ++sequence.current
    try {
      const prefs = await api.call(API.getNotificationPreferences)
      if (generation !== life.current || seq !== sequence.current) return
      // while my changes are being saved, the switches show them, not a read from before the last one landed
      if (!writing.current) { saved.current = prefs; setPreferences(prefs) }
      if (!keepError) setError(null)
    } catch (e) { if (!keepError && generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    // useT returns a fresh function; its translations change only with locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const reload = reloadAsked.on(() => void load()), access = accessChanged.on(() => void load())
    return () => { reload(); access() }
  }, [load])
  // shown at once; saved in order, one request at a time (a change made meanwhile goes with the next one)
  const update = async (patch: Partial<NotificationPreferences>) => {
    const generation = life.current
    setPreferences(current => current ? { ...current, ...patch } : current)
    sequence.current++
    if (writing.current) { queued.current = { ...queued.current, ...patch }; return }
    writing.current = true
    try {
      for (let body: Partial<NotificationPreferences> | null = patch; body; body = queued.current, queued.current = null) {
        saved.current = await api.call(API.updateNotificationPreferences, { body })
      }
    } catch (e) {
      queued.current = null; writing.current = false
      if (generation !== life.current) return
      // back to what the server has, not to the switches as they were when this save began: a change saved before it
      // (or in the same run of saves) stays. Then read the server again, as it may have more than its last answer said
      if (saved.current) setPreferences(saved.current)
      setError(errorText(e, locale, t('error.network')))
      await load(true)
      return
    }
    writing.current = false
    if (generation === life.current) await load()
  }
  // The way to Activity (the notices, pages/Activity.tsx), then the settings as plain sections: 대화, 작업·연결 알림,
  // 이 기기 (docs/DECISIONS.md "대화방 알림 설정"). No frames; the title is in the bar above on a phone
  // (SettingsDialog.tsx), so here it is for screen readers only.
  return <section className="flex flex-col gap-5" data-testid="notifications">
    <div><h2 className="text-base font-semibold max-md:sr-only">{t('notifications.title')}</h2><p className="mt-1 text-sm text-muted max-md:mt-0">{t('notifications.description')}</p></div>
    {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
    {!preferences && !error && <Skeleton lines={3} />}
    {/* the notices themselves are on their own page, Activity (pages/Activity.tsx); a phone's 나 list has its row with
        the count, and Activity's gear opens this page, so no way back to it here (it went round in a loop) */}
    <Link to="/activity" className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-sm hover:bg-hover max-md:hidden" data-testid="notifications-activity">
      <Bell size={16} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 font-medium">{t('inbox.open')}</span>
      {unread > 0 && <span className="rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink"><span aria-hidden>{unread > 99 ? '99+' : unread}</span><span className="sr-only">{t('notifications.unread', { count: unread })}</span></span>}
    </Link>
    {preferences && <RoomNotifySettings prefs={preferences} onChange={(patch) => void update(patch)} />}
    {preferences && <PrefSection title={t('notifications.section.work')} desc={t('notifications.preferenceHint')} testId="notifications-work">
      {/* a server from before a preference existed leaves it out: no row for it */}
      {workKeys.filter(key => typeof preferences[key] === 'boolean').map(key => <PrefRow key={key} id={`np-${key}`} title={t(`notifications.${key}`)} desc={t(`notifications.${key}Desc`)}
        control={<Switch id={`np-${key}`} external describedBy={`np-${key}-desc`} checked={preferences[key]} onChange={v => void update({ [key]: v })} label={t(`notifications.${key}`)} testId={`notification-pref-${key}`} />} />)}
    </PrefSection>}
    {/* this device's: the chime (store/roomSound.ts, kept in this browser, never waits for the server and shows even when
        the server's choices could not be read) and push to this device (the desktop app: its own computer notifications) */}
    <PrefSection title={t('notifications.section.device')} testId="notifications-device">
      <PrefRow id="np-sound" title={t('notifications.sound')} desc={t('notifications.soundDesc')}
        control={<Switch id="np-sound" external describedBy="np-sound-desc" checked={sound} onChange={changeRoomSound} label={t('notifications.sound')} testId="notification-sound" />} />
      {isDesktop() ? <DesktopNotifications /> : <PushNotifications />}
    </PrefSection>
  </section>
}
