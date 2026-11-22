// The gate's own pages (landing with Turnstile + Start, busy, session ended, start refusals), in the six languages. Static HTML,
// no script of our own: the only script is Cloudflare Turnstile's widget on the landing page.
import { LOCALES, isLocale, type Locale } from './config.ts'
import { WORDMARK_DARK, WORDMARK_LIGHT } from './brand.ts'

export type PageKind = 'landing' | 'busy' | 'ended' | 'limit' | 'check' | 'error'

interface Words {
  title: string; landingH: string; sub: string; factQ: string; factHours: string; factPractice: string; practice: string; start: string
  busyH: string; busyP: string; guided: string; plans: string; retry: string
  endedH: string; endedP: string; again: string
  limitH: string; limitP: string; limitLaterP: string; checkH: string; checkP: string; errorH: string; errorP: string
}

/** Why a start was refused for this address: `hour` = the starts per hour (clears in about an hour); `day` = the starts
 * per day; `ip_live` = the live copies per address (copies live 24 hours). Only `hour` may promise "about an hour". */
export type LimitReason = 'hour' | 'day' | 'ip_live'

/** Screen text (the only place with words other than English in this service). The landing is kept short on purpose (the
 * owner, 11-22: too much text): a heading, one line, three facts of a few words each. `factQ`'s "about 8 questions" is the
 * demo limit (300k) over shared/src/api/demo.ts DEMO_QUESTION_TOKENS (35k): change both together. Questions, never
 * tokens. `practice` is the full sentence behind the third fact's info toggle. */
export const WORDS: Record<Locale, Words> = {
  en: {
    title: 'Try it yourself',
    landingH: 'Try Trina AX',
    sub: "You're Mina at a made-up company. Ask, open, look around.",
    factQ: 'About 8 questions',
    factHours: '24 hours',
    factPractice: 'Practice Gmail · Drive',
    practice: 'Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.',
    start: 'Start',
    busyH: 'The live demo is busy right now',
    busyP: 'Every demo copy is in use. Watch the guided demo, or see the plans.',
    guided: 'Watch the guided demo',
    plans: 'See plans',
    retry: 'Try again',
    endedH: 'Your demo session ended',
    endedP: 'Demo copies are kept for 24 hours. You can start a new one any time.',
    again: 'Start again',
    limitH: "You've started the demo a few times already",
    limitP: 'You can start again in about an hour. Meanwhile, you can watch the guided demo.',
    limitLaterP: 'You can start again tomorrow. Meanwhile, you can watch the guided demo.',
    checkH: "We couldn't finish the browser check",
    checkP: 'Wait for the check to finish, then press Start.',
    errorH: "The demo couldn't start",
    errorP: 'Try again in a bit.',
  },
  ko: {
    title: '직접 써 보기',
    landingH: '트리나 AX 써 보기',
    sub: '가상 회사의 신입 미나가 되어 묻고, 열고, 둘러보세요.',
    factQ: '질문 8번쯤',
    factHours: '24시간',
    factPractice: '연습용 Gmail·Drive',
    practice: '여기 Gmail·Google Drive·Higgsfield는 연습용이에요. 메일은 실제로 보내지 않고, 새 사진은 준비된 사진 중에서 골라요.',
    start: '시작하기',
    busyH: '지금은 체험 데모가 꽉 찼어요',
    busyP: '모든 데모 사본을 누군가 쓰고 있어요. 안내 데모를 보거나 요금제를 살펴보세요.',
    guided: '안내 데모 보기',
    plans: '요금제 보기',
    retry: '다시 해 보기',
    endedH: '데모 시간이 끝났어요',
    endedP: '데모 사본은 24시간 동안만 남아요. 언제든 새로 시작할 수 있어요.',
    again: '다시 시작하기',
    limitH: '데모를 이미 여러 번 시작했어요',
    limitP: '한 시간쯤 뒤에 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.',
    limitLaterP: '내일 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.',
    checkH: '브라우저 확인을 마치지 못했어요',
    checkP: '확인이 끝날 때까지 기다린 뒤 시작하기를 눌러 주세요.',
    errorH: '데모를 시작하지 못했어요',
    errorP: '잠시 뒤 다시 해 주세요.',
  },
  ja: {
    title: '実際に使ってみる',
    landingH: 'トリナ AXを使ってみる',
    sub: '架空の会社の新人ミナとして、聞いて、開いて、見て回りましょう。',
    factQ: '質問は8回ほど',
    factHours: '24時間',
    factPractice: '練習用Gmail・ドライブ',
    practice: 'ここのGmail・Googleドライブ・Higgsfieldは練習用です。メールは実際には送信されず、新しい画像は用意された画像の中から選ばれます。',
    start: 'はじめる',
    busyH: 'ただいまライブデモが混み合っています',
    busyP: 'デモのコピーはすべて使用中です。ガイド付きデモを見るか、料金プランをご覧ください。',
    guided: 'ガイド付きデモを見る',
    plans: '料金プランを見る',
    retry: 'もう一度試す',
    endedH: 'デモの時間が終わりました',
    endedP: 'デモのコピーは24時間だけ残ります。いつでも新しく始められます。',
    again: 'もう一度はじめる',
    limitH: 'デモをすでに何度か始めています',
    limitP: '1時間ほどで、もう一度始められます。それまでガイド付きデモをご覧いただけます。',
    limitLaterP: '明日また始められます。それまでガイド付きデモをご覧いただけます。',
    checkH: 'ブラウザの確認が完了しませんでした',
    checkP: '確認が終わるまで待ってから、「はじめる」を押してください。',
    errorH: 'デモを開始できませんでした',
    errorP: '少し時間をおいてから、もう一度お試しください。',
  },
  zh: {
    title: '亲自试试',
    landingH: '试用 Trina AX',
    sub: '你是一家虚构公司的新人 Mina：随便问、随便打开、随便看看。',
    factQ: '约 8 个问题',
    factHours: '24 小时',
    factPractice: '练习用 Gmail · 云端硬盘',
    practice: '这里的 Gmail、Google 云端硬盘和 Higgsfield 是练习用的：邮件不会真的发出，新图片从准备好的一组图片中挑选。',
    start: '开始',
    busyH: '在线演示现在人有点多',
    busyP: '所有演示副本都在使用中。你可以先看引导演示，或者看看价格方案。',
    guided: '看引导演示',
    plans: '查看价格方案',
    retry: '再试一次',
    endedH: '你的演示已结束',
    endedP: '演示副本只保留 24 小时。你随时可以重新开始。',
    again: '重新开始',
    limitH: '你已经开始过好几次演示了',
    limitP: '大约一小时后可以重新开始。在此期间，你可以先看引导演示。',
    limitLaterP: '明天可以重新开始。在此期间，你可以先看引导演示。',
    checkH: '浏览器验证没有完成',
    checkP: '请等验证完成后，再点击“开始”。',
    errorH: '演示没能启动',
    errorP: '请稍后再试。',
  },
  es: {
    title: 'Pruébelo usted mismo',
    landingH: 'Pruebe Trina AX',
    sub: 'Usted es Mina, de una empresa ficticia. Pregunte, abra y explore.',
    factQ: 'Unas 8 preguntas',
    factHours: '24 horas',
    factPractice: 'Gmail y Drive de práctica',
    practice: 'Gmail, Google Drive y Higgsfield aquí son de práctica: el correo nunca se envía de verdad y las imágenes nuevas salen de un conjunto preparado.',
    start: 'Empezar',
    busyH: 'La demostración en vivo está ocupada ahora mismo',
    busyP: 'Todas las copias de la demostración están en uso. Vea la demostración guiada o consulte los planes.',
    guided: 'Ver la demostración guiada',
    plans: 'Ver planes',
    retry: 'Volver a intentarlo',
    endedH: 'Su sesión de demostración ha terminado',
    endedP: 'Las copias de la demostración se guardan durante 24 horas. Puede empezar una nueva cuando quiera.',
    again: 'Empezar de nuevo',
    limitH: 'Ya ha empezado la demostración varias veces',
    limitP: 'Podrá empezar de nuevo en aproximadamente una hora. Mientras tanto, puede ver la demostración guiada.',
    limitLaterP: 'Podrá empezar de nuevo mañana. Mientras tanto, puede ver la demostración guiada.',
    checkH: 'No pudimos completar la verificación del navegador',
    checkP: 'Espere a que termine la verificación y pulse Empezar.',
    errorH: 'No se pudo iniciar la demostración',
    errorP: 'Vuelva a intentarlo dentro de un rato.',
  },
  id: {
    title: 'Coba sendiri',
    landingH: 'Coba Trina AX',
    sub: 'Anda Mina di perusahaan fiktif. Bertanya, buka, dan lihat-lihat.',
    factQ: 'Sekitar 8 pertanyaan',
    factHours: '24 jam',
    factPractice: 'Gmail · Drive latihan',
    practice: 'Gmail, Google Drive, dan Higgsfield di sini hanya untuk latihan: email tidak pernah benar-benar terkirim, dan gambar baru diambil dari kumpulan yang sudah disiapkan.',
    start: 'Mulai',
    busyH: 'Demo langsung sedang penuh',
    busyP: 'Semua salinan demo sedang dipakai. Tonton demo terpandu, atau lihat paket harga.',
    guided: 'Tonton demo terpandu',
    plans: 'Lihat paket',
    retry: 'Coba lagi',
    endedH: 'Sesi demo Anda sudah berakhir',
    endedP: 'Salinan demo disimpan selama 24 jam. Anda bisa memulai yang baru kapan saja.',
    again: 'Mulai lagi',
    limitH: 'Anda sudah beberapa kali memulai demo',
    limitP: 'Anda bisa memulai lagi sekitar satu jam lagi. Sementara itu, Anda bisa menonton demo terpandu.',
    limitLaterP: 'Anda bisa memulai lagi besok. Sementara itu, Anda bisa menonton demo terpandu.',
    checkH: 'Pemeriksaan browser belum selesai',
    checkP: 'Tunggu sampai pemeriksaan selesai, lalu tekan Mulai.',
    errorH: 'Demo tidak bisa dimulai',
    errorP: 'Coba lagi sebentar lagi.',
  },
}

/** ?lang= (or the Start form's lang) wins; then the `mycel_locale` cookie (the language the visitor used in the app: the
 * web app writes it, and a start sets it); then the browser's first language that is one of ours; else en. Only `allowed`
 * (the live pool.locales): a language the gate has no snapshot for falls back to en (or the first allowed one). The
 * cookie passes the same check as the query, so nothing else ever reaches `<html lang>` or a Set-Cookie. */
export function localeOf(query: string | null, acceptLanguage: string | undefined, allowed: readonly Locale[] = LOCALES, cookieLocale?: string | null): Locale {
  const ok = (l: string | null | undefined): l is Locale => isLocale(l) && allowed.includes(l)
  if (ok(query)) return query
  if (ok(cookieLocale)) return cookieLocale
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().split(';')[0]!.toLowerCase().split('-')[0]
    // a browser tag the gate does not serve is skipped: the next one may be
    if (ok(tag)) return tag
  }
  return allowed.includes('en') || !allowed.length ? 'en' : allowed[0]!
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
export const PAGE_CSP = "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export interface PageLinks { scriptedDemo: string; pricing: string }

// Drawn icons for the landing's facts row: one 24-unit grid, 1.75 stroke, round caps (no emoji, no icon font).
const icon = (d: string) => `<svg class="ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICON_ASK = icon('<path d="M5 18.5V6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.5L5 18.5Z"/><path d="M9 9.5h6M9 12h3.5"/>')
const ICON_CLOCK = icon('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>')
const ICON_MAIL = icon('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4.5 7 7.5 5.5L19.5 7"/>')
const ICON_INFO = `<svg class="ic info-ic" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01" stroke-width="2.4"/></svg>`

/** The wordmark in both colours; CSS shows the one that matches the theme. Each copy gets its own mask id (one page,
 * two SVGs with the same id would share the first one's mask). */
const wordmark = (label: string) => `<div class="brand" role="img" aria-label="${esc(label)}">${WORDMARK_LIGHT.replace(/id="m"/, 'id="wm-l"').replace(/url\(#m\)/, 'url(#wm-l)').replace('<svg ', '<svg class="wm wm-light" aria-hidden="true" ')}${WORDMARK_DARK.replace(/id="m"/, 'id="wm-d"').replace(/url\(#m\)/, 'url(#wm-d)').replace('<svg ', '<svg class="wm wm-dark" aria-hidden="true" ')}</div>`

export function renderPage(kind: PageKind, locale: Locale, o: { siteKey: string; links: PageLinks; limit?: LimitReason }): string {
  const w = WORDS[locale]
  const startForm = (label: string, turnstile: boolean) => `
    <form method="post" action="/__demo/start">
      <input type="hidden" name="lang" value="${locale}">
      ${turnstile ? `<div class="cf-turnstile" data-sitekey="${esc(o.siteKey)}" data-language="${locale}"></div>` : ''}
      <button type="submit" class="primary">${esc(label)}</button>
    </form>`
  const away = `
    <div class="row">
      <a class="primary" href="${esc(o.links.scriptedDemo)}">${esc(w.guided)}</a>
      <a class="secondary" href="${esc(o.links.pricing)}">${esc(w.plans)}</a>
    </div>`
  // busy and error: one more way, back to the landing page (a new Start there passes Turnstile again)
  const awayOrRetry = `
    <div class="row">
      <a class="primary" href="${esc(o.links.scriptedDemo)}">${esc(w.guided)}</a>
      <a class="secondary" href="${esc(o.links.pricing)}">${esc(w.plans)}</a>
      <a class="secondary" href="/">${esc(w.retry)}</a>
    </div>`
  // The three facts, a few words each. The full practice sentence opens from the third one on tap or click
  // (details/summary: no script) and is its hover title too.
  const facts = `
    <ul class="facts">
      <li class="fact">${ICON_ASK}<span>${esc(w.factQ)}</span></li>
      <li class="fact">${ICON_CLOCK}<span>${esc(w.factHours)}</span></li>
      <li class="fact"><details class="practice"><summary title="${esc(w.practice)}">${ICON_MAIL}<span>${esc(w.factPractice)}</span>${ICON_INFO}</summary><p>${esc(w.practice)}</p></details></li>
    </ul>`
  let h = '', p = '', body = '', turnstile = false
  switch (kind) {
    case 'landing': h = w.landingH; p = w.sub; body = facts + startForm(w.start, true); turnstile = true; break
    case 'check': h = w.checkH; p = w.checkP; body = startForm(w.start, true); turnstile = true; break
    case 'ended': h = w.endedH; p = w.endedP; body = startForm(w.again, true); turnstile = true; break
    case 'busy': h = w.busyH; p = w.busyP; body = awayOrRetry; break
    // no retry link: it would be refused again. "About an hour" only when that is the reason
    case 'limit': h = w.limitH; p = o.limit === 'hour' ? w.limitP : w.limitLaterP; body = away; break
    case 'error': h = w.errorH; p = w.errorP; body = awayOrRetry; break
  }
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(kind === 'landing' ? w.landingH : w.title)}</title>
${turnstile ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : ''}
<style>
  /* Trina AX brand (editions/trina/branding/logo/README.md): ink, paper, Signal Orange (#E8521A in UI on paper) */
  :root { --bg:#f6f2ea; --raised:#fffdf9; --text:#14110f; --dim:#5c544c; --line:rgba(20,17,15,.12); --accent:#14110f; --on-accent:#f6f2ea;
    --orange:#e8521a; --shadow:0 10px 30px rgba(20,17,15,.12), 0 2px 6px rgba(20,17,15,.06); color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14110f; --raised:#221e1b; --text:#f6f2ea; --dim:#ada59b; --line:rgba(246,242,234,.14);
    --accent:#f6f2ea; --on-accent:#14110f; --orange:#ff6a33; --shadow:0 10px 30px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3); } }
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in srgb, var(--orange) 28%, transparent); }
  body { margin:0; min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; padding: 40px 16px; }
  main { width:100%; max-width:480px; text-align:center; }
  .brand { display:inline-flex; margin:0 0 36px; }
  .wm { height:30px; width:auto; display:block; }
  .wm-dark { display:none; }
  @media (prefers-color-scheme: dark) { .wm-light { display:none; } .wm-dark { display:block; } }
  h1 { font-size:28px; line-height:1.2; font-weight:700; letter-spacing:-.02em; margin:0 0 10px; text-wrap:balance; }
  .landing h1 { font-size:clamp(34px, 9vw, 44px); line-height:1.08; letter-spacing:-.03em; }
  main > p { margin:0 0 28px; color:var(--dim); text-wrap:balance; }
  .landing main > p { font-size:17px; }
  /* keep-all only for Korean: Japanese and Chinese have no spaces and would break only at punctuation */
  html[lang="ko"] h1, html[lang="ko"] main > p, html[lang="ko"] .practice p { word-break:keep-all; }
  .facts { position:relative; list-style:none; margin:0 0 32px; padding:16px 0; display:flex; flex-wrap:wrap; justify-content:center; gap:10px 22px;
    border-block:1px solid var(--line); font-size:14px; font-weight:500; }
  .fact { display:inline-flex; align-items:center; gap:7px; white-space:nowrap; }
  .practice summary { display:flex; align-items:center; gap:7px; white-space:nowrap; }
  .ic { flex:none; color:var(--orange); }
  .practice summary { list-style:none; cursor:pointer; border-radius:6px; text-decoration:underline dotted color-mix(in srgb, var(--text) 40%, transparent);
    text-underline-offset:4px; }
  .practice summary::-webkit-details-marker { display:none; }
  .practice .info-ic { color:var(--dim); }
  .practice[open] .info-ic, .practice summary:hover .info-ic { color:var(--text); }
  .practice p { position:absolute; z-index:2; left:0; right:0; top:calc(100% + 8px); margin:0; padding:12px 14px; text-align:left; white-space:normal;
    background:var(--raised); color:var(--text); border-radius:12px; box-shadow:var(--shadow); font-weight:400; line-height:1.5; }
  form { display:flex; flex-direction:column; gap:16px; align-items:center; }
  form .primary { width:100%; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .primary, .secondary { display:inline-flex; justify-content:center; align-items:center; min-height:48px; padding:0 20px; border-radius:12px;
    font:inherit; font-weight:600; text-decoration:none; cursor:pointer; transition:transform .15s cubic-bezier(.2,.8,.2,1), opacity .15s; }
  .primary { background:var(--accent); color:var(--on-accent); border:0; }
  .primary:hover { opacity:.88; }
  .primary:active, .secondary:active { transform:scale(.985); }
  .secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
  .secondary:hover { border-color:color-mix(in srgb, var(--text) 35%, transparent); }
  :focus-visible { outline:2px solid var(--orange); outline-offset:3px; }
  .row a { flex:1 1 160px; }
  @media (prefers-reduced-motion: reduce) { .primary, .secondary { transition:none; } }
</style>
</head>
<body class="${kind}">
<main>
  ${wordmark('Trina AX')}
  <h1>${esc(h)}</h1>
  <p>${esc(p)}</p>
  ${body}
</main>
</body>
</html>`
}
