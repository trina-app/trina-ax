// Follow-ups of the dev environment in shared chats from the real-server QA (QA TC-4928, TC-4929): srt's proxy login
// never reaches what a command shows, and a shared chat's run lists no name of a folder some of its people may not
// open. Real srt runs are in tests/linux/srt-attack.ts (S14, S15).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hideProxyLogin } from '../../server/src/devenv/srt/proxy-login'
import { hideDeniedNames } from '../../server/src/devenv/srt/mounts'
import { viewAccess } from '../../server/src/devenv/srt/access'

// what srt 0.0.81 puts in a run's environment (sandbox-utils.js generateProxyEnvVars), with a made-up token
const TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const ENV = [
  `http_proxy=http://srt.ZW52:${TOKEN}@localhost:3128`, `HTTPS_PROXY=http://srt:${TOKEN}@localhost:3128`,
  `ALL_PROXY=socks5h://srt.Y3VybCAtcyBodHRwczovL3guZXhhbXBsZQ%3D%3D:${TOKEN}@localhost:1080`,
  'CLOUDSDK_PROXY_USERNAME=srt.ZW52', `CLOUDSDK_PROXY_PASSWORD=${TOKEN}`,
  `GIT_SSH_COMMAND=ssh -o ProxyCommand='socat - PROXY:localhost:%h:%p,proxyport=3128,proxyauth=srt.ZW52:${TOKEN}'`,
  `SRT_SSH_PROXY_COMMAND=... printf "CONNECT %s HTTP/1.1\\r\\nProxy-Authorization: Basic ${Buffer.from(`srt.ZW52:${TOKEN}`).toString('base64')}\\r\\n"`,
  'PATH=/usr/bin:/bin', 'a commit 0f1e2d3c4b5a69788796a5b4c3d2e1f0 stays',
].join('\n')

describe('srt\'s proxy login in what a command shows (TC-4928)', () => {
  test('every form of it is hidden; other text, a lone hex string included, stays', () => {
    const out = hideProxyLogin(ENV)
    expect(out).not.toContain(`:${TOKEN}@`)
    expect(out).not.toContain(`PASSWORD=${TOKEN}`)
    expect(out).not.toContain(`proxyauth=srt.ZW52:${TOKEN}`)
    expect(out).not.toContain(Buffer.from(`srt.ZW52:${TOKEN}`).toString('base64'))
    expect(out).toContain('http_proxy=http://srt.ZW52:<hidden>@localhost:3128')
    expect(out).toContain('CLOUDSDK_PROXY_USERNAME=srt.ZW52')
    expect(out).toContain('PATH=/usr/bin:/bin')
    expect(out).toContain(`a commit ${TOKEN} stays`)
  })
})

describe('names of folders some people may not open (TC-4929)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mounts-'))
  for (const d of ['shared/hr-ONLYALICE', 'shared/docs', 'shared/hr-ONLYALICE/open']) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'shared/glossary.md'), 'x')
  fs.symlinkSync('/etc', path.join(root, 'shared/link'))
  test('a read-only folder holding a denied one is given entry by entry, the denied one left out', () => {
    const v = hideDeniedNames({ read: ['shared'], write: [], denyRead: ['shared/hr-ONLYALICE'], denyWrite: [] }, root)
    expect(v.read.sort()).toEqual(['shared/docs', 'shared/glossary.md'])
    expect(v.denyRead).toEqual([])
    // the same access for what is there; the denied folder and the link are not there at all
    expect(viewAccess(v, 'shared/docs/a.md')).toBe('read')
    expect(viewAccess(v, 'shared/hr-ONLYALICE/x')).toBe('none')
    expect(viewAccess(v, 'shared/link')).toBe('none')
  })
  test('a deeper folder everyone may read inside the denied one stays given', () => {
    const v = hideDeniedNames({ read: ['shared', 'shared/hr-ONLYALICE/open'], write: [], denyRead: ['shared/hr-ONLYALICE'], denyWrite: [] }, root)
    expect(v.read).toContain('shared/hr-ONLYALICE/open')
    expect(v.read).not.toContain('shared')
  })
  test('a view with nothing denied inside is unchanged; a writable folder is never given entry by entry', () => {
    const plain = { read: ['shared'], write: [], denyRead: [], denyWrite: [] }
    expect(hideDeniedNames(plain, root)).toEqual(plain)
    const w = { read: [], write: ['shared'], denyRead: ['shared/hr-ONLYALICE'], denyWrite: [] }
    expect(hideDeniedNames(w, root)).toEqual(w)
  })
})
