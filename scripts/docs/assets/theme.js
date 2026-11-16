// Applies the saved light or dark theme before the page paints. A file of its own, loaded in <head> without defer,
// so pages carry no inline script and work under a Content-Security-Policy of script-src 'self' (ax.trina.app/docs).
try {
  // the key: the docs' own, or the website's when the docs sit inside it (data-key on this script tag)
  var k = (document.currentScript && document.currentScript.getAttribute('data-key')) || 'trina-docs-theme'
  var t = localStorage.getItem(k)
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) { /* storage blocked: the system theme applies */ }
// Signed in on the console (account.trina.app keeps trina_signed_in=1 on .trina.app): the website's navbar shows
// "My teams" instead of Sign in and the main button. ax.trina.app's sync copies this file, and the website's
// test/signed-in-header.test.ts checks these lines.
try {
  if (/(?:^|;\s*)trina_signed_in=1(?:;|$)/.test(document.cookie)) document.documentElement.setAttribute('data-signed-in', '')
} catch (e) {}
// Waiting list mode (ax.trina.app, src/content/waitlist.ts there): the website's sign-up button in the navbar carries two
// wordings, and CSS shows "Join the waiting list" unless <html data-sales-open>. The docs sit on the same site, so they
// read the same remembered answer before paint and then ask the console (public, no cookie). No answer = the waiting
// list. The same lines as the website's public/theme.js and public/waitlist.js.
try {
  if (localStorage.getItem('trina_sales') === 'open') document.documentElement.setAttribute('data-sales-open', '')
} catch (e) {}
try {
  // only inside the website (its theme key on this script tag): the docs anywhere else have no such button
  if (document.currentScript && document.currentScript.getAttribute('data-key') === 'theme') {
    var salesOpen = function (open) {
      if (open) document.documentElement.setAttribute('data-sales-open', '')
      else document.documentElement.removeAttribute('data-sales-open')
      try { localStorage.setItem('trina_sales', open ? 'open' : 'waitlist') } catch (e) {}
    }
    fetch('https://account.trina.app/api/public/waitlist', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw 0; return r.json() })
      .then(function (d) { salesOpen(!!d && d.waitlist === false) })
      .catch(function () { salesOpen(false) })
  }
} catch (e) {}
