import { getSettings } from '../shared/defaults.js';
import { getCache, setCache, getHist, setHist, getStats, commitStats, tokensLastMinute } from '../shared/store.js';
import { streamChat, GroqError } from './groq.js';
import { buildMessages, estimateTokens, compactAnswer, SYSTEM_PROMPT } from './prompts.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Serial queue: one Groq request at a time, no overlap ----
let queue = Promise.resolve();
let pending = 0;
let active = null; // { controller, port }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'groq') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'RUN') enqueue(port, msg);
    if (msg.type === 'CANCEL') active?.controller.abort();
  });
  port.onDisconnect.addListener(() => {
    port.__dead = true;
    if (active?.port === port) active.controller.abort();
  });
});

function enqueue(port, msg) {
  const send = (m) => {
    try { if (!port.__dead) port.postMessage(m); } catch { /* panel closed */ }
  };
  send({ type: 'queued', id: msg.id, ahead: pending });
  pending++;
  queue = queue.then(async () => {
    try {
      if (!port.__dead) await handle(msg, send, port);
    } catch (e) {
      send({ type: 'error', id: msg.id, message: `Unexpected error: ${e.message}` });
    } finally {
      pending--;
      active = null;
    }
  });
}

function errorPayload(id, e, lim) {
  if (e instanceof GroqError) {
    const base = { type: 'error', id, status: e.status };
    if (e.status === 429) {
      const s = e.retryAfterS ?? (lim?.resetTokensMs ? Math.ceil(lim.resetTokensMs / 1000) : 30);
      return { ...base, code: 'RATE_LIMIT', retryAfterS: s, message: e.detail || 'Rate limit reached.' };
    }
    if (e.status === 401) return { ...base, code: 'AUTH', message: 'Groq rejected the API key (401). Check it on the options page.' };
    if (e.status === 413) return { ...base, code: 'TOO_LARGE', message: 'Request too large for this model’s limits (413). Lower max output tokens or shorten the input.' };
    return { ...base, message: `Groq error ${e.status}: ${e.detail}` };
  }
  return { type: 'error', id, code: 'NETWORK', message: `Network error: ${e.message}` };
}

async function handle(msg, send, port) {
  const { id, mode, problem, lang } = msg;
  const settings = await getSettings();
  if (!settings.apiKey) {
    return send({ type: 'error', id, code: 'NO_KEY', message: 'No Groq API key yet. Open the options page and paste one.' });
  }

  const slug = problem.slug;
  const key = `${slug}|${mode === 'hint' ? 'hint' + msg.level : mode}|${lang}`;
  const cacheable = mode === 'hint' || mode === 'solution';
  const hist = (await getHist())[slug] || null;

  // ---- Cache: zero requests for repeat views ----
  if (cacheable && !msg.fresh) {
    const hit = (await getCache())[key];
    if (hit) {
      if (mode === 'solution' && !hist) {
        await setHist(slug, { lang, msgs: [{ role: 'assistant', content: compactAnswer(hit.text) }], ts: Date.now() });
      }
      await commitStats({ cacheHits: 1 });
      send({ type: 'cached', id, text: hit.text, model: hit.model });
      return send({ type: 'done', id, cached: true });
    }
  }
  if (mode === 'retry' && !hist) {
    return send({ type: 'error', id, message: 'Nothing to retry yet. Generate a solution or run debug first.' });
  }
  const effLang = mode === 'retry' ? hist.lang : lang;

  let prevHints = [];
  if (mode === 'hint') {
    const c = await getCache();
    for (let l = 1; l < msg.level; l++) {
      const h = c[`${slug}|hint${l}|${lang}`];
      if (h) prevHints.push(h.text);
    }
  }

  // ---- Budget, trimming, TPM warning ----
  const maxOut = settings.maxOutputTokens;
  const inputBudget = Math.max(1500, settings.tpmCap - maxOut - 200);
  const budgetChars = Math.max(2000, (inputBudget - estimateTokens(SYSTEM_PROMPT) - 400) * 3.5);
  const { messages, trimmed } = buildMessages({ ...msg, lang: effLang }, hist, prevHints, budgetChars);
  const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);

  const stats = await getStats();
  const est = promptTokens + maxOut;
  const recent = tokensLastMinute(stats);
  if (trimmed) send({ type: 'warn', id, message: 'Long problem text was trimmed to fit your token budget.' });
  if (est + recent > settings.tpmCap) {
    send({ type: 'warn', id, message: `About ${promptTokens} prompt tokens plus up to ${maxOut} output tokens (${recent} already used in the last minute) may exceed your ${settings.tpmCap} tokens-per-minute cap.` });
  }
  const rl = stats.limits;
  if (rl?.remainingTokens != null && Date.now() - rl.at < 60000 && est > rl.remainingTokens) {
    send({ type: 'warn', id, message: `Groq reported ${rl.remainingTokens} tokens left this minute; this request may need about ${est}.` });
  }

  // ---- Call Groq (primary, then optional fallback on 429) ----
  const temperature = mode === 'hint' ? settings.temperature : Math.min(settings.temperature, 0.2);
  const models = [...new Set([settings.model, settings.fallbackModel].filter(Boolean))];
  const controller = new AbortController();
  active = { controller, port };

  let result = null;
  let used = null;
  let lastLimits = null;

  for (let i = 0; i < models.length; i++) {
    send({ type: 'start', id, model: models[i] });
    try {
      result = await streamChat({
        apiKey: settings.apiKey,
        model: models[i],
        messages,
        temperature,
        maxTokens: maxOut,
        signal: controller.signal,
        onDelta: (text) => send({ type: 'delta', id, text }),
        onLimits: (l) => { lastLimits = l; },
      });
      used = models[i];
      break;
    } catch (e) {
      const lim = e.limits || lastLimits;
      await commitStats({ requests: 1, limits: lim });
      if (e.name === 'AbortError') return send({ type: 'aborted', id });
      if (e instanceof GroqError && e.status === 429 && i < models.length - 1) {
        send({ type: 'notice', id, message: `${models[i]} is rate-limited (retry in ${e.retryAfterS ?? '?'}s). Falling back to ${models[i + 1]}.` });
        continue;
      }
      return send(errorPayload(id, e, lim));
    }
  }
  if (!result) return;
  if (!result.text.trim()) return send({ type: 'error', id, message: 'The model returned an empty response. Try again or pick another model.' });

  // ---- Bookkeeping ----
  const prompt = result.usage?.prompt_tokens ?? promptTokens;
  const completion = result.usage?.completion_tokens ?? estimateTokens(result.text);
  await commitStats({ requests: 1, prompt, completion, limits: lastLimits });

  if (cacheable) await setCache(key, { text: result.text, model: used, ts: Date.now() });

  const compact = compactAnswer(result.text);
  if (mode === 'solution' || mode === 'debug') {
    await setHist(slug, { lang, msgs: [{ role: 'assistant', content: compact }], ts: Date.now() });
  } else if (mode === 'retry') {
    const msgs = [...hist.msgs, { role: 'user', content: 'Feedback: ' + msg.feedback.slice(0, 800) }, { role: 'assistant', content: compact }].slice(-3);
    await setHist(slug, { lang: hist.lang, msgs, ts: Date.now() });
  }

  send({ type: 'done', id, model: used, usage: { prompt, completion } });
}
