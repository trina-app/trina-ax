// Why the desktop app's pair page (pair.ts) got no code, and the plain sentence for each (B in the 2026-11-28 Chrome
// QA: every failure read "the desktop app is not running"). Pure: tests/unit/chrome-ext-pair-errors.test.ts.
import type { MessageKey } from './messages'

/** why the page got no code: the app's or the helper's answer, or what Chrome said when it could not start the helper */
export type PairFailure = 'app_not_running' | 'no_answer' | 'bad_nonce' | 'no_team' | 'refused' | 'no_host' | 'not_accepted' | 'helper_failed'

/** Chrome's own error when the helper cannot be used (chrome.runtime.lastError messages, stable across versions):
 * no manifest for this browser (no desktop app, an older one, or it never ran here), our id not in its allowed_origins
 * (an unpacked copy with a release app, or an app older than this store item), or the helper died. */
export function nativeFailure(message: string): PairFailure {
  if (/forbidden/i.test(message)) return 'not_accepted'
  if (/exited|communicating|crash/i.test(message)) return 'helper_failed'
  return 'no_host'
}

/** the sentence for each reason, in plain words */
export const FAILURE_TEXT: Record<PairFailure, MessageKey> = {
  app_not_running: 'pairAppNoApp',
  no_answer: 'pairAppNoAnswer',
  bad_nonce: 'pairAppExpired',
  no_team: 'pairAppNoTeam',
  refused: 'pairAppRefused',
  no_host: 'pairAppNoHost',
  not_accepted: 'pairAppNotAccepted',
  helper_failed: 'pairAppHelperFailed',
}
