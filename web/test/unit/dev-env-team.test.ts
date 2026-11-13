// Team settings › Dev environment (src/lib/dev-env-team.ts): the body of a save has only the changed fields (a change of
// network or limits stops every run), the warning is asked only when it is turned on with an older consent, and the
// limits stay inside the schema and the plan.
import { describe, expect, test } from 'bun:test'
import { DevEnvLimits, DevEnvTeamSetting, type DevEnvTeamResponse } from '@mycel/shared/api'
import { afterRefusedSave, clampLimit, draftOf, LIMIT_RANGE, limitMax, needsWarning, sitesOf, teamBody } from '../../src/lib/dev-env-team'

const setting = DevEnvTeamSetting.parse({})
const plan = { plan: 'starter', maxRunning: 1, cpus: 2, memoryMiB: 3072, pids: 1024, network: 'open' }
const srt = (s = setting): Pick<DevEnvTeamResponse, 'warningVersion' | 'setting' | 'plan'> => ({ warningVersion: 2, setting: s, plan })

describe('the dev environment of the team', () => {
  test('an unchanged form sends nothing; a site list is cleaned', () => {
    expect(teamBody(srt(), draftOf(setting), false)).toEqual({})
    expect(sitesOf(' API.example.com\n\n*.example.org, api.example.com ')).toEqual(['api.example.com', '*.example.org'])
    expect(teamBody(srt(), { ...draftOf(setting), sites: 'api.example.com' }, false)).toEqual({ extraDomains: ['api.example.com'] })
  })
  test('turning on: the warning is needed and sent only when accepted; a consent to the current version is not asked again', () => {
    const on = { ...draftOf(setting), enabled: true }
    expect(needsWarning(srt(), on)).toBe(true)
    expect(teamBody(srt(), on, false)).toEqual({ enabled: true })
    expect(teamBody(srt(), on, true)).toEqual({ enabled: true, acceptWarning: 2 })
    const agreed = { ...setting, consent: { by: null, at: new Date().toISOString(), warningVersion: 2 } }
    expect(needsWarning(srt(agreed), on)).toBe(false)
    // a consent to the warning of the removed box runner (version 1) does not count
    expect(needsWarning(srt({ ...setting, consent: { by: null, at: new Date().toISOString(), warningVersion: 1 } }), on)).toBe(true)
    expect(needsWarning(srt(), { enabled: false })).toBe(false)
  })
  test('a turn-on the server cannot run puts the switch back off; other refusals and edits stay', () => {
    const on = { ...draftOf(setting), enabled: true, sites: 'api.example.com' }
    expect(afterRefusedSave(on, setting, 'dev_env_unavailable')).toEqual({ ...on, enabled: false })
    expect(afterRefusedSave(on, setting, 'dev_env_warning')).toBe(on)
    expect(afterRefusedSave(on, setting, undefined)).toBe(on)
    expect(afterRefusedSave(draftOf(setting), setting, 'dev_env_unavailable')).toEqual(draftOf(setting))
  })
  test('who: the people chosen by name stay; "everyone" clears the lists', () => {
    const s = { ...setting, scope: { mode: 'selected' as const, groupIds: ['g1'], userIds: ['u1'] } }
    expect(teamBody(srt(s), { ...draftOf(s), groupIds: ['g1', 'g2'] }, false)).toEqual({ scope: { mode: 'selected', groupIds: ['g1', 'g2'], userIds: ['u1'] } })
    expect(teamBody(srt(s), { ...draftOf(s), mode: 'writers' }, false)).toEqual({ scope: { mode: 'writers', groupIds: [], userIds: [] } })
  })
  test('limits: only the changed ones, cut to the plan and the schema', () => {
    expect(teamBody(srt(), { ...draftOf(setting), memoryMiB: 9000, cpus: 1 }, false)).toEqual({ limits: { memoryMiB: 3072 } })
    expect(clampLimit('cpus', 0.1, plan)).toBe(0.25)
    expect(clampLimit('pids', Number.NaN, null)).toBe(64)
    expect(limitMax('memoryMiB', null)).toBe(8192)
    expect(limitMax('idleStopMin', plan)).toBe(240)
  })
  test('the ranges are the schema\'s', () => {
    for (const k of ['cpus', 'memoryMiB', 'pids', 'idleStopMin'] as const) {
      const r = LIMIT_RANGE[k]
      expect(DevEnvLimits.shape[k].safeParse(r.min).success).toBe(true)
      expect(DevEnvLimits.shape[k].safeParse(r.max).success).toBe(true)
      expect(DevEnvLimits.shape[k].safeParse(r.min - (r.int ? 1 : 0.01)).success).toBe(false)
      expect(DevEnvLimits.shape[k].safeParse(r.max + 1).success).toBe(false)
    }
  })
})
