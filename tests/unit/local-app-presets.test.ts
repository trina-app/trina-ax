import { describe, expect, test } from 'bun:test'
import { LOCAL_APP_PRESETS, LocalAppSpec, localCommandKey } from '../../shared/src/api/local-apps'
import { RECOMMENDABLE_TOOLS } from '../../shared/src/api/team-tools'

describe('the listed apps on the computer', () => {
  test('Playwright and Chrome DevTools run a pinned npx package that never stops at the install prompt', () => {
    for (const [id, pkg] of [['playwright', '@playwright/mcp@'], ['chrome-devtools', 'chrome-devtools-mcp@']] as const) {
      const p = LOCAL_APP_PRESETS.find((x) => x.id === id)!
      expect(LocalAppSpec.safeParse(p.spec).success).toBe(true)
      expect(p.spec).toMatchObject({ adapter: 'mcp', command: 'npx' })
      const args = (p.spec as { args: string[] }).args
      expect(args[0]).toBe('-y')
      // a version, never @latest or a range: the computer's one-time confirm covers this exact command
      expect(args[1]).toMatch(new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\d+\\.\\d+\\.\\d+$`))
      // npx is npx.cmd on Windows, and a .cmd does not start with shell: false
      expect(p.notOn).toEqual(['win32'])
      // their tools mark themselves read-only (readOnlyHint): no list of Trina's own
      expect(p.reads).toBeUndefined()
    }
  })

  test('every preset has its own id and command; Aside and ego lite run everywhere', () => {
    expect(new Set(LOCAL_APP_PRESETS.map((p) => p.id)).size).toBe(LOCAL_APP_PRESETS.length)
    expect(new Set(LOCAL_APP_PRESETS.map((p) => localCommandKey(p.spec))).size).toBe(LOCAL_APP_PRESETS.length)
    for (const id of ['aside', 'ego-lite']) expect(LOCAL_APP_PRESETS.find((p) => p.id === id)!.notOn).toBeUndefined()
  })

  test('a team may recommend each listed app', () => {
    for (const p of LOCAL_APP_PRESETS) expect(RECOMMENDABLE_TOOLS).toContain(p.id)
  })
})
