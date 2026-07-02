/* ============================================================
   THATBROWNCRAFT — CMS LOADER
   File: cms-loader.js
   TEST REPO: thatbrowncraft/thatbrowncraft-cms-test

   Fetches all CMS content from GitHub raw files at runtime.
   No build step. No server. Free forever.

   To switch to production later, change this line:
     REPO = 'thatbrowncraft-cms-test'  →  'thatbrowncraft-website'
   ============================================================ */

const CMS = (() => {

  const USER   = 'thatbrowncraft';
  const REPO   = 'thatbrowncraft-cms-test';
  const BRANCH = 'main';

  const RAW = path =>
    `https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}/${path}`;
  const API = col =>
    `https://api.github.com/repos/${USER}/${REPO}/contents/content/${col}`;

  /* CMS image fields store root-relative paths like "/images/foo.png"
     (public_folder). That breaks on GitHub Pages project sites, where
     "/" resolves to the domain root, not the repo subpath. Resolve
     against the raw content host instead, same as everything else. */
  const IMG = path => path ? RAW(`public${path}`) : '';

  /* ── frontmatter parser ──
     Handles scalars, booleans, numbers, multiline | blocks,
     simple lists, and lists of objects (nested key: value pairs). */
  function parseFM(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text.trim() };
    const data = {}, body = m[2].trim();
    const lines = m[1].split('\n');
    let i = 0;

    function castVal(v) {
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (/^-?\d+$/.test(v)) return parseInt(v, 10);
      return v;
    }

    while (i < lines.length) {
      const line = lines[i];

      /* multiline | block */
      if (/^(\w+):\s*\|/.test(line)) {
        const key = line.match(/^(\w+):/)[1];
        i++; let val = '';
        while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
          val += lines[i].replace(/^  /, '') + '\n'; i++;
        }
        data[key] = val.trim(); continue;
      }

      /* list */
      if (/^(\w+):\s*$/.test(line) && !line.startsWith(' ')) {
        const key = line.match(/^(\w+)/)[1];
        data[key] = []; i++;
        while (i < lines.length && lines[i].startsWith('  ')) {
          const l = lines[i];
          if (/^  -\s*$/.test(l) || /^  - \w+:/.test(l)) {
            const obj = {};
            if (/^  - (\w+):\s*"?(.*?)"?\s*$/.test(l)) {
              const [, k, v] = l.match(/^  - (\w+):\s*"?(.*?)"?\s*$/);
              obj[k] = castVal(v);
            }
            i++;
            while (i < lines.length && /^    \w+:/.test(lines[i])) {
              const [, k, v] = lines[i].match(/^    (\w+):\s*"?(.*?)"?\s*$/);
              obj[k] = castVal(v);
              i++;
            }
            data[key].push(obj);
          } else {
            const sm = l.match(/^  - "?(.*?)"?\s*$/);
            if (sm) data[key].push(sm[1]);
            i++;
          }
        }
        continue;
      }

      /* scalar */
      const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
      if (kv && !line.startsWith(' ')) {
        data[kv[1]] = castVal(kv[2]);
      }
      i++;
    }
    return { data, body };
  }

  /* ── fetch entire collection ── */
  async function fetchCollection(folder) {
    try {
      const res = await fetch(API(folder));
      if (!res.ok) return [];
      const files = (await res.json()).filter(f => f.name.endsWith('.md'));
      return Promise.all(files.map(async f => {
        const r = await fetch(RAW(`content/${folder}/${f.name}`));
        const { data, body } = parseFM(await r.text());
        data._slug = f.name.replace('.md', '');
        return { data, body };
      }));
    } catch (e) {
      console.warn(`CMS collection fetch failed: ${folder}`, e);
      return [];
    }
  }

  /* ── fetch single settings file ── */
  async function fetchFile(path) {
    try {
      const r = await fetch(RAW(path));
      if (!r.ok) return { data: {}, body: '' };
      return parseFM(await r.text());
    } catch (e) {
      console.warn(`CMS file fetch failed: ${path}`, e);
      return { data: {}, body: '' };
    }
  }

  /* ── markdown to html ── */
  function md(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined') return marked.parse(text);
    return text.split(/\n\n+/)
      .map(p => `<p>${p.trim()
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, ' ')}</p>`)
      .join('');
  }

  /* ── helpers ── */

  /* Google Forms only accepts a silent POST at its .../formResponse
     endpoint. Authors naturally paste either the shortened forms.gle
     link or the full "Send" link ending in /viewform — neither one
     is postable as-is. Auto-upgrade /viewform → /formResponse so the
     author never has to know that endpoint exists.

     forms.gle can't be fixed here: it's a cross-origin redirect and
     the browser won't hand back the real destination URL (no CORS,
     opaque redirect, no readable Location header). If one shows up,
     warn clearly and skip the submission rather than silently
     POSTing to a link that will just drop the data. */
  function toFormResponseUrl(url) {
    if (!url) return '';
    const clean = url.trim().split('?')[0];
    if (/\/formResponse\/?$/.test(clean)) return clean;
    if (/\/viewform\/?$/.test(clean)) return clean.replace(/\/viewform\/?$/, '/formResponse');
    if (/forms\.gle\//.test(clean)) {
      console.warn(`[CMS] "${url}" is a shortened forms.gle link — Google Forms won't accept a silent submission at that address. Open the form → Send → copy the full link (ends in /viewform) into social.md instead.`);
      return '';
    }
    return clean;
  }

  function esc(s) {
    return (s ?? '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function slugify(s) {
    return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function stars(n) {
    const full = Math.min(parseInt(n) || 5, 5);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }
  function firstPara(body) {
    return (body || '').split(/\n\n+/)[0] || '';
  }
  function formatDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }

  /* ==========================================================
     PUBLIC METHODS
     ========================================================== */
  return {

    /* ────────────────────────────────────────────────────────
       SOCIAL + FORM LINKS
       Reads content/settings/social.md
       Populates: [data-cms="social-pills"]
       Wires:     [data-cms="form-crafties"] etc to Google Form URLs
       ──────────────────────────────────────────────────────── */
    async loadSocial() {
      const { data } = await fetchFile('content/settings/social.md');

      document.querySelectorAll('[data-cms="social-pills"]').forEach(el => {
        const pills = [
          data.wattpad   && { url: data.wattpad,   label: '📖 Wattpad'   },
          data.instagram && { url: data.instagram, label: '📸 Instagram' },
          data.spotify   && { url: data.spotify,   label: '🎵 Spotify'   },
          data.pinterest && { url: data.pinterest, label: '📌 Pinterest' }
        ].filter(Boolean);
        if (pills.length) {
          el.innerHTML = pills.map(p =>
            `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="social-pill">${p.label}</a>`
          ).join('');
        }
      });

      const forms = {
        'form-crafties': data.form_crafties,
        'form-reviews':  data.form_reviews,
        'form-fanart':   data.form_fanart,
        'form-contact':  data.form_contact
      };
      Object.entries(forms).forEach(([attr, url]) => {
        document.querySelectorAll(`[data-cms="${attr}"]`).forEach(el => {
          if (!url) return;
          el.addEventListener('click', e => {
            e.preventDefault();
            window.open(url, '_blank', 'noopener,noreferrer');
          });
          el.style.cursor = 'pointer';
        });
      });

      // ── Google Forms silent submission config ────────────────────────
      // The author adds these fields to content/settings/social.md:
      //
      //   form_postcard_url:          "https://docs.google.com/forms/d/e/XXXX/formResponse"
      //   form_postcard_entry_message: "entry.1234567890"
      //   form_postcard_entry_name:    "entry.0987654321"
      //   form_postcard_entry_category:"entry.1122334455"
      //
      //   form_review_url:             "https://docs.google.com/forms/d/e/XXXX/formResponse"
      //   form_review_entry_review:    "entry.XXXXXXXXXX"
      //   form_review_entry_name:      "entry.XXXXXXXXXX"
      //   form_review_entry_rating:    "entry.XXXXXXXXXX"
      //   form_review_entry_spoiler:   "entry.XXXXXXXXXX"
      //
      //   form_fanart_url:             "https://docs.google.com/forms/d/e/XXXX/formResponse"
      //   form_fanart_entry_name:      "entry.XXXXXXXXXX"
      //   form_fanart_entry_platform:  "entry.XXXXXXXXXX"
      //   form_fanart_entry_subject:   "entry.XXXXXXXXXX"
      //   form_fanart_entry_link:      "entry.XXXXXXXXXX"
      //   form_fanart_entry_note:      "entry.XXXXXXXXXX"
      //
      // To find entry IDs: open your Google Form → click the ⋮ menu →
      // "Get pre-filled link" → fill in dummy values → copy the link.
      // Each field shows up as entry.XXXXXXXXXX in the URL.
      window.__craftiesForms = {
        postcard: {
          url: toFormResponseUrl(data.form_postcard_url),
          fields: {
            name:     data.form_postcard_entry_name     || '',
            category: data.form_postcard_entry_category || '',
            message:  data.form_postcard_entry_message  || '',
            reply:    data.form_postcard_entry_reply    || '',
            email:    data.form_postcard_entry_email    || ''
          }
        },
        review: {
          url: toFormResponseUrl(data.form_review_url),
          fields: {
            review:  data.form_review_entry_review  || '',
            name:    data.form_review_entry_name    || '',
            rating:  data.form_review_entry_rating  || '',
            spoiler: data.form_review_entry_spoiler || ''
          }
        },
        fanart: {
          url: toFormResponseUrl(data.form_fanart_url),
          fields: {
            name:     data.form_fanart_entry_name     || '',
            platform: data.form_fanart_entry_platform || '',
            subject:  data.form_fanart_entry_subject  || '',
            link:     data.form_fanart_entry_link     || '',
            note:     data.form_fanart_entry_note     || ''
          }
        }
      };

      return data;
    },

    /* ────────────────────────────────────────────────────────
       BOOKS
       Reads content/books/*.md
       Targets: [data-cms="books-featured-shelf"]  (index.html hero book)
                [data-cms="books-list"]             (books.html full list)
       ──────────────────────────────────────────────────────── */
    async loadBooks() {
      const entries = await fetchCollection('books');
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.published_at || '').localeCompare(a.data.published_at || ''));

      const featured = published.find(e => e.data.is_featured) || published[0];

      document.querySelectorAll('[data-cms="books-featured-shelf"]').forEach(el => {
        if (!featured) {
          el.innerHTML = '<p class="cms-empty">No books published yet. Add one from the dashboard.</p>';
          return;
        }
        el.innerHTML = this._featuredBookHTML(featured);
      });

      document.querySelectorAll('[data-cms="books-list"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No books published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = published.map((e) => this._bookEntryHTML(e)).join(
          '<div class="book-separator" aria-hidden="true"></div>'
        );
        this._initBookQuoteCarousels(published);
      });

      return published;
    },

    _featuredBookHTML({ data }) {
      const cover = data.cover_image
        ? `<img src="${esc(IMG(data.cover_image))}" alt="${esc(data.title)} cover" style="width:100%;height:100%;object-fit:cover">`
        : `<div class="book-cover-ph"><span class="ph-icon">📕</span><span class="ph-title">${esc(data.title)}</span></div>`;
      const tags = Array.isArray(data.genres)
        ? data.genres.map(g => `<span class="book-tag">${esc(g)}</span>`).join('')
        : '';
      const links = [
        data.wattpad_url   && `<a href="${esc(data.wattpad_url)}" target="_blank" rel="noopener noreferrer" class="read-btn primary">📖 Read on Wattpad</a>`,
        data.paperback_url && `<a href="${esc(data.paperback_url)}" target="_blank" rel="noopener noreferrer" class="read-btn">📦 Paperback</a>`,
        data.kindle_url    && `<a href="${esc(data.kindle_url)}" target="_blank" rel="noopener noreferrer" class="read-btn">📱 Kindle</a>`
      ].filter(Boolean).join('');
      const quote = data.featured_quote
        ? `<div class="book-quote"><p>${esc(data.featured_quote)}</p></div>`
        : '';

      return `
        <div class="book-on-shelf reveal">
          <div class="book-cover-frame">${cover}</div>
          <div class="book-shelf-plank"></div>
          <div class="book-shelf-shadow"></div>
        </div>
        <div class="reveal reveal-delay-2">
          <span class="section-eyebrow">Featured Book</span>
          ${data.series_name ? `<span class="book-series-label">${esc(data.series_name)}${data.series_number ? ' — ' + esc(data.series_number) : ''}</span>` : ''}
          <h2 class="book-title-large" id="featured-title">${esc(data.title)}</h2>
          <p class="book-synopsis">${esc(firstPara(data.body || ''))}</p>
          ${tags ? `<div class="book-tags">${tags}</div>` : ''}
          ${links ? `<div class="book-read-links">${links}</div>` : ''}
          <a href="books.html#book-${esc(data._slug)}-title" class="btn-library">Full Book Details</a>
          ${quote}
        </div>`;
    },

    _bookEntryHTML({ data, body }) {
      const cover = data.cover_image
        ? `<img src="${esc(IMG(data.cover_image))}" alt="${esc(data.title)} cover" style="width:100%;height:100%;object-fit:cover">`
        : `<div class="cover-ph"><span class="cover-ph-icon">📕</span><span class="cover-ph-title">${esc(data.title)}</span>${data.series_number ? `<span class="cover-ph-series">${esc(data.series_number)}</span>` : ''}</div>`;
      const badge = data.status === 'published'
        ? '<span class="cover-badge badge-live">Live Now</span>'
        : '<span class="cover-badge badge-soon">Coming Soon</span>';
      const tags = Array.isArray(data.genres)
        ? data.genres.map(g => `<span class="tag-chip">${esc(g)}</span>`).join('') : '';
      const tropes = Array.isArray(data.tropes)
        ? data.tropes.map(t => `<span class="tag-chip">${esc(t.trope || t)}</span>`).join('') : '';
      const synopsisHTML = body ? body.split(/\n\n+/).map(p => `<p class="book-synopsis">${esc(p)}</p>`).join('') : '';
      const links = [
        data.wattpad_url   && `<a href="${esc(data.wattpad_url)}" target="_blank" rel="noopener noreferrer" class="read-link primary">📖 Read on Wattpad</a>`,
        data.paperback_url && `<a href="${esc(data.paperback_url)}" target="_blank" rel="noopener noreferrer" class="read-link">📦 Paperback</a>`,
        data.kindle_url    && `<a href="${esc(data.kindle_url)}" target="_blank" rel="noopener noreferrer" class="read-link">📱 Kindle</a>`,
        data.inkitt_url    && `<a href="${esc(data.inkitt_url)}" target="_blank" rel="noopener noreferrer" class="read-link">🔗 Inkitt</a>`
      ].filter(Boolean).join('');

      const quotes = Array.isArray(data.quotes) && data.quotes.length ? data.quotes : null;
      const quotesHTML = quotes ? `
        <div class="quotes-block">
          <span class="quotes-label">From the Book</span>
          <div class="quote-carousel" id="quotes-${esc(data._slug)}">
            ${quotes.map((q, qi) => `
              <div class="quote-slide${qi === 0 ? ' active' : ''}">
                <p>${esc(q.text)}</p>
                ${q.context ? `<span class="quote-context">${esc(q.context)}</span>` : ''}
              </div>`).join('')}
          </div>
          <div class="quote-nav" id="quote-nav-${esc(data._slug)}" aria-label="Quote navigation">
            ${quotes.map((_, qi) => `<button class="quote-dot${qi === 0 ? ' active' : ''}" data-book="${esc(data._slug)}" data-index="${qi}" aria-label="Quote ${qi + 1}"></button>`).join('')}
          </div>
        </div>` : '';

      const leads = Array.isArray(data.character_leads) && data.character_leads.length ? `
        <div class="char-aesthetics">
          <span class="char-aesthetics-label">Lead Characters</span>
          <div class="char-tile-row">
            ${data.character_leads.map(c => {
              const name = c.name || c;
              return `<a href="characters.html#card-${esc(slugify(name))}" class="char-tile">
                <div class="char-tile-img">🌸</div>
                <span class="char-tile-name">${esc(name)}</span>
              </a>`;
            }).join('')}
          </div>
        </div>` : '';

      return `
        <article class="book-entry reveal" aria-labelledby="book-${esc(data._slug)}-title" data-book-slug="${esc(data._slug)}">
          <div class="book-layout">
            <div class="book-cover-col">
              <div class="book-3d">
                <div class="cover-face">${badge}${cover}</div>
                <div class="cover-shelf"></div>
                <div class="cover-shelf-shadow"></div>
              </div>
            </div>
            <div class="book-content-col">
              ${data.series_name ? `<span class="book-series-tag">${esc(data.series_name)}${data.series_number ? ' — ' + esc(data.series_number) : ''}</span>` : ''}
              <h2 class="book-main-title" id="book-${esc(data._slug)}-title">${esc(data.title)}</h2>
              ${(tags || tropes) ? `<div class="tag-row">${tags}${tropes}</div>` : ''}
              ${synopsisHTML}
              ${links ? `<div class="reading-links">${links}</div>` : ''}
              ${quotesHTML}
              ${leads}
            </div>
          </div>
        </article>`;
    },

    _initBookQuoteCarousels(books) {
      books.forEach(({ data }) => {
        const container = document.getElementById('quotes-' + data._slug);
        const navEl = document.getElementById('quote-nav-' + data._slug);
        if (!container || !navEl) return;
        const slides = container.querySelectorAll('.quote-slide');
        const dots = navEl.querySelectorAll('.quote-dot');
        if (slides.length < 2) return;
        let current = 0, timer;
        function goTo(i) {
          slides[current].classList.remove('active');
          dots[current].classList.remove('active');
          current = i;
          slides[current].classList.add('active');
          dots[current].classList.add('active');
        }
        function next() { goTo((current + 1) % slides.length); }
        function start() { timer = setInterval(next, 5000); }
        function stop() { clearInterval(timer); }
        dots.forEach(dot => {
          dot.addEventListener('click', () => {
            stop(); goTo(parseInt(dot.dataset.index)); start();
          });
        });
        start();
      });
    },

    /* ────────────────────────────────────────────────────────
       CHARACTERS
       Reads content/characters/*.md
       Targets: [data-cms="characters-polaroids"]  (index.html preview)
                [data-cms="characters-grid"]        (characters.html full vault)
       ──────────────────────────────────────────────────────── */
    async loadCharacters() {
      const entries = await fetchCollection('characters');
      const published = entries
        .filter(e => e.data.status === 'published' && e.data.is_featured !== false)
        .sort((a, b) => (parseInt(a.data.display_order) || 99) - (parseInt(b.data.display_order) || 99));

      document.querySelectorAll('[data-cms="characters-polaroids"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No characters published yet.</p>';
          return;
        }
        const preview = published.slice(0, 6);
        el.innerHTML = preview.map(({ data }) => `
          <a href="characters.html#card-${esc(slugify(data.name))}" class="polaroid reveal">
            <div class="polaroid-image">
              ${data.illustration ? `<img src="${esc(IMG(data.illustration))}" alt="${esc(data.name)}" style="width:100%;height:100%;object-fit:cover">` : '<span class="ph-emoji">🌸</span>'}
            </div>
            <span class="polaroid-name">${esc(data.name)}</span>
            <span class="polaroid-role">${esc(data.occupation || data.book || '')}</span>
          </a>`).join('') +
          `<a href="characters.html" class="polaroid-see-all reveal"><span>→</span><span>Meet the full cast</span></a>`;
      });

      document.querySelectorAll('[data-cms="characters-grid"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No characters published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = published.map(e => this._charCardHTML(e)).join('');
      });

      return published;
    },

    _charCardHTML({ data, body }) {
      const slug = slugify(data.name);
      const initial = (data.name || '?')[0];
      const portrait = data.illustration
        ? `<img src="${esc(IMG(data.illustration))}" alt="${esc(data.name)}" style="width:100%;height:100%;object-fit:cover">`
        : `<div class="char-portrait-ph"><span class="portrait-ph-initial">${esc(initial)}</span></div>`;
      const likes = Array.isArray(data.likes)
        ? data.likes.map(l => `<span class="like-chip">${esc(l.item || l)}</span>`).join('') : '';
      const dislikes = Array.isArray(data.dislikes)
        ? data.dislikes.map(d => `<span class="exp-dislike-chip">${esc(d.item || d)}</span>`).join('') : '';
      const trivia = Array.isArray(data.trivia)
        ? data.trivia.map(t => `<li class="trivia-item"><span class="trivia-dot"></span>${esc(t.fact || t)}</li>`).join('') : '';
      const tagline = body ? esc(firstPara(body)) : '';
      const personality = body ? esc(body) : '';

      return `
        <div class="char-card reveal" data-book="${esc(slugify(data.book || ''))}" data-role="${esc(data.role || 'lead')}" id="card-${esc(slug)}">
          <div class="char-portrait">
            ${portrait}
            <div class="char-portrait-overlay"></div>
            <div class="char-nameplate">
              <div class="char-name">${esc(data.name)}</div>
              <div class="char-role">${esc(data.role === 'supporting' ? 'Supporting' : 'Lead')}${data.book ? ' · ' + esc(data.book) : ''}</div>
            </div>
          </div>
          <div class="char-info">
            ${tagline ? `<p class="char-tagline">"${tagline}"</p>` : ''}
            <div class="char-details">
              ${data.age ? `<div class="char-detail-item"><span class="char-detail-label">Age</span><span class="char-detail-value">${esc(data.age)}</span></div>` : ''}
              ${data.occupation ? `<div class="char-detail-item"><span class="char-detail-label">Occupation</span><span class="char-detail-value">${esc(data.occupation)}</span></div>` : ''}
            </div>
            ${likes ? `<div class="char-likes">${likes}</div>` : ''}
            ${data.theme_song ? `<div class="char-song"><span class="song-icon">🎵</span><span>Theme: ${esc(data.theme_song)}</span></div>` : ''}
          </div>
          <button class="char-expand-btn" onclick="toggleExpand('${esc(slug)}')">
            Full Profile <span class="expand-arrow">↓</span>
          </button>
          <div class="char-expanded-panel" id="expand-${esc(slug)}">
            ${personality ? `<div class="exp-section"><span class="exp-label">Personality</span><p class="exp-text">${personality}</p></div>` : ''}
            ${dislikes ? `<div class="exp-section"><span class="exp-label">Dislikes</span><div>${dislikes}</div></div>` : ''}
            ${trivia ? `<div class="exp-section"><span class="exp-label">Trivia</span><ul class="trivia-list">${trivia}</ul></div>` : ''}
            ${data.author_note ? `<div class="exp-section"><span class="exp-label">Author's Note</span><div class="author-note-block"><p>${esc(data.author_note)}</p></div></div>` : ''}
            ${data.playlist_url ? `<div class="exp-section"><span class="exp-label">Character Playlist</span><a href="${esc(data.playlist_url)}" target="_blank" rel="noopener noreferrer" class="playlist-link">🎵 Open ${esc(data.name)}'s Playlist</a></div>` : ''}
          </div>
        </div>`;
    },

    /* ────────────────────────────────────────────────────────
       BONUS SCENES
       Reads content/bonus-scenes/*.md
       Targets: [data-cms="bonus-preview"]  (index.html — first 3)
                [data-cms="bonus-grid"]      (bonus.html full list)
                [data-cms="bonus-modal-host"] (single reusable modal container)
       ──────────────────────────────────────────────────────── */
    async loadBonusScenes() {
      const entries = await fetchCollection('bonus-scenes');
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.published_at || '').localeCompare(a.data.published_at || ''));

      const typeLabels = {
        bonus_scene: 'Bonus Scene', deleted_scene: 'Deleted Scene',
        character_pov: 'Character POV', festival_special: 'Festival Special',
        birthday_special: 'Birthday Special', letter: 'Letter',
        mini_story: 'Mini Story', alternative_ending: 'Alternative Ending'
      };
      const sealIcons = {
        bonus_scene: '✦', deleted_scene: '✂', character_pov: '🪷',
        festival_special: '🪔', birthday_special: '🎂', letter: '✉',
        mini_story: '📖', alternative_ending: '🔀'
      };

      document.querySelectorAll('[data-cms="bonus-preview"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No bonus scenes published yet.</p>';
          return;
        }
        el.innerHTML = published.slice(0, 3).map(({ data }) => `
          <a href="bonus.html#scene-${esc(data._slug)}" class="letter-card reveal">
            <div class="letter-seal" aria-hidden="true">${sealIcons[data.scene_type] || '✦'}</div>
            <span class="letter-tag">${esc((data.characters || []).map(c => c.name || c).join(' × ')) || typeLabels[data.scene_type] || ''}</span>
            <h3 class="letter-title">${esc(data.title)}</h3>
            <p class="letter-excerpt">${esc(data.teaser || '')}</p>
            <span class="letter-read">Read the scene →</span>
          </a>`).join('');
      });

      document.querySelectorAll('[data-cms="bonus-grid"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No bonus scenes published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = published.map(({ data }) => `
          <div class="letter-card reveal" data-type="${esc(data.scene_type || 'bonus_scene')}" onclick="openScene('${esc(data._slug)}')">
            <div class="letter-torn-top"></div>
            <div class="letter-body">
              <div class="wax-seal" aria-hidden="true">${sealIcons[data.scene_type] || '✦'}</div>
              <span class="scene-type-tag">${typeLabels[data.scene_type] || 'Bonus Scene'}</span>
              <span class="couple-tag">${esc((data.characters || []).map(c => c.name || c).join(' × ')) || esc(data.book || '')}</span>
              <h2 class="letter-title">${esc(data.title)}</h2>
              <p class="letter-excerpt">${esc(data.teaser || '')}</p>
              <span class="letter-read-hint">Read the scene →</span>
            </div>
            <div class="letter-torn-bottom"></div>
          </div>`).join('');
      });

      const modalHost = document.querySelector('[data-cms="bonus-modal-host"]');
      if (modalHost) {
        modalHost.innerHTML = `
          <div class="scene-modal" id="cms-scene-modal" role="dialog" aria-modal="true">
            <div class="scene-modal-box">
              <button class="scene-modal-close" onclick="closeScene()" aria-label="Close">×</button>
              <div class="scene-modal-torn-top"></div>
              <div class="scene-modal-content">
                <span class="modal-scene-type" id="cms-modal-type"></span>
                <span class="modal-couple" id="cms-modal-couple"></span>
                <h2 class="modal-scene-title" id="cms-modal-title"></h2>
                <p class="modal-author-note" id="cms-modal-note" style="display:none"></p>
                <div class="modal-scene-text" id="cms-modal-text"></div>
                <div class="scene-end-ornament">✦ end of scene ✦</div>
                <button class="btn-back-scene" onclick="closeScene()">← Back to all scenes</button>
              </div>
            </div>
          </div>`;

        const sceneMap = {};
        published.forEach(({ data, body }) => { sceneMap[data._slug] = { data, body }; });

        window.openScene = function (slug) {
          const entry = sceneMap[slug];
          if (!entry) return;
          const { data, body } = entry;
          document.getElementById('cms-modal-type').textContent = `${typeLabels[data.scene_type] || 'Bonus Scene'} · ${data.book || ''}`;
          document.getElementById('cms-modal-couple').textContent = (data.characters || []).map(c => c.name || c).join(' × ');
          document.getElementById('cms-modal-title').textContent = data.title || '';
          const noteEl = document.getElementById('cms-modal-note');
          if (data.author_note) { noteEl.textContent = data.author_note; noteEl.style.display = ''; }
          else { noteEl.style.display = 'none'; }
          document.getElementById('cms-modal-text').innerHTML = md(body || '');
          document.getElementById('cms-scene-modal').classList.add('open');
          document.body.style.overflow = 'hidden';
        };
        window.closeScene = function () {
          const modal = document.getElementById('cms-scene-modal');
          if (modal) modal.classList.remove('open');
          document.body.style.overflow = '';
        };
        document.getElementById('cms-scene-modal')?.addEventListener('click', e => {
          if (e.target.id === 'cms-scene-modal') window.closeScene();
        });
        document.addEventListener('keydown', e => {
          if (e.key === 'Escape') window.closeScene();
        });

        if (location.hash.startsWith('#scene-')) {
          window.openScene(location.hash.replace('#scene-', ''));
        }
      }

      return published;
    },

    /* ────────────────────────────────────────────────────────
       KANHA'S COURTYARD
       Reads content/kanha/*.md
       Targets: [data-cms="kanha-preview"]  (index.html — 1 featured verse)
                [data-cms="kanha-verses"]    (kanha.html full list)
                [data-cms="kanha-chapter-pills"] (jump nav)
       ──────────────────────────────────────────────────────── */
    async loadKanha() {
      const entries = await fetchCollection('kanha');
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (parseInt(a.data.gita_chapter) || 99) - (parseInt(b.data.gita_chapter) || 99));

      const chapterNames = {
        1: 'Arjuna Vishada', 2: 'Sankhya', 3: 'Karma', 4: 'Jnana',
        5: 'Karma Vairagya', 6: 'Dhyana', 7: 'Jnana Vijnana', 8: 'Akshara Brahma',
        9: 'Raja Vidya', 10: 'Vibhuti', 11: 'Vishwarupa', 12: 'Bhakti',
        13: 'Kshetra Kshetrajna', 14: 'Gunatraya Vibhaga', 15: 'Purushottama',
        16: 'Daivasura Sampad', 17: 'Shraddhatraya Vibhaga', 18: 'Moksha'
      };

      document.querySelectorAll('[data-cms="kanha-preview"]').forEach(el => {
        const featured = published.find(e => e.data.is_featured) || published[0];
        if (!featured) {
          el.innerHTML = '<p class="cms-empty">No verses published yet.</p>';
          return;
        }
        const { data, body } = featured;
        el.innerHTML = `
          <span class="verse-chapter">Chapter ${esc(data.gita_chapter)} · ${esc(chapterNames[data.gita_chapter] || '')} Yoga</span>
          ${data.sanskrit_text ? `<p class="verse-sanskrit">${esc(data.sanskrit_text)}</p>` : ''}
          ${data.english_meaning ? `<p class="verse-meaning">"${esc(data.english_meaning)}"</p>` : ''}
          <p class="verse-reflection">${esc(firstPara(body))}</p>
          <span class="verse-lotus" aria-hidden="true">🪷</span>`;
      });

      document.querySelectorAll('[data-cms="kanha-verses"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No verses published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = published.map(({ data, body }, i) => `
          <div class="verse-entry reveal" id="ch${esc(data.gita_chapter)}">
            <div class="verse-card">
              <div class="verse-card-glow"></div>
              <span class="verse-chapter-label">Chapter ${esc(data.gita_chapter)} · ${esc(chapterNames[data.gita_chapter] || '')} Yoga${data.title ? ' · ' + esc(data.title) : ''}</span>
              ${data.sanskrit_text ? `<p class="verse-sanskrit">${esc(data.sanskrit_text)}</p>` : ''}
              ${data.english_meaning ? `<p class="verse-meaning">"${esc(data.english_meaning)}"</p>` : ''}
              <div class="verse-rule"></div>
              <p class="verse-reflection">${esc(body)}</p>
              <span class="verse-lotus" aria-hidden="true">🪷</span>
            </div>
          </div>
          ${i < published.length - 1 ? `<div class="verse-divider reveal" aria-hidden="true"><div class="vd-line"></div><span class="vd-icon">🪈</span><div class="vd-line"></div></div>` : ''}
        `).join('');
      });

      document.querySelectorAll('[data-cms="kanha-chapter-pills"]').forEach(el => {
        if (!published.length) return;
        el.innerHTML = published.map(({ data }) =>
          `<button class="chapter-pill" onclick="jumpTo('ch${esc(data.gita_chapter)}')">Ch ${esc(data.gita_chapter)} · ${esc(chapterNames[data.gita_chapter] || '')}</button>`
        ).join('');
      });

      return published;
    },

    /* ────────────────────────────────────────────────────────
       AUTHOR UPDATES — latest preview (used on index.html only)
       Full updates.html has its own self-contained fetch logic
       and does not use this loader.
       Reads content/updates/*.md
       Target: [data-cms="updates-latest"]
       ──────────────────────────────────────────────────────── */
    async loadUpdatesPreview() {
      const entries = await fetchCollection('updates');
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.date || '').localeCompare(a.data.date || ''))
        .slice(0, 3);

      document.querySelectorAll('[data-cms="updates-latest"]').forEach(el => {
        if (!published.length) {
          el.innerHTML = '<p class="cms-empty">No updates yet.</p>';
          return;
        }
        el.innerHTML = published.map(({ data, body }) => `
          <div class="update-preview">
            <span class="update-date">${formatDate(data.date)}</span>
            <h4 class="update-title">${esc(data.title)}</h4>
            <p class="update-excerpt">${esc(data.excerpt || firstPara(body))}</p>
          </div>`).join('');
      });

      return published;
    },

    /* ────────────────────────────────────────────────────────
       FEATURED REVIEWS
       Reads content/featured-reviews/*.md
       Targets: [data-cms="reviews-grid"]      (crafties.html, hall-of-fame.html)
                [data-cms="reviews-featured"]  (single pinned blockquote, if present)
       ──────────────────────────────────────────────────────── */
    async loadReviews() {
      const entries = await fetchCollection('featured-reviews');
      const sorted = [...entries].sort((a, b) =>
        (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

      document.querySelectorAll('[data-cms="reviews-grid"], [data-cms="hof-reviews"]').forEach(el => {
        if (!sorted.length) {
          el.innerHTML = '<p class="cms-empty">No reviews yet. Be the first to leave one.</p>';
          return;
        }
        el.innerHTML = sorted.map(({ data, body }) => `
          <div class="review-card${data.is_pinned ? ' pinned' : ''} reveal">
            ${data.is_pinned ? '<span class="review-pin">📌 pinned</span>' : ''}
            <div class="review-stars">${stars(data.rating).split('').map(s => `<span class="review-star${s === '☆' ? ' empty' : ''}">★</span>`).join('')}</div>
            <p class="review-text">${esc(firstPara(body))}</p>
            <div class="review-meta">
              <div class="review-avatar">📖</div>
              <div><div class="review-name">${esc(data.reader_handle || data.reader_name || '')}</div><div class="review-book">${esc(data.book || '')}</div></div>
            </div>
          </div>`).join('');
      });

      document.querySelectorAll('[data-cms="reviews-featured"]').forEach(el => {
        const pinned = sorted.find(e => e.data.is_pinned) || sorted[0];
        if (!pinned) return;
        el.innerHTML = `
          <blockquote class="featured-review">
            <p>${esc(firstPara(pinned.body))}</p>
            <cite>${esc(pinned.data.reader_handle || pinned.data.reader_name || '')}</cite>
          </blockquote>`;
      });

      return sorted;
    },

    /* ────────────────────────────────────────────────────────
       FAN ART
       Reads content/fan-art/*.md
       Target: [data-cms="fanart-grid"]
       ──────────────────────────────────────────────────────── */
    async loadFanArt() {
      const entries = await fetchCollection('fan-art');
      const featured = entries.filter(e => e.data.is_featured !== false);

      document.querySelectorAll('[data-cms="fanart-grid"], [data-cms="hof-fanart"]').forEach(el => {
        if (!featured.length) {
          el.innerHTML = '<p class="cms-empty">No fan art yet. Submit yours through the Crafties Post Office.</p>';
          return;
        }
        el.innerHTML = featured.map(({ data }) => {
          const ext = data.external_link || '';
          const img = data.image
            ? `<img src="${esc(IMG(data.image))}" alt="${esc(data.artist_name || 'Fan art')}" class="fanart-img" loading="lazy">`
            : `<div class="fanart-img-placeholder">art coming soon</div>`;
          return `
            <div class="fanart-card reveal">
              ${ext ? `<a href="${esc(ext)}" target="_blank" rel="noopener noreferrer">${img}</a>` : img}
              <div class="fanart-info">
                <span class="fanart-artist">${esc(data.artist_name || '')}${data.artist_handle ? ' — ' + esc(data.artist_handle) : ''}</span>
                <span class="fanart-caption">${esc(data.description || data.book_or_character || '')}</span>
              </div>
            </div>`;
        }).join('');
      });

      return featured;
    },

    /* ────────────────────────────────────────────────────────
       HALL OF FAME
       Reads content/hall-of-fame/*.md
       Maps entry_type to the matching section on hall-of-fame.html:
         featured_reader → hof-crafties
         theorist        → hof-theories
         reader_letter   → hof-comments
         reaction_wall   → hof-quotes
       ──────────────────────────────────────────────────────── */
    async loadHallOfFame() {
      const entries = await fetchCollection('hall-of-fame');
      const published = entries.filter(e => e.data.status === 'published');

      const byType = type => published
        .filter(e => e.data.entry_type === type)
        .sort((a, b) => (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

      document.querySelectorAll('[data-cms="hof-crafties"]').forEach(el => {
        const items = byType('featured_reader');
        if (!items.length) { el.innerHTML = '<p class="cms-empty">No featured readers yet.</p>'; return; }
        const badges = ['🌟', '💌', '🔥', '🪔', '☕', '📖'];
        el.innerHTML = items.map(({ data }, i) => `
          <div class="craftie-card reveal">
            <span class="craftie-badge">${badges[i % badges.length]}</span>
            <div class="craftie-name">${esc(data.reader_name)}</div>
            ${data.reader_handle ? `<span class="craftie-handle">${esc(data.reader_handle)}</span>` : ''}
            <p class="craftie-note">${esc(data.author_note_about_reader || '')}</p>
          </div>`).join('');
      });

      document.querySelectorAll('[data-cms="hof-theories"]').forEach(el => {
        const items = byType('theorist');
        if (!items.length) { el.innerHTML = '<p class="cms-empty">No theories yet.</p>'; return; }
        el.innerHTML = items.map(({ data, body }) => `
          <div class="theory-card reveal">
            <span class="theory-label">Theory${data.theory_correct === 'correct' ? ' · ✓ correct' : data.theory_correct === 'wrong' ? ' · ✗ wrong but fun' : ''}</span>
            <h3 class="theory-title">${esc(data.theory_title || '')}</h3>
            <p class="theory-body">${esc(firstPara(body))}</p>
            <div class="theory-footer">
              <span class="theory-reader">${esc(data.reader_handle || data.reader_name || '')}</span>
              ${data.related_book ? `<span class="theory-ref">${esc(data.related_book)}</span>` : ''}
            </div>
          </div>`).join('');
      });

      document.querySelectorAll('[data-cms="hof-comments"]').forEach(el => {
        const items = byType('reader_letter');
        if (!items.length) { el.innerHTML = '<p class="cms-empty">No comments yet.</p>'; return; }
        el.innerHTML = items.map(({ data, body }) => `
          <div class="comment-card${data.is_pinned ? ' pinned' : ''} reveal">
            <span class="comment-quote-mark">"</span>
            <p class="comment-text">${esc(firstPara(body))}</p>
            <div class="comment-meta">
              <span class="comment-reader">${esc(data.reader_handle || data.reader_name || '')}</span>
              ${data.related_book ? `<span class="comment-chapter">${esc(data.related_book)}</span>` : ''}
            </div>
          </div>`).join('');
      });

      document.querySelectorAll('[data-cms="hof-quotes"]').forEach(el => {
        const items = byType('reaction_wall');
        if (!items.length) { el.innerHTML = '<p class="cms-empty">No quotes yet.</p>'; return; }
        el.innerHTML = items.map(({ data, body }) => `
          <div class="quote-card reveal">
            <p class="quote-text">"${esc(firstPara(body))}"</p>
            <span class="quote-reader">— ${esc(data.reader_handle || data.reader_name || '')}</span>
          </div>`).join('');
      });

      return published;
    },

    /* ────────────────────────────────────────────────────────
       INIT — scans page for data-cms targets and loads only what's needed
       ──────────────────────────────────────────────────────── */
    async init() {
      const has = attr => !!document.querySelector(`[data-cms="${attr}"]`);
      const jobs = [];

      if (has('social-pills') || has('form-crafties') || has('form-reviews') ||
          has('form-fanart')  || has('form-contact'))
        jobs.push(this.loadSocial());

      if (has('books-featured-shelf') || has('books-list'))
        jobs.push(this.loadBooks());

      if (has('characters-polaroids') || has('characters-grid'))
        jobs.push(this.loadCharacters());

      if (has('bonus-preview') || has('bonus-grid'))
        jobs.push(this.loadBonusScenes());

      if (has('kanha-preview') || has('kanha-verses') || has('kanha-chapter-pills'))
        jobs.push(this.loadKanha());

      if (has('updates-latest'))
        jobs.push(this.loadUpdatesPreview());

      if (has('reviews-grid') || has('reviews-featured') || has('hof-reviews'))
        jobs.push(this.loadReviews());

      if (has('fanart-grid') || has('hof-fanart'))
        jobs.push(this.loadFanArt());

      if (has('hof-crafties') || has('hof-theories') || has('hof-comments') || has('hof-quotes'))
        jobs.push(this.loadHallOfFame());

      await Promise.allSettled(jobs);

      /* Re-trigger scroll reveal for newly injected .reveal elements,
         since the page's own IntersectionObserver already ran on DOMContentLoaded
         before this content existed. */
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const ro = new IntersectionObserver(es => {
          es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('visible'); ro.unobserve(x.target); } });
        }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
        document.querySelectorAll('.reveal:not(.visible)').forEach(el => ro.observe(el));
      } else {
        document.querySelectorAll('.reveal:not(.visible)').forEach(el => el.classList.add('visible'));
      }
    }
  };
})();

/* Auto-init when DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => CMS.init());
} else {
  CMS.init();
}
