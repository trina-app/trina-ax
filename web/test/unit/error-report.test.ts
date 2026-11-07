// Browser errors for the error reports (lib/error-report.ts): only while the server says so, only the app's own code,
// and only the first part of the address.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { api } from '../../src/lib/api'
import { _resetErrorReportsForTest, reportableError, reportError, reportPage, setErrorReports } from '../../src/lib/error-report'

const O = 'https://acme.trina.app'
const own = (message: string, name = 'Error') => Object.assign(new Error(message), { name, stack: `${name}: ${message}\n    at f (https://acme.trina.app/assets/index-abc.js:1:2)` })

describe('error reports from the browser', () => {
  let call: ReturnType<typeof spyOn>
  beforeEach(() => {
    _resetErrorReportsForTest()
    call = spyOn(api, 'call').mockImplementation(mock(async () => undefined) as never)
  })
  afterEach(() => { call.mockRestore() })

  test('nothing is sent while the server has not said so', () => {
    reportError(own('boom'), '/files', O)
    expect(call).not.toHaveBeenCalled()
  })

  test('the type, message, stack and page are sent', () => {
    setErrorReports(true)
    reportError(own('boom', 'TypeError'), '/files/secret/plan.md', O)
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0] as unknown[])[1]).toMatchObject({ body: { type: 'TypeError', message: 'boom', page: '/files' } })
  })

  test('one error is sent once in a page load, and a page load sends at most ten', () => {
    setErrorReports(true)
    reportError(own('same'), '/', O); reportError(own('same'), '/', O)
    expect(call).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 30; i++) reportError(own(`e${i}`), '/', O)
    expect(call).toHaveBeenCalledTimes(10)
  })

  test('a failed report shows nothing and does not throw', async () => {
    call.mockImplementation((async () => { throw new Error('offline') }) as never)
    setErrorReports(true)
    expect(() => reportError(own('boom'), '/', O)).not.toThrow()
    await Bun.sleep(0)
  })
})

describe('what counts', () => {
  test("another site's code, an extension's own assets, a thrown string and a chunk that failed to load do not", () => {
    expect(reportableError(own('boom'), O)).toBe(true)
    expect(reportableError(Object.assign(new Error('x'), { stack: 'Error: x\n    at f (chrome-extension://abc/content.js:1:2)' }), O)).toBe(false)
    expect(reportableError(Object.assign(new Error('x'), { stack: 'Error: x\n    at f (chrome-extension://abc/assets/inject.js:1:2)' }), O)).toBe(false)
    expect(reportableError(Object.assign(new Error('x'), { stack: 'Error: x\n    at f (https://other.example/assets/a.js:1:2)' }), O)).toBe(false)
    expect(reportableError('text', O)).toBe(false)
    expect(reportableError(own('Failed to fetch dynamically imported module: https://acme.trina.app/assets/a.js'), O)).toBe(false)
  })
})

describe('the page', () => {
  test('only a plain first part of the address', () => {
    expect(reportPage('/')).toBe('/')
    expect(reportPage('/files')).toBe('/files')
    expect(reportPage('/files/view')).toBe('/files')
    expect(reportPage('/invite/SECRETTOKEN')).toBe('/invite')
    expect(reportPage('/홍길동')).toBe('/')
    expect(reportPage('/Some.File')).toBe('/')
  })
})
