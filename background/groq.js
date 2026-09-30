const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqError extends Error {
  constructor(status, detail, limits, retryAfterS) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
    this.limits = limits;
    this.retryAfterS = retryAfterS;
  }
}

// "2m59.56s" | "7.66s" | "500ms" | "1h2m" -> milliseconds
export function parseDuration(s) {
  if (s == null || s === '') return null;
  let ms = 0;
  let found = false;
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  for (const [, n, u] of String(s).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    found = true;
    ms += parseFloat(n) * unit[u];
  }
  if (found) return Math.round(ms);
  return Number.isFinite(+s) ? +s * 1000 : null;
}

// Per Groq's docs: *-requests headers refer to requests per day, *-tokens headers to tokens per minute.
export function readLimits(h) {
  const num = (k) => (h.get(k) == null ? null : Number(h.get(k)));
  return {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    resetRequestsMs: parseDuration(h.get('x-ratelimit-reset-requests')),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    resetTokensMs: parseDuration(h.get('x-ratelimit-reset-tokens')),
    at: Date.now(),
  };
}

export async function streamChat({ apiKey, model, messages, temperature, maxTokens, signal, onDelta, onLimits }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
  });

  const limits = readLimits(res.headers);
  onLimits?.(limits);

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch { /* body not JSON */ }
    const ra = res.headers.get('retry-after'); // only present on 429
    throw new GroqError(res.status, detail || res.statusText, limits, ra == null ? null : Math.ceil(Number(ra)));
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new GroqError(500, j.error.message || 'Stream error', limits, null);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      usage = j.usage || j.x_groq?.usage || usage; // Groq puts streaming usage in x_groq on the last chunk
    }
  }
  return { text, usage };
}
