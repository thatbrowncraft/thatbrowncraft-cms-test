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

  // Resolved once loadSocial() finishes building window.__craftiesForms.
  // sendCard() in crafties.html awaits this (with a timeout) instead of
  // reading window.__craftiesForms cold — a click that lands before this
  // deferred script has finished its fetch would otherwise see an empty
  // config and silently skip the submission.
  let _resolveFormsReady;
  window.__craftiesFormsReady = new Promise(resolve => { _resolveFormsReady = resolve; });

  const USER   = 'thatbrowncraft';
  const REPO   = 'thatbrowncraft-cms-test';
  const BRANCH = 'main';

  const RAW = path =>
    `https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}/${path}`;

  /* One request lists every file in the whole repo, replacing what used
     to be one GitHub Contents API call PER collection PER page. That
     per-folder pattern was the actual source of the 429s: GitHub's
     unauthenticated REST API allows only 60 requests/hour/IP, and a
     single page can use half a dozen collections. The Git Trees API
     (recursive) returns the full file listing in one shot regardless
     of how many collections a page needs. */
  const TREE_API = () =>
    `https://api.github.com/repos/${USER}/${REPO}/git/trees/${BRANCH}?recursive=1`;

  /* CMS image fields store root-relative paths like "/images/foo.png"
     (public_folder). That breaks on GitHub Pages project sites, where
     "/" resolves to the domain root, not the repo subpath. Resolve
     against the raw content host instead, same as everything else. */
  const IMG = path => path ? RAW(`public${path}`) : '';

  /* ==========================================================
     CACHING + REQUEST DE-DUPLICATION

     Two problems, two mechanisms:

     1. Same page load asking for the same thing twice (e.g. loadBooks
        and loadCharacters both touching the "books" collection) —
        solved by `_inflight`, an in-memory map of promises. The
        second caller gets the first caller's in-flight promise
        instead of firing a second network request.

     2. Navigating between pages within the same visit re-fetching
        content that hasn't changed — solved by sessionStorage, keyed
        per resource, with a short TTL. Cleared automatically when the
        tab closes; refreshed automatically once the TTL passes, so
        newly published content still shows up within a few minutes.

     Both layers fail closed: if sessionStorage is unavailable (private
     browsing, quota exceeded, etc.) caching just quietly stops
     happening — nothing else breaks.
     ========================================================== */
  const CACHE_PREFIX     = 'cms_cache_v1:';
  const TREE_TTL_MS       = 5 * 60 * 1000;  // how long the repo file listing is trusted
  const CONTENT_TTL_MS    = 5 * 60 * 1000;  // how long individual file content is trusted

  function cacheGet(key) {
    try {
      const raw = sessionStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number') return null;
      return entry; // { t: <timestamp>, v: <value> }
    } catch (e) {
      return null; // corrupted or unreadable — treat as a cache miss
    }
  }
  function cacheSet(key, value) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      /* sessionStorage full or disabled — caching silently stops
         working for this session, nothing else is affected. */
    }
  }
  function cacheFresh(entry, ttl) {
    return !!entry && (Date.now() - entry.t) < ttl;
  }

  const _inflight = new Map();
  function dedupe(key, fn) {
    if (_inflight.has(key)) return _inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
    _inflight.set(key, p);
    return p;
  }

  /* Heuristic guard against treating a GitHub error/outage page as real
     content. raw.githubusercontent.com and api.github.com both return
     proper non-200 status codes for rate limits and missing files
     (already caught by res.ok below), but this is a cheap extra check
     against the rarer case of a 200 response body that isn't actually
     the file we asked for — a captive portal, a CDN incident page, etc. */
  function looksLikeErrorPage(text) {
    return /^\s*<(!DOCTYPE|html)/i.test(text || '');
  }

  /* ── repo file listing (replaces per-folder Contents API calls) ── */
  async function getRepoTree() {
    const key = 'tree';
    const cached = cacheGet(key);
    if (cacheFresh(cached, TREE_TTL_MS)) return cached.v;

    return dedupe(key, async () => {
      try {
        const res = await fetch(TREE_API());
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const json = await res.json();
        if (!json || !Array.isArray(json.tree)) throw new Error('unexpected tree response shape');
        const paths = json.tree
          .filter(node => node && node.type === 'blob' && typeof node.path === 'string')
          .map(node => node.path);
        cacheSet(key, paths);
        return paths;
      } catch (e) {
        console.warn('CMS: could not list repository files (likely GitHub API rate limiting)', e);
        // A stale listing is still far more useful than none — file
        // paths practically never change shape, so serving yesterday's
        // list is safe even if it misses a brand-new file for a bit.
        if (cached) return cached.v;
        return null; // genuinely unknown — callers must treat this as "can't confirm", not "empty"
      }
    });
  }

  /* ── single markdown file, cached + de-duplicated ── */
  async function fetchMarkdown(path, { bypassCache = false } = {}) {
    const key = `file:${path}`;
    if (!bypassCache) {
      const cached = cacheGet(key);
      if (cacheFresh(cached, CONTENT_TTL_MS)) return cached.v;
    }

    return dedupe(key, async () => {
      try {
        // social.md drives live form-submission wiring and sits behind
        // Fastly's edge cache, which can serve a stale copy for minutes
        // after a real update — independent of any cache of ours. When
        // bypassCache is set we fight that with a cache-busting query
        // param and a hard no-store, same as before this refactor.
        const bust = bypassCache ? `${path.includes('?') ? '&' : '?'}_=${Date.now()}` : '';
        const res = await fetch(RAW(path) + bust, bypassCache ? { cache: 'no-store' } : undefined);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = await res.text();
        if (looksLikeErrorPage(text)) throw new Error('response body looks like an HTML error page, not markdown');
        const parsed = parseFM(text);
        if (!bypassCache) cacheSet(key, parsed);
        return parsed;
      } catch (e) {
        console.warn(`CMS: file fetch failed: ${path}`, e);
        if (!bypassCache) {
          const stale = cacheGet(key);
          if (stale) return stale.v; // old content beats no content
        }
        return null; // signals failure — caller must not treat this as "file is empty"
      }
    });
  }

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

  /* ── fetch entire collection ──
     Returns a plain array (so every existing .filter/.map/.sort call
     site keeps working unchanged) but marks it with a non-enumerable
     `.__failed` flag when the fetch genuinely failed, as opposed to
     the collection genuinely having zero entries. Render code checks
     this flag before deciding whether to show an empty-state message —
     see anyFailed()/renderList() below. */
  function markFailed(arr) {
    Object.defineProperty(arr, '__failed', { value: true, enumerable: false });
    return arr;
  }

  async function fetchCollection(folder) {
    const tree = await getRepoTree();
    if (!tree) return markFailed([]); // couldn't even determine what files exist

    const prefix = `content/${folder}/`;
    const paths = tree.filter(p => p.startsWith(prefix) && p.endsWith('.md'));
    if (!paths.length) return []; // confirmed empty collection — not a failure

    const results = await Promise.all(paths.map(p => fetchMarkdown(p)));
    const good = [];
    let anyFileFailed = false;
    results.forEach((r, i) => {
      if (!r) { anyFileFailed = true; return; }
      const { data, body } = r;
      data._slug = paths[i].slice(prefix.length).replace(/\.md$/, '');
      good.push({ data, body });
    });

    // Some files failing while others succeed still renders what we
    // have (better than showing nothing) with just a console warning.
    // Only mark the whole thing as failed if literally nothing came
    // through, so real emptiness and total failure aren't confused.
    if (anyFileFailed && !good.length) return markFailed(good);
    return good;
  }

  /* ── legacy Hall of Fame bridge ──
     content/hall-of-fame/ is the old one-form-fits-all collection.
     It's kept archived (create: false in config.yml) instead of
     deleted, so every existing entry keeps working with zero
     migration required. Each of the four split sections below reads
     its own new collection AND this legacy one, pulls out just the
     matching entry_type, reshapes the old field names to match the
     new schema, and merges the two lists together.

     Fetched once and cached, since up to five loaders may ask for it. */
  let _legacyHofPromise = null;
  function fetchLegacyHallOfFame() {
    if (!_legacyHofPromise) _legacyHofPromise = fetchCollection('hall-of-fame');
    return _legacyHofPromise;
  }

  function legacyEntriesOfType(entries, type) {
    return entries.filter(e => e.data.entry_type === type && e.data.status === 'published');
  }

  /* Once you copy a legacy entry over into its new collection by hand,
     set the legacy copy's Status to Draft or Archived so it drops out
     of legacyEntriesOfType above. This slug check is just a safety net
     in case the same entry briefly exists live in both places at once. */
  function dedupeBySlug(alreadyHave, legacyCandidates) {
    const seen = new Set(alreadyHave.map(e => e.data._slug));
    return legacyCandidates.filter(e => !seen.has(e.data._slug));
  }

  function legacyToComment(e) {
    return {
      data: {
        _slug: e.data._slug,
        reader_name: e.data.reader_name || '',
        reader_handle: e.data.reader_handle || '',
        related_book: e.data.related_book || '',
        comment: firstPara(e.body || '') || e.data.letter_subject || '',
        status: e.data.status,
        is_pinned: !!e.data.is_pinned,
      },
      body: '',
    };
  }

  function legacyToQuote(e) {
    return {
      data: {
        _slug: e.data._slug,
        reader_name: e.data.reader_name || '',
        reader_handle: e.data.reader_handle || '',
        related_book: e.data.related_book || '',
        quote: e.data.reader_favourite_quote || firstPara(e.body || ''),
        status: e.data.status,
      },
      body: '',
    };
  }

  function legacyToTheory(e) {
    return {
      data: {
        _slug: e.data._slug,
        reader_name: e.data.reader_name || '',
        reader_handle: e.data.reader_handle || '',
        related_book: e.data.related_book || '',
        theory_title: e.data.theory_title || '',
        theory_correct: e.data.theory_correct || 'unrevealed',
        status: e.data.status,
      },
      body: e.body || '', // kept as markdown, same as the original renderer expects
    };
  }

  function legacyToCraftie(e) {
    return {
      data: {
        _slug: e.data._slug,
        reader_name: e.data.reader_name || '',
        reader_handle: e.data.reader_handle || '',
        author_note_about_reader: e.data.author_note_about_reader || '',
        status: e.data.status,
        is_pinned: !!e.data.is_pinned,
      },
      body: '',
    };
  }

  function legacyToFanArt(e) {
    return {
      data: {
        _slug: e.data._slug,
        artist_name: e.data.reader_name || '',
        artist_handle: e.data.reader_handle || '',
        book_or_character: e.data.related_book || e.data.artwork_title || '',
        description: e.data.artist_description || '',
        image: e.data.artwork_image || '',
        external_link: e.data.artwork_external_url || '',
        is_featured: true,
        status: e.data.status,
      },
      body: '',
    };
  }

  /* ── fetch single settings file ──
     Cached and de-duplicated by default, same as collection files.
     Pass { bypassCache: true } for anything that must always be
     genuinely fresh — currently just social.md, which drives live
     form-submission wiring and sits behind Fastly's edge cache (a
     separate staleness problem from our own caching, fought the same
     way as before: a cache-busting query param + no-store). */
  async function fetchFile(path, opts) {
    const parsed = await fetchMarkdown(path, opts);
    return parsed || { data: {}, body: '' };
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

  function esc(s) {
    return (s ?? '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function slugify(s) {
    return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function normalizeName(s) {
    return (s || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
  }
  /* Matches a book's character_leads name against the published
     Characters collection. Tries, in order:
       1. exact name match (case/whitespace-insensitive)
       2. exact slug match (handles punctuation differences)
       3. substring match either direction (handles a book listing
          a short form like "Hriday" against a full character
          entry named "Hriday Singh Rajvansh")
     Returns the matching character's data object, or null. */
  function findCharacterMatch(leadName, characters) {
    if (!leadName || !Array.isArray(characters) || !characters.length) return null;
    const key = normalizeName(leadName);
    if (!key) return null;

    let found = characters.find(c => normalizeName(c.name) === key);
    if (found) return found;

    const leadSlug = slugify(leadName);
    found = characters.find(c => slugify(c.name) === leadSlug);
    if (found) return found;

    found = characters.find(c => {
      const cName = normalizeName(c.name);
      return cName && (cName.includes(key) || key.includes(cName));
    });
    return found || null;
  }
  /* Matches a character's free-text "book" field against the published
     Books collection, same fuzzy strategy as findCharacterMatch above
     (exact name → exact slug → substring either direction). This is
     what lets the Character Vault filter reliably by book even if the
     text in a character entry doesn't match a book's title byte-for-byte
     (extra whitespace, "Amodini" vs "Amodini Series", etc).
     Returns the matching book's data object, or null. */
  function findBookMatch(bookName, books) {
    if (!bookName || !Array.isArray(books) || !books.length) return null;
    const key = normalizeName(bookName);
    if (!key) return null;

    let found = books.find(b => normalizeName(b.title) === key);
    if (found) return found;

    const bookSlug = slugify(bookName);
    found = books.find(b => slugify(b.title) === bookSlug);
    if (found) return found;

    found = books.find(b => {
      const bTitle = normalizeName(b.title);
      return bTitle && (bTitle.includes(key) || key.includes(bTitle));
    });
    return found || null;
  }
  /* ── book reading / purchase links ──
     Fully CMS-driven: the author adds one "Purchase / Reading Links"
     row per platform (Amazon Kindle, Paperback, Wattpad, Pothi,
     Goodreads, Kobo, Notion Press, Inkitt, Stck, or anything else —
     literally any label they type) inside a book's own entry. This
     function only ever renders what's actually in that list — no
     platform name is hardcoded anywhere, so adding, removing, or
     reordering platforms never requires touching this file or the
     HTML again. PLATFORM_ICONS is purely cosmetic (a nicer default
     emoji for common platforms if the author doesn't set one) and is
     never required for a link to appear. */
  const PLATFORM_ICONS = {
    'wattpad': '📖', 'amazon kindle': '📱', 'kindle': '📱',
    'amazon paperback': '📦', 'paperback': '📦', 'pothi': '📕',
    'goodreads': '📚', 'kobo': '🔖', 'notion press': '📘',
    'inkitt': '🔗', 'stck': '🔗', 'spotify': '🎵', 'website': '🌐'
  };

  /* Legacy per-field links (wattpad_url, kindle_url, etc.) — kept only
     as a fallback so books published before the "purchase_links" list
     field existed keep showing their buttons untouched, with zero
     migration required. Any newly edited or created book should use
     purchase_links instead; this map is not extended going forward. */
  const LEGACY_LINK_META = {
    wattpad_url:   { icon: '📖', label: 'Read on Wattpad', primary: true },
    paperback_url: { icon: '📦', label: 'Paperback' },
    kindle_url:    { icon: '📱', label: 'Kindle' },
    inkitt_url:    { icon: '🔗', label: 'Inkitt' },
    stck_url:      { icon: '🔗', label: 'Stck' }
  };

  function renderBookLinks(data, linkClass) {
    /* Preferred path: the generic purchase_links list. */
    if (Array.isArray(data.purchase_links) && data.purchase_links.length) {
      return data.purchase_links.map((link, i) => {
        const url = (link && (link.url || link)) || '';
        if (!url || typeof url !== 'string') return '';
        const platform = (link && link.platform) || 'Read';
        const icon = (link && link.icon) || PLATFORM_ICONS[normalizeName(platform)] || '🔗';
        // Whichever link the author lists first is treated as the
        // primary call-to-action button, same visual role Wattpad
        // used to always occupy.
        const cls = linkClass + (i === 0 ? ' primary' : '');
        return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="${cls}">${icon} ${esc(platform)}</a>`;
      }).filter(Boolean).join('');
    }

    /* Fallback path: legacy individual *_url fields, for books that
       predate purchase_links and haven't been re-saved yet. */
    const knownOrder = Object.keys(LEGACY_LINK_META);
    const extraKeys = Object.keys(data)
      .filter(k => k.endsWith('_url') && !knownOrder.includes(k));
    return knownOrder.concat(extraKeys).map(key => {
      const url = data[key];
      if (!url) return '';
      const meta = LEGACY_LINK_META[key] || {
        icon: '🔗',
        label: key.replace(/_url$/, '').replace(/_/g, ' ')
          .replace(/\b\w/g, ch => ch.toUpperCase())
      };
      const cls = linkClass + (meta.primary ? ' primary' : '');
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="${cls}">${meta.icon} ${esc(meta.label)}</a>`;
    }).filter(Boolean).join('');
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

  /* Adds a "read more / read less" toggle to any text block that
     visually overflows its clamp (see .clamped in hall-of-fame.html).
     Short entries never get a button at all — it only appears when
     there's actually more to read. Safe to call repeatedly; it will
     not double up buttons on cards that already have one. */
  function enableReadMore(cardSelector, textSelector) {
    requestAnimationFrame(() => {
      document.querySelectorAll(cardSelector).forEach(card => {
        const textEl = card.querySelector(textSelector);
        if (!textEl || textEl.dataset.readMoreReady) return;
        textEl.dataset.readMoreReady = '1';
        textEl.classList.add('clamped');
        if (textEl.scrollHeight <= textEl.clientHeight + 2) {
          textEl.classList.remove('clamped');
          return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'read-more-btn';
        btn.textContent = 'read more';
        btn.addEventListener('click', () => {
          const expanded = textEl.classList.toggle('clamped') === false;
          btn.textContent = expanded ? 'read less' : 'read more';
        });
        textEl.insertAdjacentElement('afterend', btn);
      });
    });
  }

  /* ── failure-aware list rendering ──
     True if ANY of the given fetches (collections or legacy bridges)
     came back marked failed by fetchCollection's markFailed(). Called
     with the raw fetched arrays, before any .filter()/.map() — those
     return plain new arrays and don't carry the flag forward. */
  function anyFailed(...arrs) {
    return arrs.some(a => a && a.__failed);
  }

  /* Renders a simple item list into every element with this data-cms
     attribute. On genuine emptiness, shows emptyMessage. On fetch
     failure, leaves whatever's already in the element untouched
     (static fallback markup, or a previous successful render) instead
     of overwriting real content with a false "nothing published yet". */
  function renderList(selector, items, failed, emptyMessage, renderItem, joinWith = '') {
    document.querySelectorAll(`[data-cms="${selector}"]`).forEach(el => {
      if (!items.length) {
        if (!failed) el.innerHTML = `<p class="cms-empty">${esc(emptyMessage)}</p>`;
        return;
      }
      el.innerHTML = items.map(renderItem).join(joinWith);
    });
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
      const { data } = await fetchFile('content/settings/social.md', { bypassCache: true });

      // Ordered list of every platform the footer knows how to render.
      // A platform only becomes a button when its field in
      // content/settings/social.md is filled in — nothing here is a
      // guaranteed button. Add a new platform to this list (and to
      // config.yml) and it starts appearing automatically with zero
      // further HTML/JS changes; remove a URL in the CMS and its
      // button disappears, with no gaps left behind.
      const SOCIAL_PLATFORMS = [
        { key: 'wattpad',       label: '📖 Wattpad'    },
        { key: 'instagram',     label: '📸 Instagram'  },
        { key: 'spotify',       label: '🎵 Spotify'    },
        { key: 'pinterest',     label: '📌 Pinterest'  },
        { key: 'youtube',       label: '▶️ YouTube'    },
        { key: 'goodreads',     label: '📚 Goodreads'  },
        { key: 'amazon_author', label: '📦 Amazon'     },
        { key: 'linktree',      label: '🔗 Linktree'   },
        { key: 'threads',       label: '🧵 Threads'    },
        { key: 'facebook',      label: '📘 Facebook'   },
        { key: 'x_twitter',     label: '✕ X'           },
        { key: 'website',       label: '🌐 Website'    },
        { key: 'email',         label: '✉️ Email', isEmail: true }
      ];

      document.querySelectorAll('[data-cms="social-pills"]').forEach(el => {
        const pills = SOCIAL_PLATFORMS
          .map(p => {
            // Strip stray leading/trailing quote characters — the shared
            // frontmatter parser can leave literal '' or "" behind for
            // fields the CMS wrote as an empty quoted string, which would
            // otherwise pass the emptiness check below as truthy text.
            // Also reject bare `null`/`undefined` placeholder text: an
            // untouched optional field can come back from Sveltia/Decap
            // as an unquoted YAML null, which parseFM's scalar parser
            // passes through as the literal string "null" (it only
            // special-cases true/false/numbers) — no quotes to strip,
            // so it used to sail past the check above as a "real" URL.
            const raw = String(data[p.key] ?? '').replace(/^['"]+|['"]+$/g, '').trim();
            if (!raw || raw === 'null' || raw === 'undefined') return null;
            return { url: p.isEmail ? `mailto:${raw}` : raw, label: p.label };
          })
          .filter(Boolean);
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

      // ── Crafties Post Office submission config ────────────────────────
      // Postcard, Review, and Fan Art all POST straight to one Google
      // Apps Script Web App (deployed from the destination Sheet), not
      // to Google Forms. The author adds ONE field to
      // content/settings/social.md:
      //
      //   google_sheets_webapp_url: "https://script.google.com/macros/s/XXXX/exec"
      //
      // No per-field entry IDs needed — the script reads whatever plain
      // field names sendCard() sends (name, message, category, etc.)
      // directly off e.parameter, and a "formType" field tells it which
      // sheet tab to append the row to. See Code.gs for the script.
      window.__craftiesForms = {
        webAppUrl: (data.google_sheets_webapp_url || '').trim()
      };

      // Surface misconfiguration instead of failing silently — a
      // missing url here means sendCard() will skip the POST while
      // still telling the reader (via the on-page error message,
      // not just this console line) that nothing was sent.
      if (!window.__craftiesForms.webAppUrl) {
        console.warn('[CMS] google_sheets_webapp_url is empty — check content/settings/social.md. Postcard, Review, and Fan Art submissions will not work until this is set.');
      }

      _resolveFormsReady();

      return data;
    },

    /* ────────────────────────────────────────────────────────
       AUTHOR PROFILE
       Reads content/settings/author.md
       Populates: [data-cms="author-photo"]      (author_photo)
                  [data-cms="author-name"]        (display_name)
                  [data-cms="author-bio"]         (bio — the file's
                                                    markdown body, see note)
                  [data-cms="footer-tagline"]     (tagline — every page's footer)
                  [data-cms="author-fun-facts"]   (fun_facts list, as tag pills)
                  [data-cms="about-hero-quote"]   (about_hero_quote)
                  [data-cms="about-hero-sub"]     (about_hero_sub)
                  [data-cms="finds-section-label"] (finds_section_label)
                  [data-cms="finds-section-title"] (finds_section_title,
                                                    last word emphasized)
                  [data-cms="finds-section-sub"]   (finds_section_sub)
                  [data-cms="currently-section-label"] (currently_section_label)
                  [data-cms="currently-section-title"] (currently_section_title,
                                                    last word emphasized)
                  [data-cms="currently-section-sub"]   (currently_section_sub)
                  [data-cms="letter-section"]     (whole "letter to Crafties" block —
                                                    hidden entirely when letter_show is false)
                  [data-cms="letter-salutation"]  (letter_salutation)
                  [data-cms="letter-body"]        (letter_body, markdown)
                  [data-cms="letter-sign-name"]   (letter_sign_name)

       Note on author_bio: in config.yml the "Author Bio" field is
       deliberately named "body" (a Decap CMS convention for a markdown
       field meant to be the file's main content rather than a
       frontmatter key). parseFM() already splits that out for us as
       the returned `body` string, so the bio is read from `body`,
       not from `data.author_bio` / `data.body`.

       Runs on every page (like loadSocial) since tagline drives the
       shared footer; all other fields are only present on about.html,
       and the data-cms selectors are simply no-ops where absent.
       ──────────────────────────────────────────────────────── */
    async loadAuthor() {
      const { data, body } = await fetchFile('content/settings/author.md');

      // Author photo
      document.querySelectorAll('[data-cms="author-photo"]').forEach(el => {
        if (!data.author_photo) return;
        const url = IMG(data.author_photo);
        if (el.tagName === 'IMG') {
          el.src = url;
          el.alt = data.display_name ? `Photo of ${data.display_name}` : 'Author photo';
        } else {
          el.style.backgroundImage = `url("${url}")`;
        }
      });

      // Display name
      document.querySelectorAll('[data-cms="author-name"]').forEach(el => {
        if (data.display_name) el.textContent = data.display_name;
      });

      // Author bio — the file's markdown body (see note above)
      document.querySelectorAll('[data-cms="author-bio"]').forEach(el => {
        if (!body) return;
        el.innerHTML = md(body) +
          `<div class="orn-row" aria-hidden="true" style="margin-top:2rem">
             <span class="orn-line"></span><span class="orn-motif">✦</span><span class="orn-line"></span>
           </div>`;
      });

      // Footer tagline (shared across every page's footer)
      document.querySelectorAll('[data-cms="footer-tagline"]').forEach(el => {
        if (data.tagline) el.textContent = data.tagline;
      });

      // Fun facts — rendered as tag pills
      document.querySelectorAll('[data-cms="author-fun-facts"]').forEach(el => {
        const facts = Array.isArray(data.fun_facts)
          ? data.fun_facts.map(f => (typeof f === 'object' ? f.fact : f)).filter(Boolean)
          : [];
        // Leave whatever fallback markup the page already has in place
        // when there's no CMS data yet, rather than blanking the section.
        if (!facts.length) return;
        el.innerHTML = facts.map(f => `<span class="fact-pill">${esc(f)}</span>`).join('');
      });

      // Hero quote — italicize the final word to match the site's
      // existing "Some stories become <em>homes.</em>" styling.
      document.querySelectorAll('[data-cms="about-hero-quote"]').forEach(el => {
        const q = data.about_hero_quote;
        if (!q) return;
        const last = q.lastIndexOf(' ');
        if (last === -1) { el.innerHTML = `"${esc(q)}"`; return; }
        el.innerHTML = `"${esc(q.substring(0, last))} <em>${esc(q.substring(last + 1))}</em>"`;
      });

      // Hero subtitle
      document.querySelectorAll('[data-cms="about-hero-sub"]').forEach(el => {
        if (data.about_hero_sub) el.textContent = data.about_hero_sub;
      });

      // Small helper shared by the two section titles below — italicizes
      // the final word to match the existing "Fiction that <em>feels.</em>"
      // / "In <em>this season</em>" styling already on the page.
      const setEmphasizedTitle = (el, title) => {
        if (!title) return;
        const last = title.lastIndexOf(' ');
        if (last === -1) { el.textContent = title; return; }
        el.innerHTML = `${esc(title.substring(0, last))} <em>${esc(title.substring(last + 1))}</em>`;
      };

      // "What You'll Find Here" section label/title/subtitle
      document.querySelectorAll('[data-cms="finds-section-label"]').forEach(el => {
        if (data.finds_section_label) el.textContent = data.finds_section_label;
      });
      document.querySelectorAll('[data-cms="finds-section-title"]').forEach(el => {
        setEmphasizedTitle(el, data.finds_section_title);
      });
      document.querySelectorAll('[data-cms="finds-section-sub"]').forEach(el => {
        if (data.finds_section_sub) el.textContent = data.finds_section_sub;
      });

      // "What You'll Find Here" feature cards — straight loop over
      // finds_cards, no hardcoded fallback content. Heading/subtitle
      // above are separate fields and never derive from card data.
      const findsCards = Array.isArray(data.finds_cards)
        ? data.finds_cards.filter(c => c && c.show !== false && c.show !== 'false')
        : [];
      renderList('finds-cards', findsCards, false, 'No cards yet.', c => `
          <div class="find-card">
            <span class="find-icon">${esc(c.icon || '✦')}</span>
            <span class="find-text">${esc(c.text || '')}</span>
          </div>`);

      // "Currently Loving" section label/title/subtitle
      document.querySelectorAll('[data-cms="currently-section-label"]').forEach(el => {
        if (data.currently_section_label) el.textContent = data.currently_section_label;
      });
      document.querySelectorAll('[data-cms="currently-section-title"]').forEach(el => {
        setEmphasizedTitle(el, data.currently_section_title);
      });
      document.querySelectorAll('[data-cms="currently-section-sub"]').forEach(el => {
        if (data.currently_section_sub) el.textContent = data.currently_section_sub;
      });

      // "Currently Loving" cards — straight loop over currently_cards,
      // no hardcoded fallback content.
      const currentlyCards = Array.isArray(data.currently_cards)
        ? data.currently_cards.filter(c => c && c.show !== false && c.show !== 'false')
        : [];
      renderList('currently-cards', currentlyCards, false, 'Nothing to show yet.', c => `
          <div class="currently-card">
            <span class="currently-label">${esc(c.label || '')}</span>
            <span class="currently-value">${esc(c.value || '')}</span>
          </div>`);

      // Letter to Crafties — hide the whole section when letter_show is false
      const hideLetter = data.letter_show === false || data.letter_show === 'false';
      document.querySelectorAll('[data-cms="letter-section"]').forEach(el => {
        el.style.display = hideLetter ? 'none' : '';
      });
      if (!hideLetter) {
        document.querySelectorAll('[data-cms="letter-section-label"]').forEach(el => {
          if (data.letter_section_label) el.textContent = data.letter_section_label;
        });
        document.querySelectorAll('[data-cms="letter-section-title"]').forEach(el => {
          setEmphasizedTitle(el, data.letter_section_title);
        });
        document.querySelectorAll('[data-cms="letter-salutation"]').forEach(el => {
          if (data.letter_salutation) el.textContent = data.letter_salutation;
        });
        document.querySelectorAll('[data-cms="letter-body"]').forEach(el => {
          if (data.letter_body) el.innerHTML = md(data.letter_body);
        });
        document.querySelectorAll('[data-cms="letter-sign-name"]').forEach(el => {
          if (data.letter_sign_name) el.textContent = data.letter_sign_name;
        });
      }

      return { data, body };
    },

    /* ────────────────────────────────────────────────────────
       BOOKS
       Reads content/books/*.md
       Targets: [data-cms="books-featured-shelf"]  (index.html hero book)
                [data-cms="books-list"]             (books.html full list)
       ──────────────────────────────────────────────────────── */
    async loadBooks() {
      const [entries, characterEntries] = await Promise.all([
        fetchCollection('books'),
        fetchCollection('characters')
      ]);
      const failed = anyFailed(entries, characterEntries);

      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.published_at || '').localeCompare(a.data.published_at || ''));

      /* Published characters, kept as plain data objects so a book's
         character_leads names can be fuzzy-matched (see
         findCharacterMatch) to the real Character CMS entry and its
         uploaded illustration — not just an exact string match. */
      const publishedCharacters = characterEntries
        .filter(c => c.data.status === 'published')
        .map(c => c.data);

      const featured = published.find(e => e.data.is_featured) || published[0];

      document.querySelectorAll('[data-cms="books-featured-shelf"]').forEach(el => {
        if (!featured) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No books published yet. Add one from the dashboard.</p>';
          return;
        }
        el.innerHTML = this._featuredBookHTML(featured);
      });

      document.querySelectorAll('[data-cms="books-list"]').forEach(el => {
        if (!published.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No books published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = published.map((e) => this._bookEntryHTML(e, publishedCharacters)).join(
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
      const links = renderBookLinks(data, 'read-btn');
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

    _bookEntryHTML({ data, body }, publishedCharacters = []) {
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
      const links = renderBookLinks(data, 'read-link');

      const timelineHTML = Array.isArray(data.timeline) && data.timeline.length ? `
        <div class="timeline-block">
          <span class="timeline-label">Story Timeline</span>
          <div class="timeline-list">
            ${data.timeline.map(t => `<div class="timeline-item">${esc(t.event || t)}</div>`).join('')}
          </div>
        </div>` : '';

      const galleryHTML = Array.isArray(data.gallery) && data.gallery.length ? `
        <div class="book-gallery-block">
          <span class="book-gallery-label">Book Gallery</span>
          <div class="book-gallery-grid">
            ${data.gallery.map(g => {
              const src = g.image || g;
              const caption = g.caption || '';
              return `<div class="book-gallery-item">
                <img src="${esc(IMG(src))}" alt="${esc(caption || (data.title || 'Book') + ' gallery image')}" loading="lazy">
                ${caption ? `<span class="book-gallery-caption">${esc(caption)}</span>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>` : '';

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
              const match = findCharacterMatch(name, publishedCharacters);
              const thumb = match && match.illustration
                ? `<img src="${esc(IMG(match.illustration))}" alt="${esc(name)}" style="width:100%;height:100%;object-fit:cover">`
                : '🌸';
              /* Link using the matched character's own name so the
                 anchor always lands on the right card, even when the
                 book listed a short form (e.g. "Hriday" vs the full
                 character entry "Hriday Singh Rajvansh"). */
              const linkSlug = slugify(match ? match.name : name);
              return `<a href="characters.html#card-${esc(linkSlug)}" class="char-tile">
                <div class="char-tile-img">${thumb}</div>
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
              ${timelineHTML}
              ${galleryHTML}
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
      const [entries, bookEntries] = await Promise.all([
        fetchCollection('characters'),
        fetchCollection('books')
      ]);
      const failed = anyFailed(entries, bookEntries);

      const published = entries
        .filter(e => e.data.status === 'published' && e.data.is_featured !== false)
        .sort((a, b) => (parseInt(a.data.display_order) || 99) - (parseInt(b.data.display_order) || 99));

      /* Published books, used to (a) auto-generate the "Filter by book"
         buttons on the Character Vault and (b) reliably tag each
         character card with the book it belongs to (see findBookMatch).
         Sorted the same way loadBooks() sorts the bookshelf, so the
         filter order matches the shelf order. */
      const publishedBooks = bookEntries
        .filter(b => b.data.status === 'published')
        .map(b => b.data)
        .sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));

      document.querySelectorAll('[data-cms="characters-book-filters"]').forEach(el => {
        // A failed fetch means publishedBooks is an empty guess, not a
        // confirmed "no books" — don't wipe out filter buttons already
        // sitting in the DOM from a previous successful render.
        if (failed && !publishedBooks.length) return;
        el.innerHTML = publishedBooks.map(b =>
          `<button class="filter-btn" data-filter="${esc(slugify(b.title))}">${esc(b.title)}</button>`
        ).join('');
      });

      document.querySelectorAll('[data-cms="characters-polaroids"]').forEach(el => {
        if (!published.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No characters published yet.</p>';
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

      renderList('characters-grid', published, failed,
        'No characters published yet. Add one from the Author Dashboard.',
        e => this._charCardHTML(e, publishedBooks));

      return published;
    },

    _charCardHTML({ data, body }, publishedBooks = []) {
      const slug = slugify(data.name);
      const initial = (data.name || '?')[0];
      /* Resolve this character's free-text "book" field to the actual
         published Book entry (fuzzy match — see findBookMatch), then
         use THAT book's own title to build the filter slug. This is
         what the auto-generated filter buttons use too, so a card
         always matches the button for its book even if the character's
         book text isn't a byte-for-byte match to the book title. */
      const bookMatch = findBookMatch(data.book, publishedBooks);
      const bookSlug = slugify(bookMatch ? bookMatch.title : (data.book || ''));
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
        <div class="char-card reveal" data-book="${esc(bookSlug)}" data-role="${esc(data.role || 'lead')}" id="card-${esc(slug)}">
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
                [data-cms="bonus-filters"]   (bonus.html filter bar —
                                               buttons generated from
                                               whichever scene_type
                                               values actually appear;
                                               "All Scenes" stays as a
                                               static button already in
                                               the HTML, this only adds
                                               the rest)
                [data-cms="bonus-modal-host"] (single reusable modal container)
       ──────────────────────────────────────────────────────── */
    async loadBonusScenes() {
      const entries = await fetchCollection('bonus-scenes');
      const failed = anyFailed(entries);
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.published_at || '').localeCompare(a.data.published_at || ''));

      /* scene_type is now a free-text field in the CMS (no fixed
         option list), so authors may type it inconsistently —
         "Deleted Scene", "deleted-scene", "  deleted_scene " etc.
         Normalize before grouping/comparing so all of those collapse
         into one category and one filter button, not several. The
         normalized form (lowercase, trimmed, spaces/hyphens →
         underscores, repeats collapsed) is what data-filter and
         data-type use, so the existing filter click-handler in
         bonus.html keeps working unchanged. */
      const normType = t => String(t || '')
        .trim().toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/_+/g, '_');

      /* Cosmetic only — a nicer label/icon for known scene_type values.
         Neither map is required for a type to work: any scene_type
         value the CMS produces (including brand-new ones added to the
         dashboard later) still gets a readable auto-generated label
         and a default seal icon, so nothing here needs editing when a
         new category is introduced. */
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
      const autoLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const labelFor = t => typeLabels[t] || autoLabel(t);

      document.querySelectorAll('[data-cms="bonus-filters"]').forEach(el => {
        // A failed fetch means "published" is an empty guess, not a
        // confirmed empty collection — don't erase filter buttons a
        // previous successful load already generated.
        if (failed && !published.length) return;

        /* Unique scene_type values actually present among published
           entries — a type with zero entries never appears, and a
           brand-new type the author invents in the dashboard appears
           automatically the first time they publish one. */
        const present = [...new Set(published.map(e => normType(e.data.scene_type)).filter(Boolean))];
        const known = Object.keys(typeLabels).filter(t => present.includes(t));
        const unknown = present.filter(t => !typeLabels[t]).sort();
        const ordered = [...known, ...unknown];

        /* Only append generated buttons — never touch existing
           children, since the static "All Scenes" button (and the
           "Filter" label) already live in this element in the HTML. */
        el.querySelectorAll('.filter-btn[data-generated="1"]').forEach(b => b.remove());
        el.insertAdjacentHTML('beforeend', ordered.map(t =>
          `<button class="filter-btn" data-filter="${esc(t)}" data-generated="1">${esc(labelFor(t))}</button>`
        ).join(''));
      });

      renderList('bonus-preview', published.slice(0, 3), failed, 'No bonus scenes published yet.', ({ data }) => {
        const t = normType(data.scene_type);
        return `
          <a href="bonus.html#scene-${esc(data._slug)}" class="letter-card reveal">
            <div class="letter-seal" aria-hidden="true">${sealIcons[t] || '✦'}</div>
            <span class="letter-tag">${esc((data.characters || []).map(c => c.name || c).join(' × ')) || labelFor(t) || ''}</span>
            <h3 class="letter-title">${esc(data.title)}</h3>
            <p class="letter-excerpt">${esc(data.teaser || '')}</p>
            <span class="letter-read">Read the scene →</span>
          </a>`;
      });

      renderList('bonus-grid', published, failed, 'No bonus scenes published yet. Add one from the Author Dashboard.', ({ data }) => {
        const t = normType(data.scene_type) || 'bonus_scene';
        return `
          <div class="letter-card reveal" data-type="${esc(t)}" onclick="openScene('${esc(data._slug)}')">
            <div class="letter-torn-top"></div>
            <div class="letter-body">
              <div class="wax-seal" aria-hidden="true">${sealIcons[t] || '✦'}</div>
              <span class="scene-type-tag">${labelFor(t)}</span>
              <span class="couple-tag">${esc((data.characters || []).map(c => c.name || c).join(' × ')) || esc(data.book || '')}</span>
              <h2 class="letter-title">${esc(data.title)}</h2>
              <p class="letter-excerpt">${esc(data.teaser || '')}</p>
              <span class="letter-read-hint">Read the scene →</span>
            </div>
            <div class="letter-torn-bottom"></div>
          </div>`;
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
          document.getElementById('cms-modal-type').textContent = `${labelFor(normType(data.scene_type) || 'bonus_scene')} · ${data.book || ''}`;
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
      const failed = anyFailed(entries);
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
          if (!failed) el.innerHTML = '<p class="cms-empty">No verses published yet.</p>';
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

      // Group verses by chapter (frontend-only grouping — CMS entries stay one-per-verse)
      const chapterOrder = [];
      const chapterGroups = {};
      published.forEach(entry => {
        const ch = entry.data.gita_chapter;
        if (!chapterGroups[ch]) {
          chapterGroups[ch] = [];
          chapterOrder.push(ch);
        }
        chapterGroups[ch].push(entry);
      });

      document.querySelectorAll('[data-cms="kanha-verses"]').forEach(el => {
        if (!published.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No verses published yet. Add one from the Author Dashboard.</p>';
          return;
        }
        el.innerHTML = chapterOrder.map((ch, chIdx) => {
          const verses = chapterGroups[ch];
          const versesHTML = verses.map(({ data, body }, i) => `
            <div class="verse-card">
              <div class="verse-card-glow"></div>
              <span class="verse-chapter-label">Chapter ${esc(ch)} · ${esc(chapterNames[ch] || '')} Yoga${data.title ? ' · ' + esc(data.title) : ''}</span>
              ${data.sanskrit_text ? `<p class="verse-sanskrit">${esc(data.sanskrit_text)}</p>` : ''}
              ${data.english_meaning ? `<p class="verse-meaning">"${esc(data.english_meaning)}"</p>` : ''}
              <div class="verse-rule"></div>
              <p class="verse-reflection">${esc(body)}</p>
              <span class="verse-lotus" aria-hidden="true">🪷</span>
            </div>
            ${i < verses.length - 1 ? `<div class="verse-divider reveal" aria-hidden="true"><div class="vd-line"></div><span class="vd-icon">🪈</span><div class="vd-line"></div></div>` : ''}
          `).join('');

          return `
            <div class="verse-entry reveal" id="ch${esc(ch)}">
              ${versesHTML}
            </div>
            ${chIdx < chapterOrder.length - 1 ? `<div class="verse-divider reveal" aria-hidden="true"><div class="vd-line"></div><span class="vd-icon">🪈</span><div class="vd-line"></div></div>` : ''}
          `;
        }).join('');
      });

      document.querySelectorAll('[data-cms="kanha-chapter-pills"]').forEach(el => {
        if (!published.length) return;
        el.innerHTML = chapterOrder.map(ch =>
          `<button class="chapter-pill" onclick="jumpTo('ch${esc(ch)}')">Ch ${esc(ch)} · ${esc(chapterNames[ch] || '')}</button>`
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
      const failed = anyFailed(entries);
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (b.data.date || '').localeCompare(a.data.date || ''))
        .slice(0, 3);

      renderList('updates-latest', published, failed, 'No updates yet.', ({ data, body }) => `
          <div class="update-preview">
            <span class="update-date">${formatDate(data.date)}</span>
            <h4 class="update-title">${esc(data.title)}</h4>
            <p class="update-excerpt">${esc(data.excerpt || firstPara(body))}</p>
          </div>`);

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
      const failed = anyFailed(entries);
      /* Reviews created before the Status field existed have no
         `status` key at all — treat that as Published so nothing
         that was already live silently vanishes. */
      const visible = entries.filter(e => e.data.status !== 'draft' && e.data.status !== 'archived');
      const sorted = [...visible].sort((a, b) =>
        (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

      document.querySelectorAll('[data-cms="reviews-grid"], [data-cms="hof-reviews"]').forEach(el => {
        if (!sorted.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No reviews yet. Be the first to leave one.</p>';
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
        if (!pinned) return; // no placeholder message here before or after — leave as is either way
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
      const [entries, legacy] = await Promise.all([
        fetchCollection('fan-art'),
        fetchLegacyHallOfFame(),
      ]);
      const failed = anyFailed(entries, legacy);
      /* Older pieces have no `status` key — treat that as Published.
         `is_featured` still works exactly like it did before Status
         existed, so either flag can hide a piece. */
      const fresh = entries.filter(e =>
        e.data.status !== 'draft' && e.data.status !== 'archived' && e.data.is_featured !== false);

      const legacyFanArt = dedupeBySlug(fresh, legacyEntriesOfType(legacy, 'fan_art_showcase'))
        .map(legacyToFanArt);

      const featured = [...fresh, ...legacyFanArt];

      document.querySelectorAll('[data-cms="fanart-grid"], [data-cms="hof-fanart"]').forEach(el => {
        if (!featured.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No fan art yet. Submit yours through the Crafties Post Office.</p>';
          return;
        }
        el.innerHTML = featured.map(({ data }) => {
          const ext = data.external_link || '';
          // The image itself is always a plain, static <img> — never
          // wrapped in a link. No lightbox/gallery exists on this site
          // to open instead, so an image with no real destination must
          // not be clickable at all (that's what was sending clicks to
          // a 404). If the entry does have a genuine external_link
          // (the artist's original post), that's offered as its own
          // small, clearly-a-link line below the caption instead —
          // never as something covering the artwork.
          const hasImage = typeof data.image === 'string' && data.image.trim().length > 0;
          const img = hasImage
            ? `<img src="${esc(IMG(data.image))}" alt="${esc(data.artist_name || 'Fan art')}" class="fanart-img" loading="lazy" onerror="this.remove()">`
            : '';
          return `
            <div class="fanart-card reveal">
              ${img}
              <div class="fanart-info">
                <span class="fanart-artist">${esc(data.artist_name || '')}${data.artist_handle ? ' — ' + esc(data.artist_handle) : ''}</span>
                <span class="fanart-caption">${esc(data.description || data.book_or_character || '')}</span>
                ${ext ? `<a href="${esc(ext)}" target="_blank" rel="noopener noreferrer" class="fanart-original-link">View original ↗</a>` : ''}
              </div>
            </div>`;
        }).join('');
      });

      return featured;
    },

    /* ────────────────────────────────────────────────────────
       COMMENTS
       Reads content/hof-comments/*.md, merged with any
       legacy reader_letter entries still in content/hall-of-fame/
       ──────────────────────────────────────────────────────── */
    async loadComments() {
      const [entries, legacy] = await Promise.all([
        fetchCollection('hof-comments'),
        fetchLegacyHallOfFame(),
      ]);
      const failed = anyFailed(entries, legacy);
      const fresh = entries.filter(e => e.data.status === 'published');
      const legacyComments = dedupeBySlug(fresh, legacyEntriesOfType(legacy, 'reader_letter'))
        .map(legacyToComment);

      const items = [...fresh, ...legacyComments]
        .sort((a, b) => (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

      document.querySelectorAll('[data-cms="hof-comments"]').forEach(el => {
        if (!items.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No comments yet.</p>';
          return;
        }
        el.innerHTML = items.map(({ data }) => `
          <div class="comment-card${data.is_pinned ? ' pinned' : ''} reveal">
            <span class="comment-quote-mark">"</span>
            <p class="comment-text">${esc(data.comment || '')}</p>
            <div class="comment-meta">
              <span class="comment-reader">${esc(data.reader_handle || data.reader_name || '')}</span>
              ${data.related_book ? `<span class="comment-chapter">${esc(data.related_book)}</span>` : ''}
            </div>
          </div>`).join('');
        enableReadMore('.comment-card', '.comment-text');
      });

      return items;
    },

    /* ────────────────────────────────────────────────────────
       GOLDEN QUOTES
       Reads content/golden-quotes/*.md, merged with any
       legacy reaction_wall entries still in content/hall-of-fame/
       ──────────────────────────────────────────────────────── */
    async loadGoldenQuotes() {
      const [entries, legacy] = await Promise.all([
        fetchCollection('golden-quotes'),
        fetchLegacyHallOfFame(),
      ]);
      const failed = anyFailed(entries, legacy);
      const fresh = entries.filter(e => e.data.status === 'published');
      const legacyQuotes = dedupeBySlug(fresh, legacyEntriesOfType(legacy, 'reaction_wall'))
        .map(legacyToQuote);

      const items = [...fresh, ...legacyQuotes];

      renderList('hof-quotes', items, failed, 'No quotes yet.', ({ data }) => `
          <div class="quote-card reveal">
            <p class="quote-text">"${esc(data.quote || '')}"</p>
            <span class="quote-reader">— ${esc(data.reader_handle || data.reader_name || '')}</span>
          </div>`);

      return items;
    },

    /* ────────────────────────────────────────────────────────
       READER THEORIES
       Reads content/reader-theories/*.md, merged with any
       legacy theorist entries still in content/hall-of-fame/
       ──────────────────────────────────────────────────────── */
    async loadReaderTheories() {
      const [entries, legacy] = await Promise.all([
        fetchCollection('reader-theories'),
        fetchLegacyHallOfFame(),
      ]);
      const failed = anyFailed(entries, legacy);
      const fresh = entries.filter(e => e.data.status === 'published');
      const legacyTheories = dedupeBySlug(fresh, legacyEntriesOfType(legacy, 'theorist'))
        .map(legacyToTheory);

      const items = [...fresh, ...legacyTheories];

      document.querySelectorAll('[data-cms="hof-theories"]').forEach(el => {
        if (!items.length) {
          if (!failed) el.innerHTML = '<p class="cms-empty">No theories yet.</p>';
          return;
        }
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
        enableReadMore('.theory-card', '.theory-body');
      });

      return items;
    },

    /* ────────────────────────────────────────────────────────
       FEATURED CRAFTIES
       Reads content/featured-crafties/*.md, merged with any
       legacy featured_reader entries still in content/hall-of-fame/
       ──────────────────────────────────────────────────────── */
    async loadFeaturedCrafties() {
      const [entries, legacy] = await Promise.all([
        fetchCollection('featured-crafties'),
        fetchLegacyHallOfFame(),
      ]);
      const failed = anyFailed(entries, legacy);
      const fresh = entries.filter(e => e.data.status === 'published');
      const legacyCrafties = dedupeBySlug(fresh, legacyEntriesOfType(legacy, 'featured_reader'))
        .map(legacyToCraftie);

      const items = [...fresh, ...legacyCrafties]
        .sort((a, b) => (b.data.is_pinned ? 1 : 0) - (a.data.is_pinned ? 1 : 0));

      const badges = ['🌟', '💌', '🔥', '🪔', '☕', '📖'];
      renderList('hof-crafties', items, failed, 'No featured readers yet.', ({ data }, i) => `
          <div class="craftie-card reveal">
            <span class="craftie-badge">${badges[i % badges.length]}</span>
            <div class="craftie-name">${esc(data.reader_name)}</div>
            ${data.reader_handle ? `<span class="craftie-handle">${esc(data.reader_handle)}</span>` : ''}
            <p class="craftie-note">${esc(data.author_note_about_reader || '')}</p>
          </div>`);

      return items;
    },

    /* ────────────────────────────────────────────────────────
       STATISTICS / MILESTONES
       Reads content/statistics/*.md
       Each entry: value, title, subtitle, display_order, status
       Target: [data-cms="hof-milestones"]  (hall-of-fame.html "The Milestones")
       Fully dashboard-driven — add, remove, reorder, or edit any
       statistic from the CMS with zero HTML/JS changes.
       ──────────────────────────────────────────────────────── */
    async loadMilestones() {
      const entries = await fetchCollection('statistics');
      const failed = anyFailed(entries);
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (parseInt(a.data.display_order) || 99) - (parseInt(b.data.display_order) || 99));

      renderList('hof-milestones', published, failed, 'No statistics published yet.', ({ data }) => `
          <div class="milestone-card reveal">
            <span class="milestone-number">${esc(data.value)}</span>
            <span class="milestone-label">${esc(data.title)}</span>
            ${data.subtitle ? `<span class="milestone-date">${esc(data.subtitle)}</span>` : ''}
          </div>`);

      return published;
    },

    /* ────────────────────────────────────────────────────────
       FEATURED POSTCARDS
       Reads content/postcards/*.md
       Target: [data-cms="postcards-grid"]  (crafties.html "Things you sent me")

       Adding, editing, removing, or reordering postcards from the
       dashboard updates this grid automatically — no HTML/JS changes
       needed. Order is controlled by display_order (lower first);
       only Status: Published postcards are shown.
       ──────────────────────────────────────────────────────── */
    async loadPostcards() {
      const entries = await fetchCollection('postcards');
      const failed = anyFailed(entries);
      const published = entries
        .filter(e => e.data.status === 'published')
        .sort((a, b) => (parseInt(a.data.display_order) || 99) - (parseInt(b.data.display_order) || 99));

      renderList('postcards-grid', published, failed, 'No postcards yet. Be the first to send one.', ({ data }, i) => `
          <div class="postcard reveal${i % 5 ? ` d${i % 5}` : ''}">
            <div class="postcard-header">
              <div class="postcard-to">${esc(data.recipient || 'To: thatbrowncraft')}</div>
              <div class="postcard-stamp">${data.show_heart_icon !== false ? '💌' : ''}</div>
            </div>
            <div class="postcard-body">
              <span class="postcard-category">${esc(data.category || '')}</span>
              <p class="postcard-message">"${esc(data.message || '')}"</p>
              <div class="postcard-from">— ${esc(data.signature || '')}</div>
            </div>
          </div>`);

      return published;
    },
    async init() {
      const has = attr => !!document.querySelector(`[data-cms="${attr}"]`);
      const jobs = [];

      // Global site settings
        jobs.push(this.loadSocial());
        jobs.push(this.loadAuthor());

      if (has('books-featured-shelf') || has('books-list'))
        jobs.push(this.loadBooks());

      if (has('characters-polaroids') || has('characters-grid'))
        jobs.push(this.loadCharacters());

      if (has('bonus-preview') || has('bonus-grid') || has('bonus-filters'))
        jobs.push(this.loadBonusScenes());

      if (has('kanha-preview') || has('kanha-verses') || has('kanha-chapter-pills'))
        jobs.push(this.loadKanha());

      if (has('updates-latest'))
        jobs.push(this.loadUpdatesPreview());

      if (has('reviews-grid') || has('reviews-featured') || has('hof-reviews'))
        jobs.push(this.loadReviews());

      if (has('fanart-grid') || has('hof-fanart'))
        jobs.push(this.loadFanArt());

      if (has('hof-crafties'))
        jobs.push(this.loadFeaturedCrafties());

      if (has('hof-theories'))
        jobs.push(this.loadReaderTheories());

      if (has('hof-comments'))
        jobs.push(this.loadComments());

      if (has('hof-quotes'))
        jobs.push(this.loadGoldenQuotes());

      if (has('hof-milestones'))
        jobs.push(this.loadMilestones());

      if (has('postcards-grid'))
        jobs.push(this.loadPostcards());

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
