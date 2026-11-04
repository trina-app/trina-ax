// Trina AX docs: theme switch, phone navigation, copy buttons, "On this page" highlight and search.
(function () {
  var base = document.body.dataset.base || ''
  var root = document.documentElement

  // theme
  var themeButton = document.querySelector('.theme-button')
  if (themeButton) themeButton.addEventListener('click', function () {
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    try { localStorage.setItem('trina-docs-theme', root.dataset.theme) } catch (e) {}
  })

  // phone navigation
  var menu = document.querySelector('.menu-button')
  var scrim = document.querySelector('.scrim')
  function setNav(open) {
    document.body.classList.toggle('nav-open', open)
    if (menu) menu.setAttribute('aria-expanded', String(open))
    if (scrim) scrim.hidden = !open
  }
  if (menu) menu.addEventListener('click', function () { setNav(!document.body.classList.contains('nav-open')) })
  if (scrim) scrim.addEventListener('click', function () { setNav(false) })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false) })
  var current = document.querySelector('.sidebar [aria-current="page"]')
  if (current) current.scrollIntoView({ block: 'center' })

  // copy buttons
  function copy(text, button, label) {
    var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.innerHTML = label }, 1500) }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {})
  }
  document.querySelectorAll('.copy-code').forEach(function (b) {
    b.addEventListener('click', function () { copy(b.parentElement.querySelector('pre').innerText, b, 'Copy') })
  })
  var copyPage = document.querySelector('.copy-page')
  if (copyPage) copyPage.addEventListener('click', function () {
    var label = copyPage.innerHTML
    fetch(copyPage.dataset.md).then(function (r) { return r.text() }).then(function (t) { copy(t, copyPage, label) })
  })

  // "On this page": highlight the section in view
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'))
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {}
    tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a })
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          tocLinks.forEach(function (a) { a.classList.remove('active') })
          var a = byId[en.target.id]
          if (a) a.classList.add('active')
        }
      })
    }, { rootMargin: '-60px 0px -70% 0px' })
    document.querySelectorAll('.prose h2[id], .prose h3[id]').forEach(function (h) { io.observe(h) })
  }

  // search
  var input = document.getElementById('search-input')
  var list = document.getElementById('search-results')
  var index = null, results = [], active = -1
  function load() {
    if (index) return Promise.resolve(index)
    return fetch(base + '/search-index.json').then(function (r) { return r.json() }).then(function (j) { index = j; return j })
  }
  function score(doc, words) {
    var s = 0
    var t = doc.t.toLowerCase(), d = doc.d.toLowerCase(), h = doc.h.join(' ').toLowerCase(), x = doc.x.toLowerCase()
    for (var i = 0; i < words.length; i++) {
      var w = words[i], hit = 0
      if (t.indexOf(w) >= 0) hit += 10
      if (h.indexOf(w) >= 0) hit += 5
      if (d.indexOf(w) >= 0) hit += 3
      if (x.indexOf(w) >= 0) hit += 1
      if (!hit) return 0
      s += hit
    }
    return s
  }
  function render() {
    list.innerHTML = ''
    if (!input.value.trim()) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return }
    if (!results.length) {
      var li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No results'; list.appendChild(li)
    }
    results.forEach(function (doc, i) {
      var li = document.createElement('li'); li.setAttribute('role', 'option'); li.id = 'sr-' + i
      li.setAttribute('aria-selected', String(i === active))
      var a = document.createElement('a'); a.href = doc.u
      a.textContent = doc.t
      var small = document.createElement('small'); small.textContent = doc.g + ' · ' + doc.d
      a.appendChild(small); li.appendChild(a); list.appendChild(li)
    })
    list.hidden = false; input.setAttribute('aria-expanded', 'true')
    if (active >= 0) input.setAttribute('aria-activedescendant', 'sr-' + active); else input.removeAttribute('aria-activedescendant')
  }
  function search() {
    var words = input.value.toLowerCase().split(/\s+/).filter(Boolean)
    load().then(function (docs) {
      results = docs.map(function (d) { return { d: d, s: score(d, words) } }).filter(function (r) { return r.s > 0 })
        .sort(function (a, b) { return b.s - a.s }).slice(0, 8).map(function (r) { return r.d })
      active = results.length ? 0 : -1
      render()
    })
  }
  if (input && list) {
    input.addEventListener('focus', load)
    input.addEventListener('input', search)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); render(); e.preventDefault() }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault() }
      else if (e.key === 'Enter' && results[active]) { location.href = results[active].u }
      else if (e.key === 'Escape') { input.value = ''; render(); input.blur() }
    })
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; input.setAttribute('aria-expanded', 'false') }, 150) })
    document.addEventListener('keydown', function (e) {
      var tag = (document.activeElement && document.activeElement.tagName) || ''
      if ((e.key === '/' && !/INPUT|TEXTAREA/.test(tag)) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); input.focus() }
    })
  }
})()
