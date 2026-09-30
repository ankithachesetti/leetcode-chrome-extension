// Cache + history live in chrome.storage.local (survive restarts).
// Session stats live in chrome.storage.session (survive service-worker restarts, reset with the browser session).

const local = chrome.storage.local;

export async function getCache() {
  return (await local.get('cache')).cache || {};
}
export async function setCache(key, val, max = 200) {
  const cache = await getCache();
  cache[key] = val;
  const keys = Object.keys(cache);
  if (keys.length > max) {
    keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, keys.length - max).forEach((k) => delete cache[k]);
  }
  await local.set({ cache });
}

export async function getHist() {
  return (await local.get('hist')).hist || {};
}
export async function setHist(slug, entry, max = 40) {
  const hist = await getHist();
  hist[slug] = entry;
  const keys = Object.keys(hist);
  if (keys.length > max) {
    keys.sort((a, b) => hist[a].ts - hist[b].ts).slice(0, keys.length - max).forEach((k) => delete hist[k]);
  }
  await local.set({ hist });
}

export async function clearProblem(slug) {
  const [cache, hist] = [await getCache(), await getHist()];
  for (const k of Object.keys(cache)) if (k.startsWith(slug + '|')) delete cache[k];
  delete hist[slug];
  await local.set({ cache, hist });
}
export const clearAll = () => local.remove(['cache', 'hist']);

const emptyStats = () => ({ requests: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, log: [], limits: null });

export async function getStats() {
  return (await chrome.storage.session.get('stats')).stats || emptyStats();
}
export async function commitStats({ requests = 0, cacheHits = 0, prompt = 0, completion = 0, limits = null }) {
  const s = await getStats();
  s.requests += requests;
  s.cacheHits += cacheHits;
  s.promptTokens += prompt;
  s.completionTokens += completion;
  if (prompt + completion) s.log.push([Date.now(), prompt + completion]);
  s.log = s.log.filter(([t]) => Date.now() - t < 60000);
  if (limits) s.limits = limits;
  await chrome.storage.session.set({ stats: s });
  return s;
}
export const tokensLastMinute = (s) =>
  s.log.filter(([t]) => Date.now() - t < 60000).reduce((a, [, n]) => a + n, 0);
