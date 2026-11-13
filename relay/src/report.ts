// The relay's error reports to Sentry (relay/deploy/README.md "Error reports and check-ins"). Off unless RELAY_SENTRY_DSN
// is set in /etc/mycel-relay/relay.env. Reported: a crash (uncaught exception, unhandled rejection) and every error
// line of the relay log. From a log line only the event name and the `error` field are read, and the message is
// scrubbed again (shared/src/sentry-report.ts): the relay log already never holds addresses, paths or headers
// (log.ts FORBIDDEN_LOG_FIELDS), and a report holds even less.
import { reporterFromDsn, environmentName, TAG_VALUE_RE, type ErrorInput, type ErrorReporter, type ReporterOptions } from '@mycel/shared/sentry-report'
import type { LogFields } from './log.ts'
import { RELAY_VERSION } from './relay.ts'

export interface RelayReports {
  reporter: ErrorReporter | null
  /** RELAY_SENTRY_DSN is set but is not a Sentry key */
  invalid: boolean
}

/** The reporter from the relay's environment: RELAY_SENTRY_DSN, RELAY_SENTRY_ENV (default production) and
 *  RELAY_INSTANCE (a or b, set by mycel-relay@.service). */
export function relayReportsFrom(env: Record<string, string | undefined>, o: Pick<ReporterOptions, 'fetch' | 'now'> = {}): RelayReports {
  const instance = env.RELAY_INSTANCE?.trim()
  return reporterFromDsn(env.RELAY_SENTRY_DSN, {
    ...o,
    release: `relay@${RELAY_VERSION}`,
    environment: environmentName(env.RELAY_SENTRY_ENV),
    logger: 'relay',
    tags: instance && /^[a-z0-9-]{1,16}$/.test(instance) ? { instance } : {},
  })
}

/** A relay error line as a report: the event name (a code written in the relay, e.g. ops_keys_unusable) and the
 *  `error` field (an error code or message), nothing else. */
export function logLineInput(ev: string, fields: LogFields): ErrorInput {
  const error = typeof fields.error === 'string' ? fields.error : ''
  return {
    type: 'RelayError',
    message: error ? `${ev}: ${error}` : ev,
    tags: TAG_VALUE_RE.test(ev) ? { log_event: ev } : {},
  }
}
