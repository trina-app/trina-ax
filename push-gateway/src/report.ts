// The push gateway's error reports to Sentry (README.md "Error reports"). Off unless PUSH_GATEWAY_SENTRY_DSN is set.
// Reported: a crash, a send that threw (answered 500 internal), and Apple or Google refusing the gateway's OWN
// credentials (key, team, topic, service account), with the provider and a fixed reason code as tags. A dead device
// token is not reported: it is one phone, not an operator problem. An event never holds a device token, a payload, a
// key, a team key id or a client address (shared/src/sentry-report.ts builds it from the fields named here only).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { environmentName, reporterFromDsn, TAG_VALUE_RE, type ErrorReporter, type ReporterOptions } from '../../shared/src/sentry-report.ts'
import type { CredentialAlarm } from './fcm.ts'

export interface GatewayReports {
  reporter: ErrorReporter | null
  /** PUSH_GATEWAY_SENTRY_DSN is set but is not a Sentry key */
  invalid: boolean
  alarm?: CredentialAlarm
  failed?: (e: unknown) => void
}

const PROVIDER_NAME = { apns: 'APNs', fcm: 'FCM' } as const

/** release = push-gateway@<first 12 hex of the running file's sha256>: the exact build, with no number to keep up. */
export function buildId(file: string | undefined): string {
  try {
    return file ? createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12) : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function gatewayReportsFrom(env: Record<string, string | undefined>, o: Pick<ReporterOptions, 'fetch' | 'now'> & { build: string }): GatewayReports {
  const { reporter, invalid } = reporterFromDsn(env.PUSH_GATEWAY_SENTRY_DSN, {
    fetch: o.fetch,
    now: o.now,
    release: `push-gateway@${o.build}`,
    environment: environmentName(env.PUSH_GATEWAY_SENTRY_ENV),
    logger: 'push-gateway',
  })
  if (!reporter) return { reporter, invalid }
  return {
    reporter,
    invalid,
    alarm: (provider, reason) => {
      // the reason is a tag (the scrubber would cut a long code like InvalidProviderToken out of the message)
      const code = TAG_VALUE_RE.test(reason) ? reason : 'other'
      reporter.capture({ type: 'CredentialRejected', message: `${PROVIDER_NAME[provider]} refused the gateway's credentials`, tags: { provider, reason: code } })
    },
    // the error's class, its message (scrubbed) and its stack frames; the request is not passed here
    failed: (e) => {
      const err = e instanceof Error ? e : new Error('send failed')
      reporter.capture({ type: err.name, message: err.message, stack: err.stack })
    },
  }
}
