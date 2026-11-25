// One site rule for the team server and the desktop app's browser (shared/src/web-site.ts, tldts with the private
// section of the Public Suffix List): a site the server allows never covers more hosts on the desktop app
// (docs/decisions/20261125-one-site-always-desktop-browser.md, review of #577).
import { describe, expect, test } from 'bun:test'
import { siteOf } from '../../server/src/tools/url-gate'
import { registrableDomain, SitePermissions } from '../../desktop/src/common/site-permissions'
import { siteOfHost, siteToKeep } from '@mycel/shared/web-site'

const HOSTS = [
  'news.naver.com', 'naver.com', 'stock.naver.com', 'm.blog.naver.com', 'media.cnn.com', 'a.b.example.co.kr', 'shop.example.co.id',
  'x.alice.github.io', 'alice.github.io', 'attacker.lovable.app', 'myapp.run.app', 'svc-abc.a.run.app', 'space.hf.space',
  'bucket.s3.amazonaws.com', 'bucket.s3.ap-northeast-2.amazonaws.com', 'x.cdn.cloudflare.net', 'nas.synology.me', 'foo.eu.org',
  'proj.vercel.app', 'app.netlify.app', 'w.workers.dev', 'p.pages.dev', 'x.blogspot.com', 'blog.tistory.com', 'x.web.app',
  'sub.firebaseapp.com', 'x.herokuapp.com', 'x.azurewebsites.net', 'x.cloudfront.net', 'x.ngrok-free.app', 'x.trycloudflare.com',
  'a.b.c.example.com', 'etk.srail.kr', 'www.letskorail.com', 'finance.naver.com', 'example.gov.uk', 'x.example.gov.uk',
  'x.example.com.au', 'x.co.jp', 'x.example.co.jp', 'x.github.dev', 'x.ts.net', 'x.duckdns.org', 'x.supabase.co', 'x.r2.dev',
  'x.notion.site', 'x.myshopify.com', 'x.readthedocs.io', 'x.glitch.me', 'x.fly.dev',
]

describe('the server and the desktop app read one site for every host', () => {
  test.each(HOSTS)('%s', (host) => {
    const server = siteOf(`https://${host}/`)
    const desktop = registrableDomain(host)
    expect(server).toBe(siteOfHost(host))
    // the desktop app's site is the server's (or the host itself where the server has no site to allow)
    expect(desktop).toBe(server ?? host)
  })

  test('allowing the owner of a public suffix never covers its customers, on either side', () => {
    for (const suffix of ['lovable.app', 'eu.org', 'synology.me', 'run.app', 'hf.space', 's3.amazonaws.com', 'cdn.cloudflare.net', 'github.io']) {
      const p = new SitePermissions({ always: [suffix] })
      p.allowForTurn('t1', [suffix])
      const child = `attacker.${suffix}`
      expect(p.isAllowed('site', child, 't1')).toBe(false)
      expect(siteToKeep(child)).not.toBe(suffix)
      expect([child, null]).toContain(siteToKeep(child))
    }
  })

  test('the server\'s allowance holds on every port; the app\'s own answers stay per port', () => {
    const p = new SitePermissions()
    p.allowForTurn('t1', ['naver.com'], ['192.168.0.9'])
    expect(p.isAllowed('site', 'naver.com:8443', 't1')).toBe(true)
    expect(p.isAllowed('site', 'stock.naver.com:8443', 't1')).toBe(true)
    expect(p.isAllowed('private', '192.168.0.9:8080', 't1')).toBe(true)
    const q = new SitePermissions({ always: ['naver.com'] })
    expect(q.isAllowed('site', 'naver.com:8443')).toBe(false)
  })

  test('the site an Always keeps: none for a long or random name before the site', () => {
    expect(siteToKeep('stock.naver.com')).toBe('naver.com')
    expect(siteToKeep('stock.naver.com:8443')).toBe('naver.com')
    expect(siteToKeep('a'.repeat(20) + '.example.com')).toBeNull()
    expect(siteToKeep('x7f3k9q2m8z4w1v6b5n0.example.com')).toBeNull()
    expect(siteToKeep('192.168.0.1')).toBeNull()
    expect(siteToKeep('co.kr')).toBeNull()
  })
})
