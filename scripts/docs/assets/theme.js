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
