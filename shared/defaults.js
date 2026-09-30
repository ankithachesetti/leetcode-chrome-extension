export const LANGS = { java: 'Java', python: 'Python', c: 'C', javascript: 'JavaScript' };

// Model IDs here are starting points only. Pick yours from console.groq.com/settings/limits
// (or use "Load models" on the options page).
export const DEFAULTS = {
  apiKey: '',
  model: 'llama-3.3-70b-versatile',
  fallbackModel: '', // empty = automatic fallback disabled
  language: 'python',
  temperature: 0.3,
  maxOutputTokens: 2048,
  tpmCap: 6000, // tokens-per-minute cap of your chosen model, from the limits page
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

// LeetCode language label -> one of our four keys (null if unsupported)
export function normalizeLang(name = '') {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (n.startsWith('python')) return 'python';
  if (n === 'java') return 'java';
  if (n === 'c') return 'c';
  if (n === 'javascript' || n === 'js') return 'javascript';
  return null;
}
