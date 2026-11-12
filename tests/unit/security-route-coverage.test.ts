// Every route the server registers has a case in the permanent permission matrix (tests/security/permission-matrix.test.ts,
// which boots a server and is not part of CI), and no case names a route that is gone. This half needs no server, so it
// runs with the unit tests: a new route without a matrix case fails CI here (tests/security/lib/coverage.ts).
import { expect, test } from 'bun:test'
import path from 'node:path'
import { routeCoverage } from '../security/lib/coverage'

const REPO = path.resolve(import.meta.dir, '..', '..')

test('every route in server/src/routes/*.ts has a permission matrix case (tests/security/lib/*cases.ts)', () => {
  const { missing } = routeCoverage(REPO)
  expect(missing, `routes with no matrix case: ${missing.join(', ')}; add one to tests/security/lib/ (who may call it, aimed at something the wrong person must not reach)`).toEqual([])
})

test('no permission matrix case names a route the code does not register', () => {
  const { extra } = routeCoverage(REPO)
  expect(extra, `cases for unregistered routes: ${extra.join(', ')}`).toEqual([])
})
