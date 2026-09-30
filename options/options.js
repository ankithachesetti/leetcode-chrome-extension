import { DEFAULTS, LANGS, getSettings } from '../shared/defaults.js';
import { clearAll } from '../shared/store.js';

const $ = (s) => document.querySelector(s);
const TEXT = ['apiKey', 'model', 'fallbackModel', 'language', 'temperature', 'maxOutputTokens', 'tpmCap'];

const flash = (el, msg, ms = 2500) => {
  el.textContent = msg;
  if (ms) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms);
};
const num = (v, min, max, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

async function load() {
  $('#language').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const s = await getSettings();
  for (const k of TEXT) $('#' + k).value = s[k];
}

$('#showKey').onchange = (e) => { $('#apiKey').type = e.target.checked ? 'text' : 'password'; };

$('#save').onclick = async () => {
  const settings = {
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim() || DEFAULTS.model,
    fallbackModel: $('#fallbackModel').value.trim(),
    language: $('#language').value,
    temperature: num($('#temperature').value, 0, 1, DEFAULTS.temperature),
    maxOutputTokens: Math.round(num($('#maxOutputTokens').value, 256, 8192, DEFAULTS.maxOutputTokens)),
    tpmCap: Math.round(num($('#tpmCap').value, 1000, 1e7, DEFAULTS.tpmCap)),
  };
  await chrome.storage.local.set({ settings });
  flash($('#saveMsg'), 'Saved.');
};

$('#clear').onclick = async () => {
  await clearAll();
  flash($('#saveMsg'), 'Cache and history cleared.');
};

$('#loadModels').onclick = async () => {
  const key = $('#apiKey').value.trim();
  const msg = $('#modelsMsg');
  if (!key) return flash(msg, 'Enter your key first.');
  flash(msg, 'Loading…', 0);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(r.status === 401 ? 'key rejected (401)' : `HTTP ${r.status}`);
    const { data } = await r.json();
    const ids = data.map((m) => m.id).filter((id) => !/whisper|tts|guard|orpheus/i.test(id)).sort();
    $('#models').innerHTML = ids.map((id) => `<option value="${id}">`).join('');
    flash(msg, `Key works. ${ids.length} chat models loaded into the suggestions.`, 6000);
  } catch (e) {
    flash(msg, `Failed: ${e.message}`, 6000);
  }
};

load();
