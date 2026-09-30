import { LANGS, getSettings, normalizeLang } from '../shared/defaults.js';
import { getCache, getHist, getStats } from '../shared/store.js';
import { renderMarkdown, lastCode, esc } from './markdown.js';

const $ = (s, r = document) => r.querySelector(s);
const HINT_TITLES = ['Pattern category', 'Key insight', 'Pseudo-code'];
const OUT_HTML = '<div class="md"></div><div class="meta small dim"></div>';

const S = {
  settings: null, problem: null, lang: 'python', langManual: false,
  busy: false, blockedUntil: 0, blockMsg: '',
  reqId: 0, port: null, handler: null,
  hints: [], solutionText: '', hasHist: false, cachedSolution: false,
  stats: null, tab: 'hint',
};

// ---------- init ----------
async function init() {
  S.settings = await getSettings();
  S.lang = S.settings.language;
  $('#lang').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#lang').value = S.lang;
  S.stats = await getStats();

  bind();
  renderStats();
  if (!S.settings.apiKey) banner('warn', 'No Groq API key yet. Click the gear to add one.');

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && ch.stats) { S.stats = ch.stats.newValue; renderStats(); }
    if (area === 'local' && ch.settings) getSettings().then((s) => (S.settings = s));
  });
  chrome.tabs.onActivated.addListener(loadProblem);
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.url || info.status === 'complete')) loadProblem();
  });
  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'PROBLEM_CHANGED') loadProblem(); });

  setInterval(tick, 1000);
  loadProblem();
}

function bind() {
  $('#btn-options').onclick = () => chrome.runtime.openOptionsPage();
  $('#lang').onchange = (e) => {
    S.lang = e.target.value; S.langManual = true;
    resetOutputs(); refreshCached();
  };
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      for (const t of ['hint', 'solution', 'debug']) $(`#view-${t}`).hidden = t !== S.tab;
      updateRetryVisibility();
    };
  });

  $('#hint-next').onclick = revealHint;
  $('#sol-go').onclick = () => generateSolution(false);
  $('#sol-regen').onclick = () => generateSolution(true);
  $('#sol-copy').onclick = (e) => copy(lastCode(S.solutionText), e.target);
  $('#dbg-go').onclick = runDebug;
  $('#retry-go').onclick = runRetry;
  $('#stop').onclick = () => getPort().postMessage({ type: 'CANCEL' });
  $('#manual-go').onclick = useManual;

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button.copy');
    if (b) copy(b.closest('.code')?.querySelector('code')?.textContent ?? '', b);
  });
}

// ---------- problem loading ----------
let loadTimer;
function loadProblem() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(doLoad, 200);
}

const ask = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'GET_PROBLEM' }).catch(() => null);

async function doLoad() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab?.url && /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/.exec(tab.url);
  if (!m) {
    if (!S.problem?.manual) setProblem(null, 'Open a LeetCode problem, then use this panel.');
    return;
  }
  const slug = m[1];
  let res = await ask(tab.id);
  if (!res) { // content script missing (tab opened before install/reload): inject and retry once
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      res = await ask(tab.id);
    } catch { /* not injectable */ }
  }
  if (!res?.ok) {
    if (S.problem?.manual && S.problem.slug === slug) return;
    return setProblem(null, res?.reason || 'Could not reach the page. Reload the LeetCode tab.', slug);
  }
  setProblem(res.problem);
}

async function setProblem(p, reason, slugHint) {
  const prev = S.problem?.slug;
  S.problem = p;
  S.slugHint = slugHint || null;
  if (!p) {
    $('#p-title').textContent = 'No problem loaded';
    $('#p-sub').textContent = reason || '';
    $('#lang-note').textContent = '';
    $('#manual').hidden = false;
    if (prev) resetOutputs();
    return applyDisabled();
  }
  $('#manual').hidden = true;
  if (p.slug !== prev) S.langManual = false;
  const detected = normalizeLang(p.languageRaw);
  const newLang = S.langManual ? S.lang : detected || S.settings.language;
  const changed = p.slug !== prev || newLang !== S.lang;
  S.lang = newLang;
  $('#lang').value = newLang;

  $('#p-title').textContent = p.title;
  $('#p-sub').textContent = p.manual
    ? 'Pasted statement'
    : p.source === 'meta'
      ? 'Partial statement only (page layout may have changed)'
      : p.slug;
  $('#lang-note').textContent =
    !S.langManual && p.languageRaw && !detected ? `${p.languageRaw} isn’t supported here` : '';

  if (changed) { resetOutputs(); await refreshCached(); }
  applyDisabled();
}

function useManual() {
  const text = $('#manual-text').value.trim();
  if (!text) return;
  const slug = S.slugHint || 'manual';
  setProblem({ slug, title: 'Pasted problem', description: text, examples: '', constraints: '', manual: true, source: 'manual' });
}

// ---------- cached state ----------
function resetOutputs() {
  S.hints = []; S.solutionText = ''; S.hasHist = false; S.cachedSolution = false;
  $('#hint-list').innerHTML = '';
  $('#sol-out').innerHTML = OUT_HTML;
  $('#dbg-out').innerHTML = OUT_HTML;
  $('#retry-log').innerHTML = '';
  banner(null);
  updateAll();
}

async function refreshCached() {
  const p = S.problem;
  if (!p) return;
  const [cache, hist] = [await getCache(), await getHist()];
  S.hints = [];
  $('#hint-list').innerHTML = '';
  for (let l = 1; l <= 3; l++) {
    const h = cache[`${p.slug}|hint${l}|${S.lang}`];
    if (!h) break;
    const out = addHintCard(l);
    $('.md', out).innerHTML = renderMarkdown(h.text);
    $('.meta', out).textContent = `cached from ${h.model}`;
    S.hints.push(h.text);
  }
  S.cachedSolution = !!cache[`${p.slug}|solution|${S.lang}`];
  S.hasHist = !!hist[p.slug];
  updateAll();
}

// ---------- modes ----------
function addHintCard(level) {
  const card = document.createElement('article');
  card.className = 'note';
  card.innerHTML = `<h4>Hint ${level}: ${HINT_TITLES[level - 1]}</h4><div class="out">${OUT_HTML}</div>`;
  $('#hint-list').appendChild(card);
  return $('.out', card);
}

function revealHint() {
  const level = S.hints.length + 1;
  if (level > 3) return;
  const out = addHintCard(level);
  run(out, { mode: 'hint', level }, {
    onDone: (text) => { S.hints.push(text); updateAll(); },
    onFail: () => { if (!$('.md', out).textContent.trim()) out.closest('.note').remove(); },
  });
}

function generateSolution(fresh) {
  run($('#sol-out'), { mode: 'solution', fresh }, {
    onDone: async (text) => { S.solutionText = text; S.cachedSolution = true; await refreshHist(); },
  });
}

function runDebug() {
  const code = $('#dbg-code').value;
  const notes = $('#dbg-notes').value;
  if (!code.trim() && !notes.trim()) return banner('warn', 'Paste your code or a failing test case first.');
  run($('#dbg-out'), { mode: 'debug', code, notes }, { onDone: refreshHist });
}

function runRetry() {
  const feedback = $('#retry-input').value.trim();
  if (!feedback) return banner('warn', 'Paste the failing test case or error first.');
  const card = document.createElement('article');
  card.className = 'note plain';
  card.innerHTML = `<h4>Feedback</h4><pre class="fb"></pre><div class="out">${OUT_HTML}</div>`;
  $('.fb', card).textContent = feedback.length > 300 ? feedback.slice(0, 300) + '…' : feedback;
  $('#retry-log').prepend(card);
  run($('.out', card), { mode: 'retry', feedback }, {
    onDone: async (text) => { $('#retry-input').value = ''; S.solutionText = text; await refreshHist(); },
    onFail: () => { if (!$('.md', card).textContent.trim()) card.remove(); },
  });
}

async function refreshHist() {
  const hist = await getHist();
  S.hasHist = !!(S.problem && hist[S.problem.slug]);
  updateAll();
}

// ---------- streaming ----------
function getPort() {
  if (S.port) return S.port;
  const port = chrome.runtime.connect({ name: 'groq' });
  port.onMessage.addListener((m) => S.handler?.(m));
  port.onDisconnect.addListener(() => {
    S.port = null;
    if (S.busy) S.handler?.({ type: 'error', id: S.reqId, message: 'Lost the connection to the background worker. Try again.' });
  });
  return (S.port = port);
}

function throttle(fn, ms) {
  let last = 0, timer = null;
  const t = () => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(); }, ms - (now - last));
  };
  t.flush = () => { clearTimeout(timer); timer = null; fn(); };
  return t;
}

function run(out, payload, { onDone, onFail } = {}) {
  if (S.busy || Date.now() < S.blockedUntil) return;
  if (!S.problem) return banner('warn', 'No problem loaded.');
  const id = ++S.reqId;
  const md = $('.md', out), meta = $('.meta', out);
  let text = '';
  const paint = throttle(() => { md.innerHTML = renderMarkdown(text); }, 50);
  const end = () => { setBusy(false); S.handler = null; };

  setBusy(true);
  banner(null);
  md.innerHTML = '<span class="dim">Queued…</span>';
  meta.textContent = '';

  S.handler = (m) => {
    if (m.id !== id) return;
    switch (m.type) {
      case 'queued': if (m.ahead) md.innerHTML = `<span class="dim">Waiting for ${m.ahead} earlier request(s)…</span>`; break;
      case 'warn': case 'notice': banner('warn', m.message, true); break;
      case 'start': md.innerHTML = `<span class="dim">Waiting for ${esc(m.model)}…</span>`; break;
      case 'delta': text += m.text; paint(); break;
      case 'cached': text = m.text; md.innerHTML = renderMarkdown(text); meta.textContent = `cached from ${m.model}, no request used`; break;
      case 'done':
        paint.flush();
        if (!m.cached) meta.textContent = `${m.model}: ${m.usage.prompt} prompt and ${m.usage.completion} completion tokens`;
        end(); onDone?.(text, m);
        break;
      case 'aborted':
        meta.textContent = 'stopped';
        end(); onFail?.(m);
        break;
      case 'error':
        if (!text) md.innerHTML = '';
        if (m.code === 'RATE_LIMIT') {
          S.blockedUntil = Date.now() + (m.retryAfterS ?? 30) * 1000;
          S.blockMsg = 'Groq rate limit reached.';
          tick();
        } else {
          banner('err', m.message);
        }
        end(); onFail?.(m);
        break;
    }
  };

  getPort().postMessage({
    type: 'RUN', id, lang: S.lang, ...payload,
    problem: pick(S.problem),
  });
}

const pick = ({ slug, title, description, examples, constraints }) => ({ slug, title, description, examples, constraints });

// ---------- UI state ----------
function setBusy(v) {
  S.busy = v;
  $('#busybar').hidden = !v;
  applyDisabled();
}

function applyDisabled() {
  const blocked = S.busy || Date.now() < S.blockedUntil || !S.problem;
  document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = blocked; });
  if (S.hints.length >= 3) $('#hint-next').disabled = true;
}

function updateAll() {
  const n = S.hints.length;
  $('#hint-next').textContent = n >= 3 ? 'All 3 hints revealed' : `Reveal hint ${n + 1} of 3`;
  $('#sol-go').textContent = S.cachedSolution ? 'Show solution (saved)' : 'Generate solution';
  $('#sol-regen').hidden = !S.cachedSolution;
  $('#sol-copy').hidden = !lastCode(S.solutionText);
  updateRetryVisibility();
  applyDisabled();
}

function updateRetryVisibility() {
  $('#retry').hidden = !(S.hasHist && S.tab !== 'hint');
}

function banner(kind, msg, append = false) {
  const b = $('#banner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind}`;
  b.textContent = append && !b.hidden ? `${b.textContent}\n${msg}` : msg;
  b.hidden = false;
}

function tick() {
  if (S.blockedUntil) {
    const left = Math.ceil((S.blockedUntil - Date.now()) / 1000);
    if (left > 0) banner('err', `${S.blockMsg} You can retry in ${left}s.`);
    else { S.blockedUntil = 0; banner('ok', 'The rate-limit window has passed. You can send again.'); applyDisabled(); }
  }
  renderStats();
}

const fmtDur = (s) => {
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

function renderStats() {
  const s = S.stats;
  if (!s) return;
  const l = s.limits;
  const left = (ms) => (ms == null ? null : Math.max(0, Math.round((l.at + ms - Date.now()) / 1000)));
  const line = (rem, lim, ms) => {
    if (rem == null) return '–';
    const r = left(ms);
    return `${rem.toLocaleString()} of ${lim?.toLocaleString() ?? '?'}${r != null ? `, resets in ${fmtDur(r)}` : ''}`;
  };
  $('#s-req').textContent = l ? line(l.remainingRequests, l.limitRequests, l.resetRequestsMs) : '–';
  $('#s-tok').textContent = l ? line(l.remainingTokens, l.limitTokens, l.resetTokensMs) : '–';
  $('#s-sess').textContent = s.requests || s.cacheHits
    ? `${s.requests} requests, ${fmtK(s.promptTokens)} tokens in, ${fmtK(s.completionTokens)} out, ${s.cacheHits} served from cache`
    : 'nothing yet';
}

async function copy(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    btn.textContent = document.execCommand('copy') ? 'Copied' : 'Copy failed';
    ta.remove();
  }
  setTimeout(() => (btn.textContent = old), 1200);
}

init();
