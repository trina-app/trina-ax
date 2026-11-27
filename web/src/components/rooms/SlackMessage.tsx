// A conversation linked to a Slack channel (docs/SLACK.md "Channel relay"), the parts its messages show:
// - a message relayed from Slack (RoomMessage.slackAuthor): the sender's Slack picture (or their initial), their Slack
//   name with a small Slack mark and "External" (another organization) or "App" (an app's post), never a team member
//   and never a link to anyone's profile. Its words are plain text with their line breaks: the server escapes Markdown
//   marks in the body (lib/roomApps.ts unescapeAppBody undoes that), and nothing in them becomes a link. Files are their
//   names with "Open in Slack"; a reply to a Slack thread whose first message never came here says so.
// - my or a teammate's message there (RoomMessage.slackSent): "Not sent to Slack" when Slack refused it (Retry for its
//   author) or when it is not sent by rule (an AI answer), "Files not sent to Slack" when only its text went.
import clsx from 'clsx'
import { ExternalLink, Paperclip } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { RoomMessage, SlackAuthor } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { firstLetter } from '../../lib/appTone'
import { slackLogo } from '../../lib/connectors'
import { slackText } from '../../lib/roomApps'
import { toast } from '../../store/ui'
import { Badge, TextAction } from '../ui'

export { slackText }

/** Slack's own mark (web/public/icons/connectors/slack.svg, docs/THIRD-PARTY-NOTICES.md), in its colours. */
export function SlackMark({ size = 12, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <img
      src={slackLogo} width={size} height={size} draggable={false} decoding="async"
      alt={label ?? ''} aria-hidden={label ? undefined : true}
      className={clsx('shrink-0 select-none', className)} style={{ width: size, height: size }} data-testid="slack-mark"
    />
  )
}

/** A picture this server serves (slackRelayAvatar), never an outside address. */
const ownImage = (url: string | undefined): string | null => (url && url.startsWith('/api/') ? url : null)

/** The sender's face: their Slack picture, else their initial on a plain tile (round for a person, square for an app). */
export function SlackFace({ author, className }: { author: SlackAuthor; className?: string }) {
  const src = ownImage(author.avatarUrl)
  const [broken, setBroken] = useState(false)
  const shape = author.bot ? 'rounded-[9px]' : 'rounded-full'
  if (src && !broken) {
    return <img src={src} alt="" aria-hidden width={32} height={32} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className={clsx('size-8 shrink-0 bg-hover object-cover select-none', shape, className)} data-testid="slack-face" data-face="picture" />
  }
  return (
    <span aria-hidden className={clsx('flex size-8 shrink-0 items-center justify-center bg-hover text-sm font-semibold text-muted select-none', shape, className)} data-testid="slack-face" data-face="letter">
      {firstLetter(author.name)}
    </span>
  )
}

/** The sender's name as Slack has it, the Slack mark, then "External" or "App". Plain text: no card, no menu. */
export function SlackSender({ author }: { author: SlackAuthor }) {
  const t = useT()
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" data-testid="slack-sender">
      <span className="truncate text-sm font-medium text-ink" data-testid="slack-sender-name">{author.name}</span>
      <SlackMark size={12} className="self-center" label={t('slackRelay.mark')} />
      {author.external && <Badge className="self-center px-1 py-0 leading-4"><span data-testid="slack-external">{t('slackRelay.external')}</span></Badge>}
      {author.bot && <Badge className="self-center px-1 py-0 leading-4"><span data-testid="slack-bot">{t('roomApps.tag')}</span></Badge>}
    </span>
  )
}

function OpenInSlack({ href, testId }: { href: string; testId: string }) {
  const t = useT()
  // Slack's own address only (the server sends its permalink); anything else shows no link
  if (!/^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\//i.test(href)) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="touch-hit inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline" data-testid={testId}>
      {t('slackRelay.openInSlack')}
      <ExternalLink size={11} aria-hidden />
    </a>
  )
}

/** A relayed message's words, its files' names and, for a reply to a Slack thread never relayed here, that line. */
export function SlackRelayedBody({ m, className, after }: { m: Pick<RoomMessage, 'body'> & { slackAuthor: SlackAuthor }; className?: string; after?: ReactNode }) {
  const t = useT()
  const a = m.slackAuthor
  const text = slackText(m)
  return (
    <div className={clsx('min-w-0', className)} data-testid="slack-relayed">
      {a.threadElsewhere && (
        <p className="mb-0.5 flex flex-wrap items-center gap-x-1 text-xs text-faint" data-testid="slack-thread-elsewhere">
          {t('slackRelay.threadElsewhere')}
          {a.permalink && <>{' · '}<OpenInSlack href={a.permalink} testId="slack-thread-open" /></>}
        </p>
      )}
      {text && <p className="text-reading leading-reading break-words whitespace-pre-wrap text-ink" data-testid="slack-text">{text}{after}</p>}
      {!!a.files?.length && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="slack-files">
          {a.files.map((f, i) => (
            <span key={i} className="inline-flex min-w-0 items-center gap-1 text-muted" data-testid="slack-file">
              <Paperclip size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{f}</span>
            </span>
          ))}
          {a.permalink && <OpenInSlack href={a.permalink} testId="slack-files-open" />}
        </div>
      )}
    </div>
  )
}

/** Under my or a teammate's message in a linked conversation: what did not go to Slack, and Retry for its author. */
export function SlackSentLine({ roomId, m, mine }: { roomId: string; m: Pick<RoomMessage, 'id' | 'slackSent' | 'files'>; mine: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const s = m.slackSent
  const words = s === 'failed' || s === 'not_relayed' ? t('slackRelay.notSent') : s === 'ok' && m.files.length > 0 ? t('slackRelay.filesNotSent') : null
  if (!words) return null
  const retry = async () => {
    setBusy(true)
    try { await api.call(API.retrySlackRelay, { params: { id: roomId, messageId: m.id } }) }
    catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
    finally { setBusy(false) }
  }
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-faint" data-testid="slack-not-sent" data-state={s}>
      <SlackMark size={11} />
      <span>{words}</span>
      {s === 'failed' && mine && (
        <>
          <span aria-hidden>·</span>
          <TextAction onClick={() => void retry()} disabled={busy} className="touch-hit text-xs" data-testid="slack-retry">{t('common.retry')}</TextAction>
        </>
      )}
    </p>
  )
}
