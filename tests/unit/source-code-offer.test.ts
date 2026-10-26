import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { sourceCodeLink } from '@mycel/shared'
import { AppConfigFile, loadAppConfig } from '../../server/src/app-config'
import { harness, withOwner } from './a-lib'
import { WORK } from '../lib/env'
import { directFetch } from '../../server/src/http/tunnel'
import { parseEnvFile, serverConfig, settingsFrom, settingsText } from '../../server/src/office/settings'

const release = { version: '0.3.1-review', url: 'https://source.example.test/releases/0.3.1-review/source.tar.gz' }
const sourceCode = { requestEmail: 'source@example.test', release }

test('a repository root is never presented as version-specific source when the version is absent or invalid', () => {
  const published = { repository: 'https://github.com/example/reviewed', published: true, requestEmail: 'source@example.test' }
  for (const version of [null, undefined, '', '../main', 'bad<script>']) expect(sourceCodeLink(version, published).kind).toBe('request')
  expect(sourceCodeLink(release.version, published)).toEqual({ href: 'https://github.com/example/reviewed/tree/v0.3.1-review', kind: 'tag' })
})

test('operator source metadata survives installed server configuration loading', () => {
  fs.mkdirSync(WORK, { recursive: true })
  const dir = fs.mkdtempSync(path.join(WORK, 'source-config-')), file = path.join(dir, 'server.json')
  try {
    fs.writeFileSync(file, JSON.stringify({ sourceCode }))
    expect(loadAppConfig({ argv: ['--config', file], env: {} }).sourceCode).toEqual(sourceCode)
    expect(AppConfigFile.parse({}).sourceCode).toBeUndefined()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('source configuration rejects partial release pairs and unsafe URLs without opening any network connection', () => {
  for (const release of [{ version: '0.3.1' }, { url: sourceCode.release.url }, { version: '../main', url: sourceCode.release.url }]) {
    expect(AppConfigFile.safeParse({ sourceCode: { release } }).success).toBe(false)
  }
  for (const url of [
    'http://source.example.test/source.zip', 'javascript:alert(1)', '//source.example.test/source.zip',
    'https://user:password@source.example.test/source.zip', 'https://source.example.test/source.zip?token=private',
    'https://source.example.test/source.zip#secret', 'https://source.example.test/a/../source.zip',
    'https://source.example.test/a/%2e%2e/source.zip', 'https://source.example.test/a/%252e%252e/source.zip',
    'https://source.example.test/a%2f..%2fsource.zip', 'https://source.example.test/a%5csource.zip',
    'https://source.example.test/source.zip\n', 'https://source.example.test/%00source.zip',
    'https://source.example.test/' + 'a'.repeat(2048),
  ]) expect(AppConfigFile.safeParse({ sourceCode: { release: { version: '0.3.1', url } } }).success).toBe(false)
})

test('source requests accept one mailbox only, without headers or additional recipients', () => {
  for (const requestEmail of ['a@example.test,b@example.test', 'a@example.test;b@example.test', 'a@example.test?bcc=b@example.test', 'a@example.test\r\nBcc:b@example.test', 'Name <a@example.test>', 'a@example.test%0abcc=b@example.test', 'a%0d%0abcc@example.test', 'a#fragment@example.test', 'a&bcc=b@example.test', '', 'a'.repeat(255) + '@example.test']) {
    expect(AppConfigFile.safeParse({ sourceCode: { requestEmail } }).success).toBe(false)
  }
  const requestEmail = 'source+review@example.test'
  expect(AppConfigFile.safeParse({ sourceCode: { requestEmail } }).success).toBe(true)
  const link = new URL(sourceCodeLink(release.version, { repository: '', published: false, requestEmail }).href)
  expect(link.pathname).toBe(requestEmail)
  expect(link.hash).toBe('')
  expect([...link.searchParams.keys()]).toEqual(['subject'])
})

test('office source settings survive supervisor regeneration and office.env rewrites, with the same validation', () => {
  const home = path.join(WORK, 'source-office')
  const env = { TEAMAX_SOURCE_REQUEST_EMAIL: sourceCode.requestEmail, TEAMAX_SOURCE_VERSION: release.version, TEAMAX_SOURCE_URL: release.url }
  const loaded = settingsFrom(home, env)
  const rewritten = settingsFrom(home, parseEnvFile(settingsText(loaded)))
  expect(serverConfig(rewritten, { dns: ['mini.local'], ips: ['127.0.0.1'] }).sourceCode).toEqual(sourceCode)
  expect(serverConfig(settingsFrom(home, {}), { dns: [], ips: [] }).sourceCode).toBeUndefined()
  expect(() => settingsFrom(home, { TEAMAX_SOURCE_VERSION: release.version })).toThrow()
  expect(() => settingsFrom(home, { ...env, TEAMAX_SOURCE_URL: 'http://source.example.test/file' })).toThrow()
  expect(() => settingsFrom(home, { TEAMAX_SOURCE_REQUEST_EMAIL: 'a#fragment@example.test' })).toThrow()
})

test('health exposes an operator download only for the running version and keeps the request address separate', async () => {
  const h = await harness('source-offer', { sourceCode })
  try {
    h.ctx.version = release.version
    const owner = await withOwner(h)
    const health = async () => (await h.fetch('/api/health', { headers: { cookie: owner.cookie! } })).json()
    expect((await health()).sourceCode).toEqual({ requestEmail: sourceCode.requestEmail, download: release })
    h.ctx.version = '0.3.2-review'
    expect((await health()).sourceCode).toEqual({ requestEmail: sourceCode.requestEmail, download: null })
    delete h.ctx.config.sourceCode
    const fallback = (await health()).sourceCode
    expect(fallback.download).toBeNull()
    expect(fallback.requestEmail).toBeTruthy()
    expect(JSON.stringify(fallback)).not.toContain('github.com/potenlab/team-ax')
  } finally { await h.close() }
})

test('anonymous office tunnel health remains liveness-only even with configured source metadata', async () => {
  const host = 'office.example.test'
  const h = await harness('source-tunnel', { sourceCode, office: true, listen: { host: '127.0.0.1', port: 47830 }, tunnel: { host, allowFrom: [], countries: [] } })
  try {
    h.ctx.version = release.version
    const serve = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), ip => ip ?? null)
    const response = await serve(new Request(`http://${host}/api/health`, { headers: { host } }), { requestIP: () => ({ address: '127.0.0.1' }), port: 47830 })
    expect(response.status).toBe(200)
    expect(Object.keys(await response.json()).sort()).toEqual(['ok', 'time'])
  } finally { await h.close() }
})
