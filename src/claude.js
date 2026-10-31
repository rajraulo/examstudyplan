// Browser client for the Anthropic Messages API: streaming, retries with
// backoff on rate limits / overload, and auto-continuation at max_tokens.

const API_URL = "https://api.anthropic.com/v1/messages";

export const MODELS = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, slowest, priciest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (deep, cheaper than Fable)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];

// Models whose safety classifiers can decline a request (stop_reason "refusal").
// For these we opt into server-side fallback: on a decline, the API re-runs the
// request on a suitable fallback model within the same call.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

export const FINAL_SYSTEM = `You are an expert tutor and exam coach. The user supplies study materials (or condensed notes extracted from them) and instructions describing the exam-prep output they want (e.g. revision notes, summaries, flashcards, practice questions with answers, mock tests, cheat sheets).

Rules:
- Ground everything in the supplied materials. If you add knowledge beyond them, mark it clearly as "Beyond the materials".
- Follow the user's instructions about scope, structure, depth and length precisely.
- Expand every acronym on first use, e.g. CSA (Certified System Administrator).
- Output ONLY an HTML fragment (no <html>, <head>, <body>, no markdown fences, no commentary before or after). It will be inserted into a styled printable page.
- Use semantic HTML: <h1> once for the title, <h2>/<h3> for sections, <p>, <ul>/<ol>, <table> for comparisons, <blockquote> for key definitions, <code>/<pre> for code or commands.
- Useful classes: <div class="callout tip">, <div class="callout warn">, <div class="callout key"> for highlighted boxes; <details><summary>Question</summary>Answer</details> for self-test Q&A; <div class="page-break"></div> between major parts.
- No <script>, no external images, no inline event handlers.`;

export const MAP_SYSTEM = `You are extracting study notes from one section of a larger body of study materials. Your notes will later be merged with notes from all other sections to produce exam-prep material, so the original material will NOT be available again — anything you omit is lost.

Write dense, well-organised Markdown notes that capture EVERYTHING exam-relevant in this section:
- every definition, concept, rule, process/procedure step, formula, number, threshold, date, name, command, config setting and comparison
- examples and scenarios that illustrate how concepts are applied
- anything flagged as important, a warning, a best practice or a common mistake
- content of tables, diagrams and charts (describe them in words or as Markdown tables)
Prefix each topic heading with the source reference given to you (file name and pages/part).
Be concise in wording but complete in coverage. Do not add an introduction or conclusion. Do not invent content.`;

export const REDUCE_SYSTEM = `You are merging several sets of study notes (extracted from different parts of the same study materials) into one consolidated set of Markdown notes.
- Organise by topic, not by source. Merge duplicates and overlapping points.
- Preserve every distinct exam-relevant fact, definition, number, step, command and example. Shorten wording, never drop facts.
- Keep short source references in brackets where useful.
- Output only the merged Markdown notes.`;

export class ApiError extends Error {
  constructor(message, { status, retryable = false, tooLarge = false, retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.tooLarge = tooLarge;
    this.retryAfter = retryAfter;
  }
}

const TOO_LARGE_RE = /prompt is too long|too long|exceed|too large|maximum.*(pages|tokens|size)|request_too_large|context/i;
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

/** One streamed call with retries. Returns { text, stopReason }. */
export async function callClaude({ apiKey, model, system, messages, maxTokens, signal, onDelta, onRetry, maxAttempts = 7 }) {
  let attempt = 0;
  while (true) {
    attempt++;
    let emitted = "";
    try {
      return await streamOnce({ apiKey, model, system, messages, maxTokens, signal, onDelta: (t) => { emitted += t; onDelta?.(t); } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const isNetwork = e instanceof TypeError;
      const retryable = isNetwork || e.retryable;
      // Don't retry once text has been streamed to the caller (it would duplicate output).
      if (!retryable || attempt >= maxAttempts || emitted) throw e;
      const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(90000, 4000 * 2 ** (attempt - 1)) + Math.random() * 1500;
      onRetry?.(`${e.message} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(wait, signal);
    }
  }
}

/** Streamed generation that continues automatically when max_tokens is hit. */
export async function generateLong({ apiKey, model, system, content, maxTokens = 32000, maxContinuations = 3, onText, onStatus, signal }) {
  const messages = [{ role: "user", content }];
  let full = "";
  for (let round = 0; round <= maxContinuations; round++) {
    if (round > 0) onStatus?.(`Output is long — continuing (part ${round + 1})…`);
    const { text, stopReason } = await callClaude({
      apiKey, model, system, messages, maxTokens, signal,
      onRetry: onStatus,
      onDelta: (t) => { full += t; onText?.(full); },
    });
    if (stopReason !== "max_tokens") return full;
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: "Continue exactly where you stopped. Do not repeat anything and do not add any preamble — output only the remaining content." });
  }
  return full;
}

async function streamOnce({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // Required for calls made directly from a browser.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const body = { model, max_tokens: maxTokens, system, messages, stream: true };
  if (FALLBACK_MODELS.has(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetch(API_URL, { method: "POST", signal, headers, body: JSON.stringify(body) });

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let type = "";
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
      type = j?.error?.type || "";
    } catch { /* ignore */ }
    const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10) || 0;
    const retryable = [408, 429, 500, 502, 503, 504, 529].includes(res.status) || type === "overloaded_error";
    const tooLarge = res.status === 413 || (res.status === 400 && TOO_LARGE_RE.test(msg));
    if (res.status === 401) msg = "Invalid API key (401). Check the key and try again.";
    throw new ApiError(msg, { status: res.status, retryable, tooLarge, retryAfter });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "", stopReason = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const evt of events) {
      const line = evt.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let data;
      try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
        text += data.delta.text;
        onDelta(data.delta.text);
      } else if (data.type === "message_delta" && data.delta?.stop_reason) {
        stopReason = data.delta.stop_reason;
        if (stopReason === "refusal") {
          const d = data.delta.stop_details;
          const why = d?.explanation || (d?.category ? `category: ${d.category}` : "");
          throw new ApiError(`Claude declined this request${why ? ` (${why})` : ""}. Try rewording the instructions or choosing a different model.`, { status: 200 });
        }
      } else if (data.type === "error") {
        const t = data.error?.type;
        throw new ApiError(data.error?.message || "Stream error", { retryable: t === "overloaded_error" || t === "api_error" });
      }
    }
  }
  return { text, stopReason };
}
