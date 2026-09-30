// Tiny Markdown renderer: headings, lists, bold, inline code, fenced code blocks.
// Everything is HTML-escaped first, so model output can never inject markup.
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const inline = (s) =>
  esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

function prose(text) {
  const out = [];
  let inList = false;
  const close = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^#{1,4}\s+(.*)$/.exec(line))) {
      close();
      out.push(`<h4>${inline(m[1])}</h4>`);
    } else if ((m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}

export function renderMarkdown(src) {
  // hide reasoning blocks some models emit; also handles an unclosed <think> while streaming
  src = src.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();
  // an unclosed fence (mid-stream) is treated as code until the end
  return src
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, i) => {
      if (i % 2 === 0) return prose(part);
      const m = /^```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(?:```)?$/.exec(part);
      const lang = m?.[1] || 'code';
      const code = (m?.[2] || '').replace(/\n$/, '');
      return `<div class="code"><div class="code-h"><span>${esc(lang)}</span><button class="copy" type="button">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
    })
    .join('');
}

export function lastCode(src) {
  const blocks = [...src.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  return blocks.length ? blocks[blocks.length - 1][1].replace(/\n$/, '') : '';
}
