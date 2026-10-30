import { afterAll, beforeAll, expect, test, spyOn, setDefaultTimeout } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
setDefaultTimeout(30_000)
let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'safe-images-engines' })
  h.ctx.files.cfg.ocr = null
  fs.writeFileSync(path.join(h.team, 'users/alice/image.png'), 'synthetic')
  process.env.MYCEL_SAFE_OPS_1A = '1'
})
afterAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  await h.close()
})
for (const engine of ['claude-code', 'codex'] as const)
  test(engine + ' fake engine receives the image through gate/bridge/socket', async () => {
    const codec = spyOn(h.ctx.files, 'modelImage').mockResolvedValue(Buffer.from([255, 216, 255, 217]))
    const ws = await h.ws('alice')
    await ws.next('hello')
    try {
      const chat = await h.api('alice').call(API.createChat, { body: { engine } })
      const r = await h
        .api('alice')
        .call(API.sendMessage, {
          params: { id: chat.id },
          body: {
            content:
              '@fake ' +
              JSON.stringify({
                tool: 'read',
                args: { file_path: 'users/alice/image.png' },
                expectImage: true,
                sayResult: true,
              }),
            clientMessageId: crypto.randomUUID(),
            attachmentIds: [],
          },
        })
      const done = await ws.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20000)
      expect(done.data.message.content).toContain('IMAGE_BLOCK_OK:image/jpeg')
    } finally {
      ws.close()
      codec.mockRestore()
    }
  })
