// Large-input pipeline:
//   small inputs  -> one direct request with all files
//   large inputs  -> MAP: split into chunks, extract notes per chunk in parallel
//                    REDUCE: merge notes hierarchically until they fit
//                    FINAL: write the requested exam-prep output from the notes
// Completed chunk notes are cached, so a failed or stopped run can be resumed.
import { chunkText, imageBlock, pdfBlock, pdfRange, releasePdfCache, wholeFileBytes } from "./fileParsers.js";
import { ApiError, FINAL_SYSTEM, MAP_SYSTEM, REDUCE_SYSTEM, generateLong } from "./claude.js";

export const LIMITS = {
  pdfPagesPerChunk: 40,
  maxChunkBytes: 24e6,
  textCharsPerChunk: 240_000,
  imagesPerChunk: 20,
  directMaxTokens: 120_000,
  directMaxBytes: 24e6,
  directMaxPdfPages: 90,
  notesTargetChars: 360_000, // final-stage notes budget (~90k tokens)
  reduceGroupChars: 280_000,
};
const TOK = { pdfPage: 2500, image: 1600, perChar: 0.27 };

// ---------- planning ----------

export function summarize(materials) {
  let pages = 0, images = 0, chars = 0, bytes = 0;
  for (const m of materials) {
    bytes += m.size;
    if (m.info.kind === "pdf") pages += m.info.pages;
    else if (m.info.kind === "image") images++;
    else chars += m.info.text.length;
  }
  const tokens = Math.round(pages * TOK.pdfPage + images * TOK.image + chars * TOK.perChar);
  const direct = tokens <= LIMITS.directMaxTokens && bytes <= LIMITS.directMaxBytes && pages <= LIMITS.directMaxPdfPages;
  return { pages, images, chars, bytes, tokens, direct, jobs: direct ? 1 : planJobs(materials).length };
}

export function planJobs(materials) {
  const jobs = [];
  let imgGroup = [];
  const flushImages = () => {
    if (!imgGroup.length) return;
    const n = jobs.filter((j) => j.kind === "images").length + 1;
    jobs.push({ kind: "images", key: "img:" + imgGroup.map((m) => m.id).join(","), items: imgGroup, label: `Images group ${n}` });
    imgGroup = [];
  };
  for (const m of materials) {
    if (m.info.kind === "pdf") {
      // Fewer pages per section for image-heavy PDFs so each section stays under the byte budget.
      const bytesPerPage = m.size / Math.max(1, m.info.pages);
      const N = Math.max(1, Math.min(LIMITS.pdfPagesPerChunk, Math.floor((LIMITS.maxChunkBytes * 0.75) / bytesPerPage)));
      for (let from = 1; from <= m.info.pages; from += N) {
        const to = Math.min(m.info.pages, from + N - 1);
        jobs.push({ kind: "pdf", key: `${m.id}:${from}-${to}`, m, from, to, label: `${m.name}, pages ${from}–${to}` });
      }
    } else if (m.info.kind === "text") {
      const parts = chunkText(m.info.text, LIMITS.textCharsPerChunk);
      parts.forEach((text, i) =>
        jobs.push({ kind: "text", key: `${m.id}:t${i}`, m, text, label: parts.length > 1 ? `${m.name}, part ${i + 1}/${parts.length}` : m.name })
      );
    } else {
      imgGroup.push(m);
      if (imgGroup.length >= LIMITS.imagesPerChunk) flushImages();
    }
  }
  flushImages();
  return jobs;
}

// ---------- helpers ----------

class NeedsSplit extends Error {}

function splitJob(job) {
  if (job.kind === "pdf" && job.to > job.from) {
    const mid = Math.floor((job.from + job.to) / 2);
    return [
      { ...job, key: job.key + "/a", from: job.from, to: mid, label: `${job.m.name}, pages ${job.from}–${mid}` },
      { ...job, key: job.key + "/b", from: mid + 1, to: job.to, label: `${job.m.name}, pages ${mid + 1}–${job.to}` },
    ];
  }
  if (job.kind === "text" && job.text.length > 20_000) {
    const [a, b] = chunkText(job.text, Math.ceil(job.text.length / 2) + 1);
    return [
      { ...job, key: job.key + "/a", text: a, label: job.label + " (a)" },
      { ...job, key: job.key + "/b", text: b || "", label: job.label + " (b)" },
    ].filter((j) => j.text);
  }
  if (job.kind === "images" && job.items.length > 1) {
    const mid = Math.ceil(job.items.length / 2);
    return [
      { ...job, key: job.key + "/a", items: job.items.slice(0, mid), label: job.label + " (a)" },
      { ...job, key: job.key + "/b", items: job.items.slice(mid), label: job.label + " (b)" },
    ];
  }
  return null;
}

// Building chunk payloads (PDF splitting, image resizing) is CPU/memory heavy,
// so it is serialised; API calls still run in parallel.
let buildLock = Promise.resolve();
function serialized(fn) {
  const run = buildLock.then(fn, fn);
  buildLock = run.catch(() => {});
  return run;
}

async function jobBlocks(job) {
  return serialized(async () => {
    if (job.kind === "pdf") {
      const bytes = await pdfRange(job.m.file, job.from, job.to);
      if (bytes.length > LIMITS.maxChunkBytes) {
        if (job.to > job.from) throw new NeedsSplit();
        throw new Error(`${job.label} is a single page larger than ${Math.round(LIMITS.maxChunkBytes / 1e6)} MB and can't be sent.`);
      }
      return [pdfBlock(bytes, job.label)];
    }
    if (job.kind === "text") {
      return [{ type: "text", text: `<material source="${job.label}">\n${job.text}\n</material>` }];
    }
    const blocks = [];
    for (const m of job.items) {
      blocks.push({ type: "text", text: `Image: ${m.name}` });
      blocks.push(await imageBlock(m.file));
    }
    return blocks;
  });
}

async function pool(items, concurrency, fn, signal) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

// ---------- main entry ----------

/**
 * ctx: { apiKey, model, mapModel, concurrency, instructions, extraBlocks, signal,
 *        cache: Map, onProgress({stage,done,total,message}), onText(fullText) }
 * Returns the final generated text (HTML fragment).
 */
export async function runPipeline(materials, ctx) {
  const { apiKey, model, signal, instructions, cache, onProgress } = ctx;
  const extra = ctx.extraBlocks || [];
  const plan = summarize(materials);
  const tellRetry = (stage) => (msg) => onProgress({ stage, message: msg });

  // ---- Direct mode: everything fits in one request ----
  if (plan.direct) {
    onProgress({ stage: "final", message: "Sending materials to Claude…" });
    const content = [];
    for (const m of materials) {
      if (m.info.kind === "pdf") content.push(pdfBlock(await wholeFileBytes(m.file), m.name));
      else if (m.info.kind === "image") content.push({ type: "text", text: `Image: ${m.name}` }, await imageBlock(m.file));
      else content.push({ type: "text", text: `<material source="${m.name}">\n${m.info.text}\n</material>` });
    }
    releasePdfCache();
    content.push(...extra, { type: "text", text: finalInstruction(instructions, false) });
    return generateLong({ apiKey, model, system: FINAL_SYSTEM, content, signal, onText: ctx.onText, onStatus: tellRetry("final") });
  }

  // ---- MAP ----
  const jobs = planJobs(materials);
  const notes = new Array(jobs.length);
  const failures = [];
  let done = jobs.filter((j) => cache.has(j.key)).length;
  onProgress({ stage: "map", done, total: jobs.length, message: `Extracting notes from ${jobs.length} sections…` });

  const processJob = async (job) => {
    if (cache.has(job.key)) return cache.get(job.key);
    let blocks;
    try {
      blocks = await jobBlocks(job);
    } catch (e) {
      if (!(e instanceof NeedsSplit)) throw e;
    }
    if (blocks) {
      try {
        const out = await generateLong({
          apiKey, model: ctx.mapModel, system: MAP_SYSTEM, signal, maxTokens: 8000, maxContinuations: 1,
          content: [
            ...blocks,
            { type: "text", text: `Source reference: ${job.label}\n\nThe user's exam goal (use it to judge emphasis, but still capture everything exam-relevant):\n<instructions>\n${instructions}\n</instructions>\n\nWrite the notes for this section now.` },
          ],
          onStatus: tellRetry("map"),
        });
        cache.set(job.key, out);
        return out;
      } catch (e) {
        if (!(e instanceof ApiError && e.tooLarge)) throw e;
      }
    }
    const parts = splitJob(job);
    if (!parts) throw new Error(`${job.label} is too large to process even on its own.`);
    onProgress({ stage: "map", message: `Splitting ${job.label} into smaller parts…` });
    const out = [];
    for (const p of parts) out.push(await processJob(p));
    const joined = out.join("\n\n");
    cache.set(job.key, joined);
    return joined;
  };

  await pool(jobs, ctx.concurrency, async (job, i) => {
    const wasCached = cache.has(job.key);
    try {
      notes[i] = await processJob(job);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (e instanceof ApiError && e.status === 401) throw e;
      failures.push(`${job.label}: ${e.message}`);
      return;
    }
    if (!wasCached) done++;
    onProgress({ stage: "map", done, total: jobs.length, message: `Extracted ${job.label}` });
  }, signal);
  releasePdfCache();

  if (failures.length) {
    throw new Error(
      `${failures.length} of ${jobs.length} sections failed:\n• ${failures.slice(0, 8).join("\n• ")}${failures.length > 8 ? "\n• …" : ""}\n\n` +
      `Completed sections are saved — click Generate again to retry only the failed ones.`
    );
  }

  // ---- REDUCE ----
  let list = notes.map((n, i) => `### Source: ${jobs[i].label}\n${n}`);
  let total = list.reduce((a, s) => a + s.length, 0);
  for (let round = 1; total > LIMITS.notesTargetChars && round <= 5; round++) {
    const groups = [];
    let cur = [], size = 0;
    for (const s of list) {
      if (size + s.length > LIMITS.reduceGroupChars && cur.length) { groups.push(cur); cur = []; size = 0; }
      cur.push(s); size += s.length;
    }
    if (cur.length) groups.push(cur);
    if (groups.length === 1 && round > 1) break;

    let rdone = 0;
    onProgress({ stage: "reduce", done: 0, total: groups.length, message: `Condensing notes (round ${round}, ${groups.length} groups)…` });
    const merged = new Array(groups.length);
    await pool(groups, ctx.concurrency, async (g, i) => {
      const text = g.join("\n\n---\n\n");
      const key = "reduce:" + hash(text);
      if (!cache.has(key)) {
        const out = await generateLong({
          apiKey, model: ctx.mapModel, system: REDUCE_SYSTEM, signal, maxTokens: 16000, maxContinuations: 1,
          content: [{ type: "text", text: `<notes>\n${text}\n</notes>\n\nThe user's exam goal, to guide organisation:\n<instructions>\n${instructions}\n</instructions>` }],
          onStatus: tellRetry("reduce"),
        });
        cache.set(key, out);
      }
      merged[i] = cache.get(key);
      onProgress({ stage: "reduce", done: ++rdone, total: groups.length, message: `Condensing notes (round ${round})…` });
    }, signal);
    const newTotal = merged.reduce((a, s) => a + s.length, 0);
    list = merged;
    if (newTotal > total * 0.9) { total = newTotal; break; }
    total = newTotal;
  }

  // ---- FINAL ----
  onProgress({ stage: "final", message: "Writing your exam-prep output…" });
  const content = [
    ...extra,
    { type: "text", text: `<notes source="condensed from all ${jobs.length} sections of the study materials">\n${list.join("\n\n---\n\n")}\n</notes>` },
    { type: "text", text: finalInstruction(instructions, true) },
  ];
  return generateLong({ apiKey, model, system: FINAL_SYSTEM, content, signal, onText: ctx.onText, onStatus: tellRetry("final") });
}

function finalInstruction(instructions, fromNotes) {
  return `<instructions>\n${instructions}\n</instructions>\n\nUsing ALL the ${fromNotes ? "notes above (they were extracted from the complete study materials)" : "study materials above"}, produce the exam-prep output described in the instructions. Output format: a single HTML fragment as specified in your system prompt.`;
}
