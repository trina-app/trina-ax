import { expect, test } from 'bun:test'
import { parseP2Args, p2WorkerEnvironment } from '../linux/p2-smoke'

test('CLI default is read-only check with no live request budget', () => {
  expect(parseP2Args([])).toEqual({ command: 'check', values: {} })
  expect(() => parseP2Args(['execute'])).toThrow('P2_ARGUMENTS')
})
test('explicit execute requires run ID and numeric request cap', () => {
  const id = '10000000-0000-4000-8000-000000000001'
  expect(parseP2Args(['execute', '--run-id', id, '--provider-requests', '20']).values['provider-requests']).toBe('20')
  for (const cap of ['0', '-1', '1e3', '2.5', 'NaN', '9007199254740992']) expect(() => parseP2Args(['execute', '--run-id', id, '--provider-requests', cap])).toThrow()
  expect(() => parseP2Args(['execute', '--run-id', id, '--provider-requests', '20', '--provider-requests', '40'])).toThrow()
  expect(() => parseP2Args(['check', '--execute', 'yes'])).toThrow()
})
test('root attestation has no default budget, identities, model or expiry', () => {
  expect(() => parseP2Args(['attest'])).toThrow()
  expect(() => parseP2Args(['attest', '--key', 'never-accepted'])).toThrow()
})
test('worker environment contains only fixed non-secret values and production scheduler mode', () => {
  const e = p2WorkerEnvironment()
  expect(e.NODE_ENV).toBe('production')
  expect(e.HOME).toBe('/var/lib/mycel-p2-smoke/data')
  expect(Object.keys(e).sort()).toEqual(['HOME', 'LANG', 'MYCEL_INSTALL_BASE', 'MYCEL_LABEL', 'NODE_ENV', 'PATH', 'TZ'])
})
