// Content script (classic script, cannot use ES imports).
// Reads the problem from the page and answers GET_PROBLEM requests from the panel.
// Injected on all of leetcode.com so it survives SPA navigation; it only acts on /problems/*.
(() => {
  if (window.__lcGroqLoaded) return; // guard against double injection (manifest + scripting.executeScript)
  window.__lcGroqLoaded = true;

  // ---- Selectors: several fallbacks each, LeetCode changes class names often ----
  const SEL = {
    title: [
      '[data-cy="question-title"]',
      'div.text-title-large a[href^="/problems/"]',
      'a[href^="/problems/"][class*="text-title"]',
    ],
    description: [
      '[data-track-load="description_content"]',
      'div[class*="elfjS"]',
      '[class*="question-content"]',
      '[class*="description__"]',
    ],
    langButtons: [
      'button[aria-haspopup="dialog"]',
      'button[aria-haspopup="listbox"]',
      '[data-cy="lang-select"]',
      '#lang-select',
    ],
  };
  const KNOWN_LANGS = new Set([
    'C++', 'Java', 'Python', 'Python3', 'C', 'C#', 'JavaScript', 'TypeScript', 'PHP', 'Swift',
    'Kotlin', 'Dart', 'Go', 'Ruby', 'Scala', 'Rust', 'Racket', 'Erlang', 'Elixir',
  ]);

  const good = new Map(); // slug -> last full extraction (used when the description tab isn't visible)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const first = (sels) => {
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (el) return el;
      } catch { /* invalid selector, skip */ }
    }
    return null;
  };
  const currentSlug = () => (location.pathname.match(/^\/problems\/([^/]+)/) || [])[1] || null;

  // ---- HTML -> plain text (also strips tags/tokens we don't want to pay for) ----
  const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'PRE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'TR', 'BLOCKQUOTE']);
  function toText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'SVG', 'BUTTON'].includes(tag)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return node.alt ? `[image: ${node.alt}]` : '[image]';
    const inner = Array.from(node.childNodes).map(toText).join('');
    if (tag === 'SUP') return '^' + inner; // 10<sup>4</sup> -> 10^4 (innerText would give "104")
    if (tag === 'SUB') return '_' + inner;
    if (tag === 'LI') return '\n- ' + inner.trim();
    if (BLOCK.has(tag)) return '\n' + inner + '\n';
    return inner;
  }
  const clean = (t) =>
    (t || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Split the flat text into statement / examples / constraints
  function splitStatement(text) {
    const cm = /(^|\n)\s*Constraints:?/i.exec(text);
    const em = /(^|\n)\s*Example\s*1\s*:?/i.exec(text);
    const cIdx = cm ? cm.index : -1;
    const eIdx = em ? em.index : -1;
    const ends = [eIdx, cIdx].filter((i) => i >= 0);
    const descEnd = ends.length ? Math.min(...ends) : text.length;
    return {
      description: text.slice(0, descEnd).trim(),
      examples: eIdx >= 0 ? text.slice(eIdx, cIdx > eIdx ? cIdx : text.length).trim() : '',
      constraints: cIdx >= 0 ? text.slice(cIdx).replace(/^\s*Constraints:?\s*/i, '').trim() : '',
    };
  }

  function detectLanguage() {
    try {
      for (const b of document.querySelectorAll(SEL.langButtons.join(','))) {
        const t = (b.textContent || '').trim().split('\n')[0].trim();
        if (KNOWN_LANGS.has(t)) return t;
      }
    } catch { /* fall through */ }
    try {
      const v = localStorage.getItem('global_lang'); // e.g. "python3", "java", "cpp"
      if (v) return v.replace(/"/g, '');
    } catch { /* ignore */ }
    return null;
  }

  function extract() {
    const slug = currentSlug();
    if (!slug) return { ok: false, reason: 'Not on a /problems/ page.' };

    const titleEl = first(SEL.title);
    const href = titleEl?.getAttribute?.('href');
    if (href && !href.includes(`/problems/${slug}`)) return { ok: false, reason: 'Page still loading.', loading: true };

    const title =
      clean(titleEl?.textContent || document.title.replace(/\s*[-–|]\s*LeetCode.*$/i, '')).replace(/^\d+\.\s*/, '') || slug;
    const languageRaw = detectLanguage();

    const dEl = first(SEL.description);
    let text = dEl ? clean(toText(dEl)) : '';
    let source = 'dom';

    if (text.length < 40) {
      // Description tab not visible (Solutions/Submissions tab) -> reuse the last good read
      const g = good.get(slug);
      if (g) return { ok: true, stale: true, problem: { ...g, languageRaw } };
      // Last resort: meta description holds a truncated statement
      const meta = document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute('content');
      text = clean(meta);
      source = 'meta';
      if (!text) {
        return { ok: false, reason: 'Could not find the problem description. LeetCode’s layout may have changed.' };
      }
    } else {
      // During SPA navigation the old problem's DOM can linger for a moment
      const parts = splitStatement(text);
      for (const [s, g] of good) if (s !== slug && g.description === parts.description) return { ok: false, reason: 'Page still loading.', loading: true };
    }

    const problem = { slug, title, ...splitStatement(text), languageRaw, source };
    if (source === 'dom') good.set(slug, problem);
    return { ok: true, problem };
  }

  async function waitForProblem(timeout = 6000) {
    const t0 = Date.now();
    let r;
    do {
      r = extract();
      if (r.ok && (r.problem.source !== 'meta' || Date.now() - t0 > 3000)) return r;
      await sleep(300);
    } while (Date.now() - t0 < timeout);
    return r;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_PROBLEM') {
      waitForProblem().then(sendResponse).catch((e) => sendResponse({ ok: false, reason: String(e) }));
      return true; // async response
    }
  });

  // ---- SPA navigation: MutationObserver + interval (pushState fires no event) ----
  let lastSlug = currentSlug();
  let lastLang = detectLanguage();
  let timer = null;
  const check = () => {
    const slug = currentSlug();
    const lang = detectLanguage();
    if (slug !== lastSlug || lang !== lastLang) {
      lastSlug = slug;
      lastLang = lang;
      try {
        chrome.runtime.sendMessage({ type: 'PROBLEM_CHANGED', slug })?.catch?.(() => {});
      } catch { /* extension reloaded: context invalidated */ }
    }
  };
  const debounced = () => { clearTimeout(timer); timer = setTimeout(check, 250); };
  new MutationObserver(debounced).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', debounced);
  setInterval(check, 1000);
})();
