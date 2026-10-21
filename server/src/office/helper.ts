// Office mode's plain-HTTP helper page (docs/OFFICE.md), on the office network next to the TLS port (lanPort - 1 by
// default). A desk that does not trust the office CA yet cannot open the https address, so this page is where it
// gets the CA: the certificate as .cer (Windows) and .crt (Mac, phones), its fingerprints to compare, the steps per
// device, and the https address to open afterwards.
//
// It serves exactly three paths (GET / HEAD): /, /ca.cer, /ca.crt. Everything else is 404: no API, no redirect, no
// proxy to the server, nothing taken from the request (Host, query) into the page. The page has no script.
import { PRODUCT } from '@mycel/shared'

export interface HelperState {
  /** CA certificate, PEM and DER */
  caPem: string
  caDer: Uint8Array<ArrayBuffer>
  /** "AB:CD:..." */
  sha256: string
  sha1: string
  /** https addresses for the desks, best first */
  origins: string[]
  caName: string
}

export const HELPER_PATHS = ['/', '/ca.cer', '/ca.crt'] as const

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
}

export function helperFetch(req: Request, s: HelperState): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } })
  let p: string
  try { p = new URL(req.url).pathname } catch { p = '' }
  const file = PRODUCT.displayName.replace(/\s+/g, '') + '-office-CA'
  switch (p) {
    case '/':
      return new Response(helperPage(s), {
        headers: {
          ...HEADERS, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-frame-options': 'DENY',
        },
      })
    case '/ca.cer':
      return new Response(s.caDer, { headers: { ...HEADERS, 'content-type': 'application/pkix-cert', 'content-disposition': `attachment; filename="${file}.cer"` } })
    case '/ca.crt':
      return new Response(s.caPem, { headers: { ...HEADERS, 'content-type': 'application/x-x509-ca-cert', 'content-disposition': `attachment; filename="${file}.crt"` } })
    default:
      return new Response('Not found\n', { status: 404, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } })
  }
}

export function helperPage(s: HelperState): string {
  const main = s.origins[0] ?? ''
  const links = s.origins.map((o) => `<li><a href="${esc(o)}/">${esc(o)}</a></li>`).join('')
  const fp = `<dl class="fp"><dt>SHA-256</dt><dd><code>${esc(s.sha256)}</code></dd><dt>SHA-1 (Windows “지문 / Thumbprint”)</dt><dd><code>${esc(s.sha1)}</code></dd></dl>`
  const name = PRODUCT.displayName
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — 처음 연결 / First connection</title>
<style>
:root{color-scheme:light dark;--fg:#1d2420;--muted:#5b6660;--bg:#faf9f6;--card:#fff;--line:#dfe3df;--accent:#2c6a59}
@media (prefers-color-scheme:dark){:root{--fg:#e8ece9;--muted:#a3ada7;--bg:#141816;--card:#1c211e;--line:#2d3430;--accent:#7cc4ad}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}h3{font-size:1rem;margin:1.25rem 0 .25rem}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}
a{color:var(--accent)}.btn{display:inline-block;padding:.6rem 1rem;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:.25rem .5rem .25rem 0}
@media (prefers-color-scheme:dark){.btn{color:#10201a}}
code{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;word-break:break-all}.fp dt{color:var(--muted);font-size:.85rem;margin-top:.5rem}.fp dd{margin:0}
ol{padding-left:1.4rem}li{margin:.3rem 0}.muted{color:var(--muted);font-size:.9rem}hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
</style></head><body><main>
<h1>${esc(name)} — 처음 연결하기</h1>
<p>이 컴퓨터가 ${esc(name)} 서버(사무실의 맥)를 안전하게 알아보도록 <b>인증서를 한 번만</b> 설치합니다. 그다음부터는 아래 https 주소로 접속합니다.</p>
<section>
<p><a class="btn" href="/ca.cer">윈도우용 인증서 받기 (.cer)</a><a class="btn" href="/ca.crt">맥·아이폰·안드로이드용 (.crt)</a></p>
<p class="muted">인증서 이름: ${esc(s.caName)}. 설치 중에 보이는 지문이 아래 값과 같아야 합니다. 다르면 설치하지 말고 관리자에게 알려 주세요.</p>
${fp}
</section>
<h2>윈도우 (Edge·Chrome)</h2>
<ol>
<li>위의 <b>윈도우용 인증서 받기</b>를 누르고, 받은 파일을 엽니다(더블클릭).</li>
<li><b>인증서 설치…</b> → 저장소 위치 <b>로컬 컴퓨터</b>(이 PC의 모든 사용자, 관리자 암호 필요) 또는 <b>현재 사용자</b> → 다음.</li>
<li><b>모든 인증서를 다음 저장소에 저장</b> → 찾아보기 → <b>신뢰할 수 있는 루트 인증 기관</b> → 확인 → 다음 → 마침.</li>
<li>보안 경고 창의 <b>지문(sha1)</b>이 위의 SHA-1 값과 같은지 확인하고 <b>예</b>를 누릅니다.</li>
<li>Edge(또는 Chrome)를 모두 닫았다가 다시 열고 <a href="${esc(main)}/">${esc(main)}</a> 에 접속합니다.</li>
<li>바탕화면 아이콘: Edge 오른쪽 위 <b>⋯</b> → <b>앱</b> → <b>이 사이트를 앱으로 설치</b>. (Chrome: <b>⋮</b> → <b>전송, 저장, 공유</b> → <b>페이지를 앱으로 설치</b>)</li>
</ol>
<h2>맥</h2>
<ol><li><b>.crt</b>를 받아 더블클릭 → 키체인 접근에 추가(로그인).</li><li>키체인 접근에서 인증서를 두 번 클릭 → <b>신뢰</b> → “이 인증서 사용 시” <b>항상 신뢰</b> → 창을 닫고 암호 입력.</li><li>Safari·Chrome으로 https 주소에 접속합니다.</li></ol>
<h2>아이폰·아이패드</h2>
<ol><li>Safari로 이 페이지를 열고 <b>.crt</b>를 받습니다 → “프로파일이 다운로드됨”.</li><li>설정 → <b>다운로드된 프로파일</b> → 설치.</li><li>설정 → 일반 → 정보 → <b>인증서 신뢰 설정</b> → ${esc(name)} 인증서를 켭니다.</li></ol>
<h2>안드로이드</h2>
<ol><li><b>.crt</b>를 받습니다.</li><li>설정 → 보안(및 개인정보 보호) → 기타 보안 설정 → <b>암호화 및 사용자 인증 정보</b> → 인증서 설치 → <b>CA 인증서</b> → 받은 파일 선택.</li><li>Chrome으로 https 주소에 접속합니다.</li></ol>
<section><h3>접속 주소</h3><ul>${links}</ul>
<p class="muted">주소가 바뀌었으면 관리자가 서버 맥에서 <code>~/TeamAX/teamax info</code>로 새 주소를 확인합니다. 인증서는 다시 설치하지 않아도 됩니다.</p></section>
<hr>
<h1 lang="en">First connection (English)</h1>
<div lang="en">
<p>Install the office certificate <b>once</b> so this computer can recognise the ${esc(name)} server (the Mac in the office). Then use the https address.</p>
<section><p><a class="btn" href="/ca.cer">Certificate for Windows (.cer)</a><a class="btn" href="/ca.crt">Mac, iPhone, Android (.crt)</a></p>
<p class="muted">Certificate name: ${esc(s.caName)}. The fingerprint shown while installing must match the one below; if it does not, stop and tell your admin.</p>${fp}</section>
<h2>Windows (Edge, Chrome)</h2>
<ol><li>Download the .cer above and open it.</li><li><b>Install Certificate…</b> → Store Location <b>Local Machine</b> (all users of this PC, needs an admin password) or <b>Current User</b> → Next.</li>
<li><b>Place all certificates in the following store</b> → Browse → <b>Trusted Root Certification Authorities</b> → OK → Next → Finish.</li>
<li>Check that the <b>Thumbprint (sha1)</b> in the security warning matches the SHA-1 above, then <b>Yes</b>.</li>
<li>Close every Edge / Chrome window, reopen it and go to <a href="${esc(main)}/">${esc(main)}</a>.</li>
<li>Desktop icon: Edge <b>⋯</b> → <b>Apps</b> → <b>Install this site as an app</b> (Chrome: <b>⋮</b> → <b>Cast, save, and share</b> → <b>Install page as app</b>).</li></ol>
<h2>Mac</h2><ol><li>Download the .crt and open it → add it to the login keychain.</li><li>In Keychain Access double-click it → <b>Trust</b> → “When using this certificate”: <b>Always Trust</b> → close, enter your password.</li></ol>
<h2>iPhone, iPad</h2><ol><li>Open this page in Safari, download the .crt → “Profile Downloaded”.</li><li>Settings → <b>Profile Downloaded</b> → Install.</li><li>Settings → General → About → <b>Certificate Trust Settings</b> → turn on the ${esc(name)} certificate.</li></ol>
<h2>Android</h2><ol><li>Download the .crt.</li><li>Settings → Security → More security settings → <b>Encryption &amp; credentials</b> → Install a certificate → <b>CA certificate</b> → pick the file.</li></ol>
<section><h3>Addresses</h3><ul>${links}</ul></section>
</div>
</main></body></html>
`
}
