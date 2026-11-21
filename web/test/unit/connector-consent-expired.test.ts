// The consent page's plain line for a request that expired or another login session opened (QA TC-2970): only the
// server's 404 with reason request_expired; a real no access keeps its own message.
import { expect, test } from 'bun:test'
import { ApiError } from '@mycel/shared/api'
import { consentExpired } from '../../src/pages/ConnectorConsent'

const error = (status: number, code: string, params?: Record<string, string>) => new ApiError(status, { code, message: 'Not found or no access.', ...(params ? { params } : {}) } as never)

test('only the request_expired 404 is an expired request', () => {
  expect(consentExpired(error(404, 'not_found', { reason: 'request_expired' }))).toBe(true)
  expect(consentExpired(error(404, 'not_found'))).toBe(false)
  expect(consentExpired(error(403, 'forbidden', { reason: 'request_expired' }))).toBe(false)
  expect(consentExpired(new Error('offline'))).toBe(false)
})
