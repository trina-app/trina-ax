// Applies the saved light or dark theme before the page paints. A file of its own, loaded in <head> without defer,
// so pages carry no inline script and work under a Content-Security-Policy of script-src 'self' (ax.trina.app/docs).
try {
  var t = localStorage.getItem('trina-docs-theme')
  if (t) document.documentElement.dataset.theme = t
} catch (e) { /* storage blocked: the system theme applies */ }
