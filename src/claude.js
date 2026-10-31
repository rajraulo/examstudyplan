// Minimal browser client for the Anthropic Messages API with streaming
// and automatic continuation when the output hits max_tokens.

const API_URL = "https://api.anthropic.com/v1/messages";

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced, recommended)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (deepest, slower, pricier)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];

export const SYSTEM_PROMPT = `You are an expert tutor and exam coach. The user supplies study materials and instructions describing the exam-prep output they want (e.g. revision notes, summaries, flashcards, practice questions with answers, mock tests, cheat sheets, mind-map style outlines).

Rules:
- Ground everything in the supplied materials. If you add knowledge beyond them, mark it clearly as "Beyond the materials".
- Follow the user's instructions about scope, structure, depth and length precisely.
- Expand every acronym on first use, e.g. CSA (Certified System Administrator).
- Output ONLY an HTML fragment (no <html>, <head>, <body>, no markdown fences, no commentary before or after). It will be inserted into a styled printable page.
- Use semantic HTML: <h1> once for the title, <h2>/<h3> for sections, <p>, <ul>/<ol>, <table> for comparisons, <blockquote> for key definitions, <code>/<pre> for code or commands.
- Useful classes you may use: <div class="callout tip">, <div class="callout warn">, <div class="callout key"> for highlighted boxes; <details><summary>Question</summary>Answer</details> for self-test Q&A; <div class="page-break"></div> between major parts.
- No <script>, no external images, no inline event handlers.`;

/**
 * Stream a generation. onText(fullTextSoFar) is called as tokens arrive.
 * Returns the final text. Continues automatically up to maxContinuations times.
 */
export async function generate({ apiKey, model, content, maxTokens = 32000, maxContinuations = 3, onText, onStatus, signal }) {
  const messages = [{ role: "user", content }];
  let full = "";

  for (let round = 0; round <= maxContinuations; round++) {
    if (round > 0) onStatus?.(`Output was long — continuing (part ${round + 1})…`);
    const { text, stopReason } = await streamOnce({
      apiKey, model, messages, maxTokens, signal,
      onDelta: (t) => { full += t; onText?.(full); },
    });
    if (stopReason !== "max_tokens") return full;
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: "Continue exactly where you stopped. Do not repeat anything and do not add any preamble — output only the remaining HTML.",
    });
  }
  return full;
}

async function streamOnce({ apiKey, model, messages, maxTokens, signal, onDelta }) {
  const res = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calls made directly from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages, stream: true }),
  });

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason = null;

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
      } else if (data.type === "error") {
        throw new Error(data.error?.message || "Stream error");
      }
    }
  }
  return { text, stopReason };
}
