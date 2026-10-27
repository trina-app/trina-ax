// Writes shared/src/cloud-protocol/vectors/vectors.json from shared/src/cloud-protocol/vectors.ts (deterministic).
// tests/unit/cloud-protocol.test.ts fails when the committed file is out of date: run this and commit the result.
import fs from 'node:fs'
import path from 'node:path'
import { buildVectors } from '../shared/src/cloud-protocol/vectors.ts'

export const VECTORS_FILE = path.resolve(import.meta.dir, '..', 'shared', 'src', 'cloud-protocol', 'vectors', 'vectors.json')
export const vectorsText = () => JSON.stringify(buildVectors(), null, 1) + '\n'

if (import.meta.main) {
  fs.writeFileSync(VECTORS_FILE, vectorsText())
  console.log(`wrote ${VECTORS_FILE}`)
}
