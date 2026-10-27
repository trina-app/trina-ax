import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { harness, testConfig } from './a-lib'
import { DRIVE_CONFIG } from '../lib/fake-google-drive'
import { DRIVE_TOOL_NAMES } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'

test('a private provider config registers all three Drive tools in both MCP and turn paths without a provider request', async () => {
  const name = 'drive-registration', cfg = testConfig(name)
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const dir = path.join(path.dirname(cfg.dataDir), 'secrets/integrations/google-drive')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(DRIVE_CONFIG), { mode: 0o600 })
  const h = await harness(name, {}, { reuse: true })
  try {
    for (const tool of DRIVE_TOOL_NAMES) {
      expect(toolRegistry(h.ctx.files).has(tool)).toBe(true)
      expect(h.ctx.services.turnTools?.some(t => t.name === tool)).toBe(true)
    }
    expect(fs.existsSync(path.join(dir, 'credentials.key'))).toBe(false)
  } finally { await h.close() }
})
