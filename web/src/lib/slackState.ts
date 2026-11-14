// Slack's state in words, the one source for Admin › Connected apps' Slack row and Slack's own page (QA TC-1415: the
// row said "On" while the page said "Connecting"; docs/DECISIONS.md "Slack: one state for the list and the page").
// Both read the server's SlackAdmin and draw it through slackView: the row's status, the page's badge, and a
// "connecting" that lasts too long, which both show as a problem with a next step instead of a wait.
import { useEffect } from 'react'
import { SLACK_CONNECTING_SLOW_S, type SlackAdmin } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import type { RowStatus } from '../components/integrations/ConnectorsView'

export type SlackTone = 'neutral' | 'ok' | 'warn' | 'danger'

export interface SlackView {
  /** the Connected apps row's status */
  row: RowStatus
  /** the page's badge */
  badge: { key: MessageKey; tone: SlackTone }
  /** connecting for too long: the whole minutes it has been (at least 2), else null */
  slowMinutes: number | null
}

/** Connecting this long (seconds) is a problem, not a wait */
export const slackSlow = (s: Pick<SlackAdmin, 'state' | 'connectingFor'>) =>
  s.state === 'connecting' && (s.connectingFor ?? 0) >= SLACK_CONNECTING_SLOW_S

export function slackView(s: SlackAdmin): SlackView {
  const slow = slackSlow(s)
  const slowMinutes = slow ? Math.max(2, Math.floor((s.connectingFor ?? 0) / 60)) : null
  const badge: SlackView['badge'] = s.state === 'off' ? { key: 'slack.state.off', tone: 'neutral' }
    : s.state === 'connected' ? { key: 'slack.state.connected', tone: 'ok' }
    : s.state === 'error' ? { key: 'slack.state.error', tone: 'danger' }
    : slow ? { key: 'slack.state.slow', tone: 'danger' }
    : { key: 'slack.state.connecting', tone: 'warn' }
  // removed in Slack (no tokens): Reconnect; turned off: Off; a problem or a wait that lasts: Needs attention
  const row: RowStatus = !s.tokens ? 'reconnect' : !s.enabled ? 'off'
    : s.state === 'error' || slow ? 'attention'
    : s.state === 'connecting' ? 'connecting'
    : 'on'
  return { row, badge, slowMinutes }
}

/** How often a screen showing Slack reads its state again while it is connecting: soon at first (it is usually up
 * within seconds), then now and then while it stays slow. */
export const SLACK_RECHECK_MS = 4000
export const SLACK_RECHECK_SLOW_MS = 30_000

/** Read Slack's state again while it is connecting, so the screen moves on to Connected (or to the problem line) by
 * itself instead of keeping the first answer. `reload` must be stable (useLoad's). */
export function useSlackRecheck(s: SlackAdmin | null | undefined, reload: () => unknown) {
  const connecting = s?.state === 'connecting' && !!s.tokens && s.enabled
  const slow = !!s && slackSlow(s)
  useEffect(() => {
    if (!connecting) return
    const id = setTimeout(() => { void reload() }, slow ? SLACK_RECHECK_SLOW_MS : SLACK_RECHECK_MS)
    return () => clearTimeout(id)
    // each new answer (s) schedules the next read
  }, [connecting, slow, s, reload])
}
