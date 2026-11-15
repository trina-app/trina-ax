// What a browser sees while an update migrates the database (system/migrate-start.ts, QA TC-2260): the stand-in answers
// a page load (a shared chat link, a bookmark) with this small page instead of its JSON. It says Trina is updating and
// will be back in a few minutes, reloads itself every RELOAD_S seconds, and opens what was asked for once the new version
// answers (the same address: path and query stay, nothing of them is written into the page).
// No time estimate: the stand-in knows how far the copy before the migrations is, not how long the migrations take.
// The language is the one the page last showed in this browser (the web app's mycel_locale cookie), else English, as the
// relay's pages pick it (relay/src/pages.ts). Inline style and one tiny script (the seconds waited); no outside files: the
// stand-in serves nothing else.
import { asLocale, type Locale } from '@mycel/shared/api'

/** How often the page reloads itself (also its Retry-After) */
export const UPDATING_RELOAD_S = 10
/** The header that marks an answer of the stand-in (shared/src/api/client.ts reads it into params.reason "updating") */
export const UPDATING_HEADER = 'x-mycel-updating'
const LOCALE_COOKIE = 'mycel_locale'

const TEXT: Record<Locale, { title: string; body: string; waited: string }> = {
  en: { title: 'Trina is updating', body: "It will be back in a few minutes. This page opens by itself when it's ready. Nothing you saved is lost.", waited: 'Waiting: %N% s' },
  ko: { title: '트리나를 업데이트하고 있어요', body: '몇 분 안에 다시 열려요. 준비되면 이 페이지가 저절로 열려요. 저장한 내용은 그대로 있어요.', waited: '기다린 시간: %N%초' },
  id: { title: 'Trina sedang diperbarui', body: 'Akan kembali dalam beberapa menit. Halaman ini terbuka sendiri saat sudah siap. Tidak ada yang Anda simpan yang hilang.', waited: 'Menunggu: %N% dtk' },
  ja: { title: 'トリナを更新しています', body: '数分で戻ります。準備ができるとこのページが自動で開きます。保存した内容はそのままです。', waited: 'お待ちの時間：%N%秒' },
  es: { title: 'Trina se está actualizando', body: 'Volverá en unos minutos. Esta página se abrirá sola cuando esté lista. No se pierde nada de lo que guardó.', waited: 'Esperando: %N% s' },
  zh: { title: 'Trina正在更新', body: '几分钟后就会恢复。准备好后此页面会自动打开。你保存的内容都还在。', waited: '已等待：%N% 秒' },
}

/** The language of the page: the mycel_locale cookie the web app writes, else English. */
export function updatingLocale(cookie: string | null | undefined): Locale {
  for (const part of (cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === LOCALE_COOKIE) { const l = asLocale(v); if (l) return l }
  }
  return 'en'
}

/** A page load of a browser (not the app's API calls, not a script or picture of a page): it gets the HTML page. */
export function wantsUpdatingPage(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const path = new URL(req.url).pathname
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/ws')) return false
  const mode = req.headers.get('sec-fetch-mode')
  if (mode) return mode === 'navigate'
  return (req.headers.get('accept') ?? '').includes('text/html')
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// the seconds waited, kept across the page's own reloads (sessionStorage; a wait older than an hour starts over)
const script = (label: string) => `(function(){var e=document.getElementById('w');if(!e)return;var L=${JSON.stringify(label)},k='mycelUpdatingSince',n=Date.now(),t=n;try{var v=+sessionStorage.getItem(k);if(v&&n-v<36e5)t=v;else sessionStorage.setItem(k,n)}catch(x){}function u(){e.textContent=L.replace('%N%',Math.max(0,Math.round((Date.now()-t)/1e3)))}e.hidden=false;u();setInterval(u,1e3)})()`

export function updatingHtml(locale: Locale): string {
  const t = TEXT[locale]
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="${UPDATING_RELOAD_S}"><title>${esc(t.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;background:#f6f7f6;color:#1d2420;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}main{max-width:520px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4a554f;margin:0}.sp{width:28px;height:28px;border:3px solid #cfd6d1;border-top-color:#2f7d4f;border-radius:50%;animation:sp 1s linear infinite;margin:0 0 16px}@keyframes sp{to{transform:rotate(360deg)}}.w{margin-top:12px;font-size:14px;color:#6b766f;font-variant-numeric:tabular-nums}@media (prefers-color-scheme:dark){body{background:#151816;color:#e8ece9}p{color:#a9b3ad}.sp{border-color:#3a443e;border-top-color:#5fd08a}.w{color:#8f9a94}}@media (prefers-reduced-motion:reduce){.sp{animation-duration:3s}}${locale === 'ko' ? 'main{word-break:keep-all;overflow-wrap:anywhere}' : ''}</style></head>
<body><main data-mycel-updating="1"><div class="sp" role="progressbar" aria-label="${esc(t.title)}"></div><h1>${esc(t.title)}</h1><p>${esc(t.body)}</p><p class="w" id="w" role="timer" hidden></p><script>${script(t.waited)}</script></main></body></html>`
}

/** The stand-in's answer to a page load: 503 (it is not the page), reloaded by the page itself, never cached. */
export function updatingPageResponse(req: Request): Response {
  const html = updatingHtml(updatingLocale(req.headers.get('cookie')))
  return new Response(req.method === 'HEAD' ? null : html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(UPDATING_RELOAD_S), 'cache-control': 'no-store', [UPDATING_HEADER]: '1', 'x-content-type-options': 'nosniff' },
  })
}
