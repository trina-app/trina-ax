// Trina AX docs: theme switch, section tab menus, phone navigation, tabs, copy menu, "On this page" and search.
(function () {
  var base = document.body.dataset.base || ''
  var root = document.documentElement
  var $ = function (s, el) { return (el || document).querySelector(s) }
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)) }
  function store(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k) } catch (e) { return null } }

  // theme
  var themeKey = document.body.dataset.themeKey || 'trina-docs-theme'
  $$('.theme-button, [data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
      root.dataset.theme = dark ? 'light' : 'dark'
      store(themeKey, root.dataset.theme)
    })
  })

  // a website's own bar (--site-nav): its phone menu, and the docs search in the bar or, on phones, in the docs row
  var siteMenuBtn = $('.sitenav [data-menu-toggle]'), siteMenu = $('.sitenav #mobile-menu')
  if (siteMenuBtn && siteMenu) {
    var setSiteMenu = function (open) { siteMenu.dataset.open = String(open); siteMenuBtn.setAttribute('aria-expanded', String(open)) }
    siteMenuBtn.addEventListener('click', function () { setSiteMenu(siteMenu.dataset.open !== 'true') })
    siteMenu.addEventListener('click', function (e) { if (e.target.closest('a')) setSiteMenu(false) })
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && siteMenu.dataset.open === 'true') { setSiteMenu(false); siteMenuBtn.focus() } })
  }
  var barSlot = $('.docs-tools[data-slot="bar"]'), rowSlot = $('.docs-tools[data-slot="row"]'), searchBox = $('.site-header .search')
  if (barSlot && rowSlot && searchBox) {
    var phone = matchMedia('(max-width: 900px)')
    var placeSearch = function () { (phone.matches ? rowSlot : barSlot).appendChild(searchBox) }
    placeSearch()
    if (phone.addEventListener) phone.addEventListener('change', placeSearch)
  }

  // menus (section tab menus and the copy menu): one open at a time, closed by Escape or a click elsewhere
  var openMenu = null
  function closeMenu() {
    if (!openMenu) return
    openMenu.button.setAttribute('aria-expanded', 'false')
    openMenu.close()
    openMenu = null
  }
  function toggleMenu(button, open, close) {
    if (openMenu && openMenu.button === button) { closeMenu(); return }
    closeMenu()
    open()
    button.setAttribute('aria-expanded', 'true')
    openMenu = { button: button, close: close }
  }
  document.addEventListener('click', function (e) {
    if (openMenu && !openMenu.button.parentElement.contains(e.target)) closeMenu()
  })

  $$('.section-tab').forEach(function (tab) {
    var caret = $('.tab-caret', tab), menu = $('.tab-menu', tab)
    if (!caret || !menu) return
    function place() { var r = tab.getBoundingClientRect(); menu.style.left = Math.max(8, Math.min(r.left, innerWidth - 260)) + 'px'; menu.style.top = (r.bottom + 4) + 'px' }
    caret.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleMenu(caret, function () { place(); tab.classList.add('open') }, function () { tab.classList.remove('open') })
    })
  })

  // copy page: main button copies the Markdown; the caret opens more options
  var copyBox = $('.copy-page')
  function copyText(text, el) {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text).then(function () {
      var label = el.querySelector('span') || el
      var old = label.innerHTML
      label.textContent = 'Copied'
      setTimeout(function () { label.innerHTML = old }, 1500)
    }, function () {})
  }
  function pageMarkdown() { return fetch(copyBox.dataset.md).then(function (r) { return r.text() }) }
  if (copyBox) {
    var copyMain = $('.copy-main', copyBox), copyCaret = $('.copy-caret', copyBox), copyMenu = $('.copy-menu', copyBox)
    copyMain.addEventListener('click', function () { pageMarkdown().then(function (t) { copyText(t, copyMain) }) })
    copyCaret.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleMenu(copyCaret, function () { copyMenu.hidden = false; var f = copyMenu.querySelector('[role=menuitem]'); if (f) f.focus() }, function () { copyMenu.hidden = true })
    })
    copyMenu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-action]')
      if (!item) return
      if (item.dataset.action === 'copy-md') pageMarkdown().then(function (t) { copyText(t, copyMain) })
      if (item.dataset.action === 'copy-llms') copyText(new URL(copyBox.dataset.llms, location.href).href, copyMain)
      closeMenu()
    })
    copyMenu.addEventListener('keydown', function (e) {
      var items = $$('[role=menuitem]', copyMenu), i = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault() }
      if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault() }
    })
  }

  // phone navigation
  var menu = $('.menu-button'), scrim = $('.scrim')
  function setNav(open) {
    document.body.classList.toggle('nav-open', open)
    if (menu) menu.setAttribute('aria-expanded', String(open))
    if (scrim) scrim.hidden = !open
  }
  if (menu) menu.addEventListener('click', function () { setNav(!document.body.classList.contains('nav-open')) })
  if (scrim) scrim.addEventListener('click', function () { setNav(false) })
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    if (openMenu) { var b = openMenu.button; closeMenu(); b.focus() } else setNav(false)
  })
  var current = $('.sidebar [aria-current="page"]')
  if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' })

  // tabs inside pages: click or arrow keys; the choice is remembered per label set
  $$('.tabs').forEach(function (box) {
    var list = $('.tab-list', box)
    var buttons = $$(':scope > .tab-list > [role=tab]', box)
    var panels = $$(':scope > .tab-panel', box)
    var key = 'trina-docs-tabs:' + buttons.map(function (b) { return b.textContent }).join('|')
    function select(i, focus) {
      buttons.forEach(function (b, j) { b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1 })
      panels.forEach(function (p, j) { p.hidden = i !== j })
      if (focus) buttons[i].focus()
      store(key, String(i))
    }
    var saved = Number(read(key))
    if (saved > 0 && saved < buttons.length) select(saved, false)
    buttons.forEach(function (b, i) { b.addEventListener('click', function () { select(i, false) }) })
    list.addEventListener('keydown', function (e) {
      var i = buttons.indexOf(document.activeElement)
      if (i < 0) return
      if (e.key === 'ArrowRight') { select((i + 1) % buttons.length, true); e.preventDefault() }
      if (e.key === 'ArrowLeft') { select((i - 1 + buttons.length) % buttons.length, true); e.preventDefault() }
      if (e.key === 'Home') { select(0, true); e.preventDefault() }
      if (e.key === 'End') { select(buttons.length - 1, true); e.preventDefault() }
    })
  })

  // screenshots: click to see them larger
  var lightbox = $('.lightbox')
  if (lightbox && lightbox.showModal) {
    var big = $('img', lightbox)
    $$('.shot-zoom').forEach(function (b) {
      b.addEventListener('click', function () { big.src = b.dataset.src; big.alt = $('img', b).alt; lightbox.showModal() })
    })
    $('.lightbox-close', lightbox).addEventListener('click', function () { lightbox.close() })
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) lightbox.close() })
  }

  // copy buttons on code
  $$('.copy-code').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!navigator.clipboard) return
      navigator.clipboard.writeText(b.parentElement.querySelector('pre').innerText).then(function () {
        b.classList.add('done'); b.setAttribute('aria-label', 'Copied')
        setTimeout(function () { b.classList.remove('done'); b.setAttribute('aria-label', 'Copy code') }, 1500)
      }, function () {})
    })
  })

  // "On this page": collapse, and highlight the section in view
  var tocToggle = $('.toc-toggle')
  function setToc(open) {
    document.body.classList.toggle('toc-collapsed', !open)
    if (tocToggle) { tocToggle.setAttribute('aria-expanded', String(open)); tocToggle.setAttribute('aria-label', open ? 'Hide On this page' : 'Show On this page') }
  }
  if (tocToggle) {
    if (read('trina-docs-toc') === 'closed') setToc(false)
    tocToggle.addEventListener('click', function () {
      var open = document.body.classList.contains('toc-collapsed')
      setToc(open); store('trina-docs-toc', open ? 'open' : 'closed')
    })
  }
  var tocLinks = $$('.toc a')
  if (tocLinks.length) {
    var heads = $$('.prose h2[id], .prose h3[id]')
    var offset = parseFloat(getComputedStyle(root).scrollPaddingTop) || 140
    function mark() {
      var id = heads.length ? heads[0].id : null
      for (var i = 0; i < heads.length; i++) { if (heads[i].getBoundingClientRect().top - offset <= 1) id = heads[i].id; else break }
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2 && heads.length) id = heads[heads.length - 1].id
      tocLinks.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + id) })
    }
    addEventListener('scroll', mark, { passive: true }); mark()
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
    if (!results.length) { var li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No results'; list.appendChild(li) }
    results.forEach(function (doc, i) {
      var item = document.createElement('li'); item.setAttribute('role', 'option'); item.id = 'sr-' + i
      item.setAttribute('aria-selected', String(i === active))
      var a = document.createElement('a'); a.href = doc.u; a.textContent = doc.t
      var small = document.createElement('small'); small.textContent = doc.g + ' · ' + doc.d
      a.appendChild(small); item.appendChild(a); list.appendChild(item)
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
