/* ============================================================
   THATBROWNCRAFT — CMS LOADER
   File: cms-loader.js
   TEST REPO: thatbrowncraft/thatbrowncraft-cms-test

   Fetches all CMS content from GitHub raw files at runtime.
   No build step. No server. Free forever.

   To switch to production later, change these two lines:
     USER = 'thatbrowncraft'
     REPO = 'thatbrowncraft-cms-test'
   ============================================================ */

const CMS = (() => {

  const USER   = 'thatbrowncraft';
  const REPO   = 'thatbrowncraft-cms-test';
  const BRANCH = 'main';

  const RAW = path =>
    `https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}/${path}`;
  const API = col =>
    `https://api.github.com/repos/${USER}/${REPO}/contents/content/${col}`;

  /* ── frontmatter parser ── */
  function parseFM(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text.trim() };
    const data = {}, body = m[2].trim();
    const lines = m[1].split('\n');
    let i = 0;

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
              obj[k] = v;
            }
            i++;
            while (i < lines.length && /^    \w+:/.test(lines[i])) {
              const [, k, v] = lines[i].match(/^    (\w+):\s*"?(.*?)"?\s*$/);
              obj[k] = v === 'true' ? true : v === 'false' ? false : v;
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
        data[kv[1]] = kv[2] === 'true' ? true
                    : kv[2] === 'false' ? false
                    : kv[2];
      }
      i++;
    }
    return { data, body };
  }

  /* ── fetch entire collection ── */
  async function fetchCollection(folder) {
    const res = await fetch(API(folder));
    if (!res.ok) return [];
    const files = (await res.json()).filter(f => f.name.endsWith('.md'));
    return Promise.all(files.map(async f => {
      const r = await fetch(RAW(`content/${folder}/${f.name}`));
      const { data, body } = parseFM(await r.text());
      data._slug = f.name.replace('.md', '');
      return { data, body };
    }));
  }

  /* ── fetch single settings file ── */
  async function fetchFile(path) {
    const r = await fetch(RAW(path));
    if (!r.ok) return { data: {}, body: '' };
    return parseFM(await r.text());
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

  /* ── star renderer ── */
  function stars(n) {
    return '★'.repeat(Math.min(parseInt(n) || 5, 5));
  }

  /* ==========================================================
     PUBLIC METHODS
     ========================================================== */
  return {

    /* SOCIAL LINKS + FORM BUTTONS
       Reads content/settings/social.md
       Populates: [data-cms="social-pills"]
       Wires:     [data-cms="form-crafties"] etc to Google Form URLs
    */
    async loadSocial() {
      try {
        const { data } = await fetchFile('content/settings/social.md');

        /* footer social pills */
        document.querySelectorAll('[data-cms="social-pills"]').forEach(el => {
          const pills = [
            data.wattpad   && { url: data.wattpad,   label: '📖 Wattpad'   },
            data.instagram && { url: data.instagram, label: '📸 Instagram' },
            data.spotify   && { url: data.spotify,   label: '🎵 Spotify'   },
            data.pinterest && { url: data.pinterest, label: '📌 Pinterest' }
          ].filter(Boolean);
          if (pills.length) {
            el.innerHTML = pills.map(p =>
              `<a href="${p.url}" target="_blank" rel="noopener noreferrer" class="social-pill">${p.label}</a>`
            ).join('');
          }
        });

        /* google form buttons */
        const forms = {
          'form-crafties': data.form_crafties,
          'form-reviews':  data.form_reviews,
          'form-fanart':   data.form_fanart,
          'form-contact':  data.form_contact
        };
        Object.entries(forms).forEach(([attr, url]) => {
          if (!url) return;
          document.querySelectorAll(`[data-cms="${attr}"]`).forEach(el => {
            el.addEventListener('click', e => {
              e.preventDefault();
              window.open(url, '_blank', 'noopener,noreferrer');
            });
            el.style.cursor = 'pointer';
          });
        });

        return data;
      } catch(e) {
        console.warn('CMS social fetch failed.', e);
        return {};
      }
    },

    /* BOOKS
       Reads content/books/*.md
       Targets: [data-cms="books-grid"]
                [data-cms="books-featured"]
                [data-cms="books-count"]
    */
    async loadBooks() {
      try {
        const entries = await fetchCollection('books');
        const published = entries
          .filter(e => e.data.status === 'published')
          .sort((a, b) => (b.data.published_at || '').localeCompare(a.data.published_at || ''));

        document.querySelectorAll('[data-cms="books-count"]').forEach(el => {
          el.textContent = published.length;
        });

        const featured = published.find(e => e.data.is_featured) || published[0];

        if (featured) {
          document.querySelectorAll('[data-cms="books-featured"]').forEach(el => {
            el.innerHTML = this._bookCardHTML(featured);
          });
        }

        document.querySelectorAll('[data-cms="books-grid"]').forEach(el => {
          if (!published.length) {
            el.innerHTML = '<p class="cms-empty">No books published yet.</p>';
            return;
          }
          el.innerHTML = published.map(e => this._bookCardHTML(e)).join('');
        });

        return published;
      } catch(e) {
        console.warn('CMS books fetch failed.', e);
        return [];
      }
    },

    _bookCardHTML({ data, body }) {
      const cover = data.cover_image
        ? `<img src="${data.cover_image}" alt="${data.title}" class="book-cover" loading="lazy">`
        : `<div class="book-cover-placeholder"><span>${data.title || ''}</span></div>`;
      const wattpad = data.wattpad_url
        ? `<a href="${data.wattpad_url}" target="_blank" rel="noopener noreferrer" class="read-btn primary">📖 Read on Wattpad</a>`
        : '';
      const paperback = data.paperback_url && data.paperback_url !== '#'
        ? `<a href="${data.paperback_url}" target="_blank" rel="noopener noreferrer" class="read-btn">📦 Paperback</a>`
        : '';
      const genres = Array.isArray(data.genres)
        ? `<div class="book-genres">${data.genres.map(g => `<span class="book-tag">${g}</span>`).join('')}</div>`
        : '';
      const synopsis = body ? `<p class="book-synopsis">${body.split('\n\n')[0]}</p>` : '';
      return `
        <div class="book-card" data-book="${data._slug}">
          <div class="book-cover-wrap">${cover}</div>
          <div class="book-info">
            ${data.series_name ? `<span class="book-series">${data.series_name}${data.series_number ? ' — ' + data.series_number : ''}</span>` : ''}
            <h3 class="book-title">${data.title || ''}</h3>
            ${genres}
            ${data.featured_quote ? `<blockquote class="book-quote">"${data.featured_quote}"</blockquote>` : ''}
            ${synopsis}
            <div class="book-actions">${wattpad}${paperback}</div>
          </div>
        </div>`;
    },

    /* CHARACTERS
       Reads content/characters/*.md
       Target: [data-cms="characters-grid"]
    */
    async loadCharacters() {
      try {
        const entries = await fetchCollection('characters');
        const published = entries
          .filter(e => e.data.status === 'published' && e.data.is_featured !== false)
          .sort((a, b) => (parseInt(a.data.display_order) || 99) - (parseInt(b.data.display_order) || 99));

        document.querySelectorAll('[data-cms="characters-grid"]').forEach(el => {
          if (!published.length) {
            el.innerHTML = '<p class="cms-empty">No characters published yet.</p>';
            return;
          }
          el.innerHTML = published.map(({ data }) => `
            <div class="char-card">
              ${data.illustration
                ? `<img src="${data.illustration}" alt="${data.name}" class="char-illustration" loading="lazy">`
                : `<div class="char-illustration-placeholder">${(data.name || '?')[0]}</div>`}
              <h3 class="char-name">${data.name || ''}</h3>
              ${data.book       ? `<span class="char-book">${data.book}</span>`           : ''}
              ${data.occupation ? `<span class="char-role">${data.occupation}</span>`     : ''}
            </div>`).join('');
        });

        return published;
      } catch(e) {
        console.warn('CMS characters fetch failed.', e);
        return [];
      }
    },

    /* REVIEWS
       Reads content/featured-reviews/*.md
       Targets: [data-cms="reviews-grid"]
                [data-cms="reviews-featured"]
    */
    async loadReviews() {
      try {
        const entries = await fetchCollection('featured-reviews');
        const sorted  = [...entries].sort((a, b) =>
          (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

        document.querySelectorAll('[data-cms="reviews-grid"]').forEach(el => {
          if (!sorted.length) {
            el.innerHTML = '<p class="cms-empty">No reviews yet.</p>';
            return;
          }
          el.innerHTML = sorted.map(({ data, body }) => `
            <div class="review-card${data.is_pinned ? ' pinned' : ''}">
              <span class="review-stars">${stars(data.rating)}</span>
              <p class="review-text">${md(body)}</p>
              <div class="review-meta">
                <span class="review-reader">${data.reader_handle || data.reader_name || ''}</span>
                <span class="review-book">${data.book || ''}</span>
              </div>
            </div>`).join('');
        });

        const pinned = sorted.find(e => e.data.is_pinned) || sorted[0];
        if (pinned) {
          document.querySelectorAll('[data-cms="reviews-featured"]').forEach(el => {
            el.innerHTML = `
              <blockquote class="featured-review">
                <p>${pinned.body.split('\n\n')[0] || ''}</p>
                <cite>${pinned.data.reader_handle || pinned.data.reader_name || ''}</cite>
              </blockquote>`;
          });
        }

        return sorted;
      } catch(e) {
        console.warn('CMS reviews fetch failed.', e);
        return [];
      }
    },

    /* FAN ART
       Reads content/fan-art/*.md
       Target: [data-cms="fanart-grid"]
    */
    async loadFanArt() {
      try {
        const entries  = await fetchCollection('fan-art');
        const featured = entries.filter(e =>
          e.data.is_featured !== false && e.data.is_featured !== 'false');

        document.querySelectorAll('[data-cms="fanart-grid"]').forEach(el => {
          if (!featured.length) {
            el.innerHTML = '<p class="cms-empty">No fan art yet.</p>';
            return;
          }
          el.innerHTML = featured.map(({ data }) => {
            const ext = data.external_link || '';
            const img = data.image
              ? `<img src="${data.image}" alt="${data.artist_name || 'Fan art'}" class="fanart-img" loading="lazy">`
              : `<div class="fanart-placeholder">art by ${data.artist_name || 'a craftie'}</div>`;
            return `
              <div class="fanart-card">
                ${ext ? `<a href="${ext}" target="_blank" rel="noopener noreferrer">${img}</a>` : img}
                <div class="fanart-info">
                  <span class="fanart-artist">${data.artist_name || ''}${data.artist_handle ? ' · ' + data.artist_handle : ''}</span>
                  ${data.description ? `<span class="fanart-caption">${data.description}</span>` : ''}
                </div>
              </div>`;
          }).join('');
        });

        return featured;
      } catch(e) {
        console.warn('CMS fan art fetch failed.', e);
        return [];
      }
    },

    /* UPDATES PREVIEW
       Reads content/updates/*.md — shows 3 most recent
       Target: [data-cms="updates-latest"]
    */
    async loadUpdatesPreview() {
      try {
        const res = await fetch(API('updates'));
        if (!res.ok) return [];
        const files = (await res.json()).filter(f => f.name.endsWith('.md'));
        const all   = await Promise.all(files.map(async f => {
          const r = await fetch(RAW(`content/updates/${f.name}`));
          return parseFM(await r.text());
        }));
        const published = all
          .filter(e => e.data.status === 'published')
          .sort((a, b) => (b.data.date || '').localeCompare(a.data.date || ''))
          .slice(0, 3);

        document.querySelectorAll('[data-cms="updates-latest"]').forEach(el => {
          if (!published.length) return;
          el.innerHTML = published.map(({ data, body }) => `
            <div class="update-preview">
              <span class="update-date">${data.date
                ? new Date(data.date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
                : ''}</span>
              <h4 class="update-title">${data.title || ''}</h4>
              <p class="update-excerpt">${data.excerpt || body.split('\n\n')[0] || ''}</p>
            </div>`).join('');
        });

        return published;
      } catch(e) {
        console.warn('CMS updates preview fetch failed.', e);
        return [];
      }
    },

    /* HALL OF FAME
       Reads content/hall-of-fame/*.md
       Reads content/fan-art/*.md
       Reads content/featured-reviews/*.md
       (hall-of-fame.html handles its own fetching internally —
        this method is for homepage snippets if needed)
    */
    async loadHOFPreview() {
      try {
        const entries = await fetchCollection('hall-of-fame');
        const featured = entries
          .filter(e => e.data.status === 'published' && e.data.is_homepage_feature)
          .slice(0, 2);

        document.querySelectorAll('[data-cms="hof-preview"]').forEach(el => {
          if (!featured.length) return;
          el.innerHTML = featured.map(({ data, body }) => `
            <div class="hof-preview-card">
              <span class="hof-reader">${data.display_name || data.reader_name || ''}</span>
              <p class="hof-text">${body ? '"' + body.split('\n\n')[0] + '"' : ''}</p>
            </div>`).join('');
        });

        return featured;
      } catch(e) {
        console.warn('CMS HOF preview fetch failed.', e);
        return [];
      }
    },

    /* INIT — scans page for data-cms targets and loads only what's needed */
    async init() {
      const has = attr => !!document.querySelector(`[data-cms="${attr}"]`);
      const jobs = [];

      if (has('social-pills') || has('form-crafties') || has('form-reviews') ||
          has('form-fanart')  || has('form-contact'))
        jobs.push(this.loadSocial());

      if (has('books-grid') || has('books-featured') || has('books-count'))
        jobs.push(this.loadBooks());

      if (has('characters-grid'))
        jobs.push(this.loadCharacters());

      if (has('reviews-grid') || has('reviews-featured'))
        jobs.push(this.loadReviews());

      if (has('fanart-grid'))
        jobs.push(this.loadFanArt());

      if (has('updates-latest'))
        jobs.push(this.loadUpdatesPreview());

      if (has('hof-preview'))
        jobs.push(this.loadHOFPreview());

      await Promise.allSettled(jobs);
    }
  };
})();

/* Auto-init when DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => CMS.init());
} else {
  CMS.init();
}
