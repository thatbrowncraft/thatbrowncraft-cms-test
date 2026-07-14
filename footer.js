/* ============================================================
   SHARED SITE FOOTER
   ------------------------------------------------------------
   One canonical footer, injected into every page. Edit the
   FOOTER_LINKS list below to add/remove/reorder footer nav
   links site-wide — no page needs to be touched individually.

   Each page just needs:
     1. An empty mount point where the footer used to be:
          <div id="site-footer-mount"></div>
     2. This script included (defer), e.g.:
          <script src="footer.js" defer></script>

   Markup, classes and layout match the original per-page
   footer exactly, so no CSS or design changes needed.

   SOCIAL BUTTONS
   The footer-social container is rendered empty on purpose,
   carrying only data-cms="social-pills". cms-loader.js
   (loadSocial) is the ONLY thing that ever populates it, by
   reading content/settings/social.md — one pill per platform
   that has a URL set there. Nothing here is hardcoded, so a
   platform with no CMS value never shows a button, and a new
   platform added to the CMS later appears automatically with
   zero HTML/JS changes.

   NOTE ON LOAD ORDER
   This script must run (and finish injecting the footer)
   before cms-loader.js runs, so that cms-loader.js finds the
   data-cms="social-pills" / data-cms="footer-tagline" mounts
   already in the DOM. In every page, footer.js is included
   with defer, before the cms-loader.js <script> tag — deferred
   scripts execute in source order, so this is guaranteed.
   ============================================================ */
(function () {
  var FOOTER_LINKS = [
    { href: 'index.html',       label: 'Home' },
    { href: 'books.html',       label: 'Books' },
    { href: 'characters.html',  label: 'Characters' },
    { href: 'bonus.html',       label: 'One More Chapter' },
    { href: 'crafties.html',    label: 'Crafties' },
    { href: 'post-office.html', label: 'Post Office' },
    { href: 'kanha.html',       label: "Kanha's Corner" },
    { href: 'hall-of-fame.html', label: 'Hall of Fame' },
    { href: 'updates.html',     label: 'Updates' },
    { href: 'about.html',       label: 'About' },
    { href: 'links.html',       label: 'Find Me' }
  ];

  function buildFooterLinks() {
    return FOOTER_LINKS.map(function (l) {
      return '<a href="' + l.href + '" class="footer-link">' + l.label + '</a>';
    }).join('');
  }

  function footerMarkup() {
    return (
      '<footer class="site-footer">' +
        '<div class="footer-inner">' +

          '<div class="footer-logo" aria-label="thatbrowncraft">' +
            '<span class="fl-that">that</span><span class="fl-brown">brown</span><span class="fl-craft">craft</span>' +
          '</div>' +

          '<p class="footer-tagline" data-cms="footer-tagline">stories brewed in chai &amp; candlelight</p>' +

          '<div class="footer-social" data-cms="social-pills"></div>' +

          '<nav class="footer-links" aria-label="Footer navigation">' + buildFooterLinks() + '</nav>' +

          '<div class="footer-rule"></div>' +
          '<p class="footer-copy"><span id="copyright-year"></span> thatbrowncraft. All stories, characters, and words belong to their author.</p>' +

        '</div>' +
      '</footer>'
    );
  }

  function fillCopyrightYear() {
    document.querySelectorAll('#copyright-year').forEach(function (el) {
      el.textContent = '© ' + new Date().getFullYear();
    });
  }

  function renderFooter() {
    var mount = document.getElementById('site-footer-mount');
    if (!mount) return;
    mount.outerHTML = footerMarkup();
    fillCopyrightYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderFooter);
  } else {
    renderFooter();
  }
})();
