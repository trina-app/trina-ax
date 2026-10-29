import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const exec = promisify(execFile)

test('native frame guard covers document start and lets all worker kinds start without a second debugger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtc-native-'))
  try {
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/rtc-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const { stdout } = await exec(electron, [output], { env: { ...process.env, RTC_TEST_PROFILE: join(dir, 'profile') }, timeout: 30_000 })
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('RTC_RESULT '))!.slice(11))
    for (const key of ['oopif','oopif-nested','late','late-nested','blank','srcdoc','blob','data','dedicated','shared','service']) {
      expect(result.reports[key].rtc, key).toBe('undefined')
    }
    for (const key of ['oopif','oopif-nested','late','late-nested','srcdoc','blob','data']) {
      expect(result.reports[key].media, key).toBe('undefined')
      expect(result.reports[key].data, key).toBe('undefined')
    }
    expect(result.reports.top.rtc).toBe('function')
    expect(result.reports.popup.denied).toBe(true)
    expect(result.attached).toContain('iframe')
    expect(result.attached).toContain('worker')
    expect(result.attached).not.toContain('service_worker')
    expect(result.attached).not.toContain('shared_worker')
    expect(result.pageCommands.every((type: string) => type === 'page' || type === 'iframe')).toBe(true)
    const top = result.frames[0].processId
    expect(result.frames.some((frame: any) => frame.url.includes('/child?') && frame.processId !== top)).toBe(true)
    console.log('native RTC coverage:', JSON.stringify(result))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
