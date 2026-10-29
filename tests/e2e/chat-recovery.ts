// Real browser + real chat/file services, launcher and MCP bridge; only the model is scripted.
// Build web first, then: TMPDIR=/private/tmp MYCEL_WORK=/private/tmp/q4cr bun tests/e2e/chat-recovery.ts
// The reviewed draft includes an explicit fake-engine write directive, so this does not claim model-quality coverage.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, testSessions } from '../lib/b-harness'
import { translate } from '../../web/src/i18n'

const fake = (...steps: unknown[]) => steps.map(step => '@fake ' + JSON.stringify(step)).join('\n')
function fileTree(dir: string): string[] {
  // This fixture includes deliberately unreadable directories and symlinks; never follow those links.
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return []
    throw error
  }
  return entries.flatMap(entry => [entry.name, ...(entry.isDirectory() ? fileTree(path.join(dir, entry.name)).map(child => `${entry.name}/${child}`) : [])]).sort()
}
const h = await startHarness({ name: 'recovery', turnTimeoutMs: 30_000 })
const browser = await chromium.launch({ headless: true }).catch(async error => { await h.close(); throw error })
try {
  // The older tool fixture uses short group IDs; the browser's Me contract requires UUIDv7 IDs.
  for (const group of h.ctx.db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]) {
    const id = uuidv7()
    h.ctx.db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(id, `${group.name} browser`)
    h.ctx.db.query('UPDATE group_members SET group_id = ? WHERE group_id = ?').run(id, group.id)
    h.ctx.db.query("UPDATE folder_rules SET subject_id = ? WHERE subject_type = 'group' AND subject_id = ?").run(id, group.id)
    h.ctx.db.query('DELETE FROM groups WHERE id = ?').run(group.id)
  }
  // An ordinary team folder is readable but not writable by any of these three members.
  const source = 'shared/edit-me.md'
  const original = fs.readFileSync(path.join(h.team, source), 'utf8')
  h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE folder_id = 'f_shared'").run()
  for (const [user, locale] of [['alice', 'en'], ['bob', 'ko'], ['erin', 'id']] as const) {
    // The harness authenticates requests by header; /api/me also needs its matching session row.
    const auth = await testSessions.resolve(new Request(h.url, { headers: { 'x-test-user': user } }), { ip: '127.0.0.1', via: 'test' })
    const now = new Date().toISOString()
    h.ctx.db.query('INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(auth!.session.id, user, `recovery-test-${user}`, 'web', now, now, new Date(Date.now() + 3600_000).toISOString())
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-test-user': user }, viewport: { width: 1360, height: 860 } })
    try {
      const page = await context.newPage()
      const chat = await h.api(user).call(API.createChat, { body: {} })
      await page.goto(`${h.url}/c/${chat.id}`)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      const input = page.getByTestId('composer-input')
      await input.fill(fake(
        { tool: 'read', args: { file_path: source } },
        { tool: 'edit', args: { file_path: source, old_string: 'DRAFT', new_string: 'FINAL' } },
        { say: 'Edit attempted.' },
      ))
      await page.getByTestId('send').click()
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
      const stored = await h.api(user).call(API.listMessages, { params: { id: chat.id } })
      const answer = stored.items.find(m => m.role === 'assistant')!
      expect(answer.steps.map(s => [s.tool, s.status])).toEqual([['read', 'ok'], ['edit', 'error']])
      expect(answer.files?.rejected).toHaveLength(1)
      expect(answer.files!.rejected[0]!.reason).toMatch(/read.only/i)
      expect(fs.readFileSync(path.join(h.team, source), 'utf8')).toBe(original)

      const summary = page.getByTestId('file-summary')
      await summary.getByRole('button').first().click()
      await expect(summary).not.toContainText(answer.files!.rejected[0]!.reason)
      const counts = () => ({
        messages: h.ctx.db.query('SELECT COUNT(*) n FROM messages WHERE chat_id = ?').get(chat.id),
        turns: h.ctx.db.query('SELECT COUNT(*) n FROM turns WHERE chat_id = ?').get(chat.id),
        events: h.ctx.db.query('SELECT COUNT(*) n FROM file_events').get(),
        files: fileTree(h.team),
      })
      const before = counts()
      const requests: string[] = []
      page.on('request', req => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) requests.push(req.url()) })
      const request = translate(locale, 'files.summary.askOwnFolderPrompt', { path: source, folder: `users/${user}` })
      const retry = summary.getByRole('button', { name: translate(locale, 'files.summary.askOwnFolder'), exact: true })
      await retry.click()
      await expect(input).toHaveValue(request)
      await expect(input).toBeFocused()
      await retry.click()
      await expect(input).toHaveValue(request)
      // Give any accidental async send time to reach the real server before comparing persistent state.
      await page.waitForTimeout(500)
      expect(counts()).toEqual(before)
      expect(requests).toEqual([])
      expect(fs.readFileSync(path.join(h.team, source), 'utf8')).toBe(original)
      await expect(page.getByTestId('user-message')).toHaveCount(1)
      await expect(page.getByTestId('assistant-message')).toHaveCount(1)

      const destination = `users/${user}/recovered.md`
      const content = original.replace('DRAFT', 'FINAL')
      // Explicitly review/edit, then Send. This deterministic model directive calls the real write tool.
      await input.fill(request + '\n' + fake({ tool: 'write', args: { file_path: destination, content } }, { say: 'Saved in my folder.' }))
      await page.getByTestId('send').click()
      await expect(page.getByTestId('user-message')).toHaveCount(2)
      await expect(page.getByTestId('assistant-message')).toHaveCount(2)
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
      const recovered = await h.api(user).call(API.listMessages, { params: { id: chat.id } })
      expect(recovered.items).toHaveLength(4)
      expect(recovered.items.some(m => m.files?.saved.some(f => f.path === destination))).toBe(true)
      expect(fs.readFileSync(path.join(h.team, destination), 'utf8')).toBe(content)
      expect(fs.readFileSync(path.join(h.team, source), 'utf8')).toBe(original)
      expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns WHERE chat_id = ?').get(chat.id)).toEqual({ n: 2 })
      console.log(`PASS ${locale}: real edit rejection → reviewable draft → explicit Send → private file; source unchanged`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
  await h.close()
}
