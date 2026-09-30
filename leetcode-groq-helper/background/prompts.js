import { LANGS } from '../shared/defaults.js';

// Constant across every request: stable prefix, and all mode-specific text goes in the user message.
export const SYSTEM_PROMPT = `You are a senior competitive programmer and patient tutor helping with one LeetCode problem at a time.

Method (follow in this order for solution and debug tasks):
1. CONSTRAINTS FIRST. Read the constraints before anything else. From the input sizes, derive the time complexity you can afford (n <= 10^5 -> O(n log n) or better; n <= 20 -> exponential is fine; n <= 500 -> O(n^3) is fine). Note value ranges that could overflow.
2. CHOOSE THE PATTERN. Pick from: hash map/set, two pointers, sliding window, prefix sums, binary search (including on the answer), stack/monotonic stack, heap, sorting/intervals, greedy, BFS/DFS, union-find, topological sort, backtracking, DP (1D, 2D, knapsack, bitmask), trie, bit manipulation, math. Name it explicitly and say which property of the input points to it.
3. WRITE CLEAN CODE. Use the standard LeetCode signature for the language. Meaningful names, no dead code, no I/O boilerplate, comments only where non-obvious.
4. SELF-CHECK. Before finalizing, trace the code by hand on every provided example and on: empty/minimal input, single element, duplicates, zero/negative values, integer overflow, maximum constraints (time and recursion depth). Keep traces short (key variable values, not every line). If any trace disagrees with the expected output, fix the code and give the corrected version.

Rules:
- Follow the TASK block in the user message exactly, including its section headings. Hint tasks are short and must never reveal more than the requested hint.
- Never invent constraints or examples that are not in the statement. If the statement looks truncated or ambiguous, say so in one line and state your assumption.
- Correctness over cleverness: prefer the simplest algorithm that meets the constraints.
- No greetings, no restating the problem. Markdown output; all code in fenced blocks tagged with the language.`;

export const estimateTokens = (s = '') => Math.ceil(s.length / 3.5);
const cap = (s = '', n) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s);

const LANG_NOTES = {
  java: 'Java: `class Solution` with the LeetCode method signature. Use `long` where sums/products can exceed 2^31-1; beware Math.abs(Integer.MIN_VALUE); avoid deep recursion for n around 10^5.',
  python: 'Python 3: `class Solution` with the LeetCode signature and type hints. Default recursion limit is ~1000, so prefer iterative for deep recursion. Ints are unbounded, but respect 32-bit semantics if the statement requires them.',
  c: 'C: use the LeetCode C signature (returnSize / returnColumnSizes out-params). malloc anything you return; use `long long` where int may overflow; no STL, so write helpers (e.g. a qsort comparator) yourself.',
  javascript: 'JavaScript: a function with the LeetCode signature. Numbers are doubles (exact only to 2^53); use BigInt only if truly needed. Array.prototype.sort is lexicographic by default, so always pass a comparator.',
};

const HINT_TASKS = {
  1: 'Give ONLY the pattern category (for example "this is a sliding-window problem") and one sentence on which feature of the problem signals it. No algorithm description, no code. Max 60 words.',
  2: 'Give ONLY the key insight that makes the pattern work: what to track, the invariant, or why brute force wastes work. No code, no pseudo-code. Max 100 words.',
  3: 'Give language-agnostic pseudo-code (at most 15 lines) plus target time and space complexity. Do not write real code in any language.',
};

// Problem block: constraints and examples are capped first, the description absorbs the rest of the budget.
function problemBlock(p, budgetChars) {
  const constraints = cap(p.constraints, 1200);
  const examples = cap(p.examples, 1800);
  const fixed = (p.title || '').length + constraints.length + examples.length + 60;
  const description = cap(p.description, Math.max(500, budgetChars - fixed));
  const trimmed =
    description.length < (p.description || '').length ||
    constraints.length < (p.constraints || '').length ||
    examples.length < (p.examples || '').length;
  const parts = [`# ${p.title}`, `## Statement\n${description}`];
  if (examples) parts.push(`## Examples\n${examples}`);
  if (constraints) parts.push(`## Constraints\n${constraints}`);
  return { text: parts.join('\n\n'), trimmed };
}

// Retry turns don't resend the full problem: title, start of the statement, constraints.
function stub(p, lang) {
  const parts = [`# ${p.title}`, cap(p.description, 700)];
  if (p.constraints) parts.push(`## Constraints\n${cap(p.constraints, 800)}`);
  return `${parts.join('\n\n')}\n\n(Full statement omitted to save tokens. Language: ${LANGS[lang]}. ${LANG_NOTES[lang]})`;
}

// Keep only the last code block of an answer for history (drops prose, saves tokens on retries)
export function compactAnswer(text) {
  const blocks = [...text.matchAll(/```([\w+#-]*)[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) return cap(text, 1500);
  const [, lang, code] = blocks[blocks.length - 1];
  return `My latest code:\n\`\`\`${lang}\n${code.trim()}\n\`\`\``;
}

const SOLUTION_TASK = (L) => `TASK: full solution. Answer with exactly these Markdown sections, in this order:
## Constraints
Input sizes, the complexity they allow, value ranges and overflow risks. Two lines max.
## Pattern
Name the pattern and the property of the input that signals it.
## Brute force
Idea in 2-3 sentences. Time: ... Space: ...
## Optimized
Idea in 2-4 sentences. Time: ... Space: ...
## Code
One fenced ${L} block implementing the optimized approach. Handle empty/minimal input, duplicates, overflow and maximum constraints.
## Self-check
Trace the code on each provided example, then on empty/minimal input, duplicates, overflow and maximum constraints.
## Corrected code
Only if the self-check found a bug: the full corrected code in one fenced block. Otherwise write "No changes."`;

const DEBUG_TASK = `TASK: debug my code. Answer with exactly these Markdown sections:
## Verdict
One sentence: correct, wrong answer, TLE or runtime error, and why.
## Failing case
The smallest input that breaks it, expected vs actual, derived by tracing the code (do not guess).
## Root cause
## Fix
The full corrected code in one fenced block.
## Check
Trace the fixed code on the failing case and on one provided example.
If the code is actually correct, say so and point out any hidden edge-case risk instead.`;

const RETRY_TASK = `TASK: retry. The last code you gave fails. Answer with exactly these sections:
## Diagnosis
Trace the previous code on the feedback below and say precisely why it fails.
## Fixed code
The full corrected code in one fenced block.
## Check
Trace the fixed code on the failing input from the feedback.`;

// req: { mode, level, problem, lang, code, notes, feedback }
// hist: { lang, msgs } | null,  prevHints: string[]
export function buildMessages(req, hist, prevHints, budgetChars) {
  const { mode, problem: p, lang } = req;
  const sys = { role: 'system', content: SYSTEM_PROMPT };
  const L = LANGS[lang];

  if (mode === 'retry') {
    return {
      trimmed: false,
      messages: [
        sys,
        { role: 'user', content: stub(p, lang) },
        ...hist.msgs.slice(-3), // [assistant, user, assistant] at most; every assistant turn is code-only
        { role: 'user', content: `${RETRY_TASK}\n\nFeedback (failing test / error):\n${cap(req.feedback, 1500)}` },
      ],
    };
  }

  const { text, trimmed } = problemBlock(p, budgetChars);
  let task;
  if (mode === 'hint') {
    const prev = prevHints.length
      ? `\n\nHints already given (do not repeat them):\n${prevHints.map((h, i) => `${i + 1}. ${cap(h, 500)}`).join('\n')}`
      : '';
    task = `Language: ${L}\n\nTASK: hint ${req.level} of 3. ${HINT_TASKS[req.level]}${prev}`;
  } else if (mode === 'solution') {
    task = `Language: ${L}. ${LANG_NOTES[lang]}\n\n${SOLUTION_TASK(L)}`;
  } else {
    const notes = req.notes?.trim() ? `\n\nFailing test / error / symptom:\n${cap(req.notes, 1500)}` : '';
    task = `Language: ${L}. ${LANG_NOTES[lang]}\n\nMy code:\n\`\`\`${lang}\n${cap(req.code, 6000)}\n\`\`\`${notes}\n\n${DEBUG_TASK}`;
  }
  return { trimmed, messages: [sys, { role: 'user', content: `${text}\n\n${task}` }] };
}
