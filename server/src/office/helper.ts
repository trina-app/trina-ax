// Office mode's plain-HTTP helper page (docs/OFFICE.md), on the office network next to the TLS port (lanPort - 1 by
// default). A desk that does not trust the office CA yet cannot open the https address, so this page is where it
// gets the CA: the certificate as .cer (Windows) and .crt (Mac, phones), its fingerprints to compare, the steps per
// device, and the https address to open afterwards.
//
// It serves exactly three paths (GET / HEAD): /, /ca.cer, /ca.crt. Everything else is 404: no API, no redirect, no
// proxy to the server, nothing taken from the request (Host, query) into the page. The page has no script.
//
// The page is plain HTTP, so someone on the office network could change it and the certificate it hands out. That
// is why it shows NO fingerprint: the desk compares the one Windows shows with the desk card printed on the server
// Mac (deskCard(), <home>/DESK-CARD.html, also `teamax info`), never with anything this page says. Handing out
// tls/ca.cer on a USB stick skips the network altogether.
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

/** SHA-1 the way Windows shows it under 인증서 → 자세히 → 지문 / Details → Thumbprint (lower case, no colons), in
 * groups of 8 so a person can compare it: "c87162d4 d9b3bf5b ...". */
export function windowsThumbprint(sha1: string): string {
  return sha1.replace(/[^0-9a-f]/gi, '').toLowerCase().replace(/(.{8})(?=.)/g, '$1 ')
}

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

const STYLE = `:root{color-scheme:light dark;--fg:#1d2420;--muted:#5b6660;--bg:#faf9f6;--card:#fff;--line:#dfe3df;--accent:#2c6a59;--warn:#8a4b08;--warnbg:#fff4e5}
@media (prefers-color-scheme:dark){:root{--fg:#e8ece9;--muted:#a3ada7;--bg:#141816;--card:#1c211e;--line:#2d3430;--accent:#7cc4ad;--warn:#f3c38b;--warnbg:#2b2117}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}h3{font-size:1rem;margin:1.25rem 0 .25rem}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}
.warn{background:var(--warnbg);color:var(--fg);border-color:var(--warn)}
a{color:var(--accent)}.btn{display:inline-block;padding:.6rem 1rem;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:.25rem .5rem .25rem 0}
@media (prefers-color-scheme:dark){.btn{color:#10201a}}
code{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;word-break:break-all}.fp{font:600 1.15rem/1.6 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em;word-spacing:.3em}
ol{padding-left:1.4rem}li{margin:.3rem 0}.muted{color:var(--muted);font-size:.9rem}hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}`

/** Windows steps (Korean, then English): the thumbprint is checked in the certificate's own window BEFORE it is
 * installed, against the desk card; "Current user" is the store whose install shows the security warning. */
const WIN_KO = (main: string) => `<ol>
<li>위의 <b>윈도우용 인증서 받기</b>를 누릅니다. Edge가 “안전하게 다운로드할 수 없습니다”라고 하면 <b>⋯</b> → <b>유지</b>를 누릅니다(이 페이지가 http라서 나오는 안내입니다).</li>
<li>받은 파일을 엽니다(더블클릭). 인증서 창에서 <b>자세히</b> 탭 → 목록의 <b>지문</b>을 누릅니다.</li>
<li>아래에 나온 값이 <b>데스크 카드의 지문과 같은지</b> 확인합니다(대소문자·띄어쓰기는 무시, 적어도 앞 8자리와 끝 8자리). <b>다르면 여기서 멈추고</b> 관리자에게 알려 주세요.</li>
<li><b>일반</b> 탭 → <b>인증서 설치…</b> → 저장소 위치 <b>현재 사용자</b> → 다음.</li>
<li><b>모든 인증서를 다음 저장소에 저장</b> → 찾아보기 → <b>신뢰할 수 있는 루트 인증 기관</b> → 확인 → 다음 → 마침.</li>
<li>“보안 경고” 창의 지문(sha1)이 카드의 값과 같으면 <b>예</b>를 누릅니다.</li>
<li>Edge(또는 Chrome) 창을 모두 닫았다가 다시 열고 <a href="${esc(main)}/">${esc(main)}</a> 에 접속합니다.</li>
<li>바탕화면 아이콘: Edge 오른쪽 위 <b>⋯</b> → <b>앱</b> → <b>이 사이트를 앱으로 설치</b>. (Chrome: <b>⋮</b> → <b>전송, 저장, 공유</b> → <b>페이지를 앱으로 설치</b>)</li>
</ol>
<p class="muted">이 PC를 여러 윈도우 계정이 쓰면 계정마다 4~6단계를 하거나, PC 관리자가 4단계에서 <b>로컬 컴퓨터</b>를 고릅니다(관리자 암호 필요, 이때는 보안 경고 창이 나오지 않으니 2~3단계의 지문 확인이 꼭 필요합니다).</p>`

const WIN_EN = (main: string) => `<ol>
<li>Click <b>Certificate for Windows</b> above. If Edge says the file “can't be downloaded securely”, click <b>⋯</b> → <b>Keep</b> (this page is plain http).</li>
<li>Open the downloaded file. In the certificate window go to <b>Details</b> → click <b>Thumbprint</b>.</li>
<li>Check that the value is <b>the same as on the desk card</b> (ignore case and spaces; at least the first 8 and last 8 characters). <b>If it differs, stop</b> and tell your admin.</li>
<li><b>General</b> → <b>Install Certificate…</b> → Store Location <b>Current User</b> → Next.</li>
<li><b>Place all certificates in the following store</b> → Browse → <b>Trusted Root Certification Authorities</b> → OK → Next → Finish.</li>
<li>If the thumbprint (sha1) in the Security Warning matches the card, click <b>Yes</b>.</li>
<li>Close every Edge / Chrome window, reopen it and go to <a href="${esc(main)}/">${esc(main)}</a>.</li>
<li>Desktop icon: Edge <b>⋯</b> → <b>Apps</b> → <b>Install this site as an app</b> (Chrome: <b>⋮</b> → <b>Cast, save, and share</b> → <b>Install page as app</b>).</li>
</ol>`

export function helperPage(s: HelperState): string {
  const main = s.origins[0] ?? ''
  const links = s.origins.map((o) => `<li><a href="${esc(o)}/">${esc(o)}</a></li>`).join('')
  const name = PRODUCT.displayName
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — 처음 연결 / First connection</title>
<style>${STYLE}</style></head><body><main>
<h1>${esc(name)} — 처음 연결하기</h1>
<p>이 컴퓨터가 ${esc(name)} 서버(사무실의 맥)를 안전하게 알아보도록 <b>인증서를 한 번만</b> 설치합니다. 그다음부터는 아래 https 주소로 접속합니다.</p>
<section class="warn"><p><b>설치하기 전에 데스크 카드를 준비하세요.</b> 관리자가 서버 맥에서 출력한 종이(또는 서버 맥의 <code>~/TeamAX/teamax info</code> 화면)에 인증서 <b>지문</b>이 있습니다. 이 페이지는 지문을 보여 주지 않습니다: 같은 네트워크의 누군가가 이 페이지를 바꿔치기할 수 있어서, 비교는 반드시 카드와 합니다. USB로 받은 <code>ca.cer</code>를 쓰면 이 페이지는 필요 없습니다.</p></section>
<section>
<p><a class="btn" href="/ca.cer">윈도우용 인증서 받기 (.cer)</a><a class="btn" href="/ca.crt">맥·아이폰·안드로이드용 (.crt)</a></p>
<p class="muted">인증서 이름: ${esc(s.caName)}</p>
</section>
<h2>윈도우 (Edge·Chrome)</h2>
${WIN_KO(main)}
<h2>맥</h2>
<ol><li><b>.crt</b>를 받아 더블클릭 → 키체인 접근에 추가(로그인).</li><li>키체인 접근에서 인증서를 두 번 클릭 → <b>세부사항</b>의 SHA-1 지문이 카드와 같은지 확인 → <b>신뢰</b> → “이 인증서 사용 시” <b>항상 신뢰</b> → 창을 닫고 암호 입력.</li><li>Safari·Chrome으로 https 주소에 접속합니다.</li></ol>
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
<section class="warn"><p><b>Have the desk card ready.</b> Your admin prints it on the server Mac (or reads it with <code>~/TeamAX/teamax info</code> there); it shows the certificate's <b>thumbprint</b>. This page shows none on purpose: someone on the same network could change this page, so always compare with the card. With <code>ca.cer</code> from a USB stick you do not need this page.</p></section>
<section><p><a class="btn" href="/ca.cer">Certificate for Windows (.cer)</a><a class="btn" href="/ca.crt">Mac, iPhone, Android (.crt)</a></p>
<p class="muted">Certificate name: ${esc(s.caName)}</p></section>
<h2>Windows (Edge, Chrome)</h2>
${WIN_EN(main)}
<h2>Mac</h2><ol><li>Download the .crt and open it → add it to the login keychain.</li><li>In Keychain Access double-click it → check the SHA-1 under <b>Details</b> against the card → <b>Trust</b> → “When using this certificate”: <b>Always Trust</b> → close, enter your password.</li></ol>
<h2>iPhone, iPad</h2><ol><li>Open this page in Safari, download the .crt → “Profile Downloaded”.</li><li>Settings → <b>Profile Downloaded</b> → Install.</li><li>Settings → General → About → <b>Certificate Trust Settings</b> → turn on the ${esc(name)} certificate.</li></ol>
<h2>Android</h2><ol><li>Download the .crt.</li><li>Settings → Security → More security settings → <b>Encryption &amp; credentials</b> → Install a certificate → <b>CA certificate</b> → pick the file.</li></ol>
<section><h3>Addresses</h3><ul>${links}</ul></section>
</div>
</main></body></html>
`
}

/**
 * The desk card: one printable page written on the server Mac (<home>/DESK-CARD.html, `teamax card` opens it). It is
 * the trusted copy of the fingerprint: it never travels over the network. Desk staff compare the thumbprint Windows
 * shows with it before they install the certificate.
 */
export function deskCard(s: HelperState, o: { helper: string | null; caCer: string; teamName?: string | null; made: string; public?: string | null }): string {
  const main = s.origins[0] ?? ''
  const pub = o.public ?? null
  const other = s.origins.slice(1)
  const name = PRODUCT.displayName
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} 데스크 카드</title>
<style>${STYLE}
@page{size:A4;margin:12mm}@media print{body{background:#fff;color:#000;font-size:14px}main{padding:0;max-width:none}h1{margin:0 0 .5rem}h3{margin:.25rem 0}section{break-inside:avoid;border-color:#999;margin:.6rem 0;padding:.5rem 1rem}section p{margin:.35rem 0}.noprint{display:none}}
.big{font:700 1.35rem/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all}</style></head><body><main>
<h1>${esc(name)} 데스크 카드</h1>
<p class="muted noprint">이 페이지를 인쇄해(⌘P) 데스크마다 두세요. 이 카드는 서버 맥에서 만든 것이라 네트워크로 바뀔 수 없습니다. 만든 때: ${esc(o.made)}</p>
${pub ? `<section><h3>인터넷 주소 (기본, 인증서 설치 필요 없음)</h3>
<p class="big">${esc(pub)}</p>
<p class="muted">Edge에서 이 주소를 열고 ⋯ → 앱 → <b>이 사이트를 앱으로 설치</b>. 처음에는 관리자가 보낸 초대 링크로 가입합니다. 사무실 밖에서도 됩니다.</p></section>
<h2 style="font-size:1rem;margin:1rem 0 0">사무실 안 대체 경로 (인터넷이 끊겼을 때)</h2>` : ''}
<section><h3>1. 인증서 받기 (처음 한 번)</h3>
${o.helper ? `<p>Edge 주소창에 <b>http://</b>까지 그대로 입력: <span class="big">${esc(o.helper)}</span></p>` : ''}
<p class="muted">또는 관리자가 USB로 준 <code>ca.cer</code> (서버 맥의 <code>${esc(o.caCer)}</code>)</p></section>
<section><h3>2. 인증서 지문 확인 (윈도우: 인증서 → 자세히 → 지문)</h3>
<p class="fp">${esc(windowsThumbprint(s.sha1))}</p>
<p class="muted">대소문자·띄어쓰기는 무시합니다. 다르면 설치하지 말고 관리자에게 알려 주세요. (SHA-256: <code>${esc(s.sha256)}</code>)</p></section>
<section><h3>3. 접속 주소 (인증서 설치 뒤)</h3>
<p class="big">${esc(main)}</p>
${other.length ? `<p class="muted">이름으로: ${other.map(esc).join(', ')}</p>` : ''}
<p class="muted">Edge ⋯ → 앱 → <b>이 사이트를 앱으로 설치</b> → 바탕화면 아이콘. 처음에는 관리자가 보낸 초대 링크로 가입합니다.</p></section>
<section><h3>Desk card (English)</h3>
${pub ? `<p>Main: open <code>${esc(pub)}</code> in Edge (no certificate to install) and install it as an app (Edge ⋯ → Apps). In-office fallback when the internet is down:</p>` : ''}
<p>1. Certificate: ${o.helper ? `<code>${esc(o.helper)}</code> (type http://) or ` : ''}<code>ca.cer</code> from USB. 2. Thumbprint (Windows: certificate → Details → Thumbprint) must be <code>${esc(windowsThumbprint(s.sha1))}</code>. 3. Then open <code>${esc(main)}</code> and install it as an app (Edge ⋯ → Apps).</p></section>
</main></body></html>
`
}
