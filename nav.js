/* ============================================================
   SHARED SITE NAVIGATION
   ------------------------------------------------------------
   One canonical nav, injected into every page. Edit the
   NAV_LINKS list below to add/remove/reorder links site-wide —
   no page needs to be touched individually.

   Each page just needs:
     1. An empty mount point where the nav used to be:
          <div id="site-nav-mount"></div>
     2. This script included (defer), e.g.:
          <script src="nav.js" defer></script>

   Markup, classes and behaviour (scroll shadow, hamburger,
   mobile menu, active-page highlight) match the original
   per-page nav exactly, so no CSS or design changes needed.
   ============================================================ */
(function () {
  var NAV_LINKS = [
    { href: 'books.html',        label: 'Books' },
    { href: 'characters.html',  label: 'Characters' },
    { href: 'bonus.html',        label: 'One More Chapter' },
    { href: 'crafties.html',    label: 'Crafties' },
    { href: 'kanha.html',        label: "Kanha's Corner" },
    { href: 'hall-of-fame.html', label: 'Hall of Fame' },
    { href: 'updates.html',      label: 'Updates' },
    { href: 'about.html',        label: 'About' },
    { href: 'links.html',        label: 'Find Me' }
  ];

  function currentPage() {
    var path = window.location.pathname.split('/').pop();
    return path ? path : 'index.html';
  }

  function linkClass(href, active) {
    return href === active ? 'nav-link active-page' : 'nav-link';
  }

  function buildDesktopLinks(active) {
    return NAV_LINKS.map(function (l) {
      return '<li><a href="' + l.href + '" class="' + linkClass(l.href, active) + '">' + l.label + '</a></li>';
    }).join('');
  }

  function buildMobileLinks(active) {
    return NAV_LINKS.map(function (l) {
      return '<a href="' + l.href + '" class="' + linkClass(l.href, active) + '">' + l.label + '</a>';
    }).join('');
  }

  function navMarkup() {
    var active = currentPage();
    return (
      '<nav class="site-nav" id="siteNav" aria-label="Main navigation">' +
        '<a href="index.html" class="nav-logo" aria-label="thatbrowncraft home">' +
          '<span class="logo-that">that</span><span class="logo-brown">brown</span><span class="logo-craft">craft</span>' +
        '</a>' +
        '<ul class="nav-links" role="list">' + buildDesktopLinks(active) + '</ul>' +
        '<button class="nav-hamburger" id="burger" aria-label="Open menu" aria-expanded="false">' +
          '<span></span><span></span><span></span>' +
        '</button>' +
      '</nav>' +
      '<div class="nav-mobile" id="mobileMenu" role="navigation">' + buildMobileLinks(active) + '</div>'
    );
  }

  function wireUpBehavior() {
    var nav = document.getElementById('siteNav');
    var burger = document.getElementById('burger');
    var menu = document.getElementById('mobileMenu');
    if (!nav || !burger || !menu) return;

    window.addEventListener('scroll', function () {
      nav.classList.toggle('scrolled', window.scrollY > 24);
    }, { passive: true });

    burger.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });

    menu.querySelectorAll('.nav-link').forEach(function (link) {
      link.addEventListener('click', function () {
        menu.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  function renderNav() {
    var mount = document.getElementById('site-nav-mount');
    if (!mount) return;
    mount.outerHTML = navMarkup();
    wireUpBehavior();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNav);
  } else {
    renderNav();
  }
})();
