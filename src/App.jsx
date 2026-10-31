import React, { useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT, imageBlock, inspectFile, pdfBlock, wholeFileBytes } from "./fileParsers.js";
import { MODELS } from "./claude.js";
import { runPipeline, summarize } from "./pipeline.js";
import { buildDocument, cleanFragment, downloadHtml, downloadPdf, printPdf, titleFrom } from "./output.js";

const PRESETS = [
  { label: "Revision notes", text: "Create comprehensive revision notes covering every topic in the materials. For each topic: key concepts, definitions, how it works, common pitfalls, and a short 'remember this' summary. End with a one-page cheat sheet." },
  { label: "Practice questions", text: "Create 40 exam-style multiple-choice questions spread across all topics, with 4 options each. Put each answer and a 1–2 line explanation inside a collapsible answer block. Group questions by topic and include difficulty (Easy/Medium/Hard)." },
  { label: "Cheat sheet", text: "Create a dense 2–3 page cheat sheet: the most testable facts, definitions, numbers, commands and comparisons, using tables wherever possible. No fluff." },
  { label: "Mock exam", text: "Create a full mock exam of 60 questions mirroring the real exam's style and topic weighting as far as the materials suggest. Questions first, then a page break, then an answer key with explanations." },
];

const LS_KEY = "eps.apiKey";
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
let uid = 0;

function useFileList() {
  const [items, setItems] = useState([]);
  const add = async (fileList) => {
    const files = Array.from(fileList);
    const pending = files.map((f) => ({ id: "f" + ++uid, name: f.name, size: f.size, file: f, status: "reading" }));
    setItems((s) => [...s, ...pending]);
    // Inspect sequentially so several huge PDFs aren't all held in memory at once.
    for (const p of pending) {
      try {
        const info = await inspectFile(p.file);
        setItems((s) => s.map((x) => (x.id === p.id ? { ...x, status: "ready", info } : x)));
      } catch (e) {
        setItems((s) => s.map((x) => (x.id === p.id ? { ...x, status: "error", error: e.message } : x)));
      }
    }
  };
  const remove = (id) => setItems((s) => s.filter((x) => x.id !== id));
  const clear = () => setItems([]);
  return { items, add, remove, clear };
}

function describe(f) {
  if (f.status === "reading") return "reading…";
  if (f.status === "error") return f.error;
  const extra = f.info.kind === "pdf" ? ` · ${f.info.pages} pages` : "";
  return fmtSize(f.size) + extra;
}

function DropZone({ title, hint, list, accept }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const total = list.items.reduce((a, f) => a + f.size, 0);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {list.items.length > 0 && (
          <span className="muted small">
            {list.items.length} file{list.items.length > 1 ? "s" : ""} · {fmtSize(total)}{" "}
            <button className="link" onClick={list.clear}>Clear</button>
          </span>
        )}
      </div>
      <div
        className={"drop" + (over ? " over" : "")}
        onClick={() => inputRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); list.add(e.dataTransfer.files); }}
      >
        <input ref={inputRef} type="file" multiple accept={accept} hidden
          onChange={(e) => { list.add(e.target.files); e.target.value = ""; }} />
        <div className="drop-icon">＋</div>
        <div><strong>Drop files</strong> or click to browse</div>
        <div className="muted small">{hint}</div>
      </div>
      {list.items.length > 0 && (
        <ul className="files">
          {list.items.map((f) => (
            <li key={f.id} className={f.status}>
              <span className="fname" title={f.name}>{f.name}</span>
              <span className="muted small">{describe(f)}</span>
              <button className="x" onClick={() => list.remove(f.id)} aria-label={`Remove ${f.name}`}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; } });
  const [remember, setRemember] = useState(() => { try { return !!localStorage.getItem(LS_KEY); } catch { return false; } });
  const [model, setModel] = useState(MODELS[0].id);
  const [mapModel, setMapModel] = useState("claude-haiku-5-5");
  const [concurrency, setConcurrency] = useState(3);
  const [format, setFormat] = useState("auto");
  const [promptText, setPromptText] = useState("");
  const materials = useFileList();
  const prompts = useFileList();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // {stage, done, total, message}
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState("");
  const abortRef = useRef(null);
  const lastPaint = useRef(0);
  const cacheRef = useRef(new Map());
  const [cachedCount, setCachedCount] = useState(0);

  useEffect(() => {
    try { remember && apiKey ? localStorage.setItem(LS_KEY, apiKey) : localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }, [apiKey, remember]);

  // Notes extracted by a different model shouldn't be reused.
  useEffect(() => { cacheRef.current = new Map(); setCachedCount(0); }, [mapModel]);

  useEffect(() => {
    if (!busy) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy]);

  const promptFileText = prompts.items.filter((p) => p.status === "ready" && p.info.kind === "text")
    .map((p) => `# From ${p.name}\n${p.info.text}`).join("\n\n");
  const fullInstructions = [promptFileText, promptText].filter((s) => s.trim()).join("\n\n");

  const resolvedFormat = useMemo(() => {
    if (format !== "auto") return format;
    return /\bpdf\b/i.test(fullInstructions) ? "pdf" : "html";
  }, [format, fullInstructions]);

  const readyMaterials = materials.items.filter((m) => m.status === "ready");
  const plan = useMemo(() => (readyMaterials.length ? summarize(readyMaterials) : null), [materials.items]); // eslint-disable-line
  const anyReading = [...materials.items, ...prompts.items].some((x) => x.status === "reading");
  const fragment = useMemo(() => (raw ? cleanFragment(raw) : ""), [raw]);
  const canRun = apiKey.trim() && readyMaterials.length > 0 && fullInstructions.trim() && !busy && !anyReading;

  async function promptAttachments() {
    const blocks = [];
    for (const p of prompts.items.filter((p) => p.status === "ready" && p.info.kind !== "text")) {
      if (p.info.kind === "pdf" && (p.size > 20e6 || p.info.pages > 90)) {
        throw new Error(`Instruction file "${p.name}" is large (${fmtSize(p.size)}, ${p.info.pages} pages). Add it under Study materials instead.`);
      }
      blocks.push({ type: "text", text: `The next file (${p.name}) contains instructions / exam requirements:` });
      blocks.push(p.info.kind === "pdf" ? pdfBlock(await wholeFileBytes(p.file), p.name) : await imageBlock(p.file));
    }
    return blocks;
  }

  async function run() {
    setError(""); setRaw(""); setPreview(""); setBusy(true); setStatus("");
    setProgress({ stage: "prep", message: "Preparing…" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let started = false;
    try {
      const extraBlocks = await promptAttachments();
      const out = await runPipeline(readyMaterials, {
        apiKey: apiKey.trim(), model, mapModel, concurrency, instructions: fullInstructions,
        extraBlocks, signal: ctrl.signal, cache: cacheRef.current,
        onProgress: (p) => { setProgress((old) => ({ ...old, ...p })); setCachedCount(cacheRef.current.size); },
        onText: (t) => {
          if (!started) { started = true; setProgress((o) => ({ ...o, stage: "final", message: "Writing…" })); }
          setRaw(t);
          const now = Date.now();
          if (now - lastPaint.current > 900) { lastPaint.current = now; setPreview(buildDocument(cleanFragment(t))); }
        },
      });
      const frag = cleanFragment(out);
      setRaw(out);
      setPreview(buildDocument(frag, titleFrom(frag)));
      setProgress(null);
      if (resolvedFormat === "pdf") {
        setStatus("Done — preparing PDF download…");
        await downloadPdf(frag);
        setStatus("Done — PDF downloaded.");
      } else {
        downloadHtml(frag);
        setStatus("Done — HTML downloaded.");
      }
    } catch (e) {
      setProgress(null);
      if (e.name === "AbortError") setStatus("Stopped. Completed sections are saved — Generate resumes from there.");
      else setError(e.message);
    } finally {
      setBusy(false);
      setCachedCount(cacheRef.current.size);
      abortRef.current = null;
    }
  }

  const wrap = (fn) => async () => { try { setError(""); await fn(fragment); } catch (e) { setError(e.message); } };
  const pct = progress?.total ? Math.round((100 * (progress.done || 0)) / progress.total) : null;
  const stageName = { prep: "Preparing", map: "Step 1 of 3 · Reading materials", reduce: "Step 2 of 3 · Condensing notes", final: plan?.direct ? "Writing" : "Step 3 of 3 · Writing" };

  return (
    <div className="app">
      <header className="top">
        <h1>Exam Prep Studio</h1>
        <p className="muted">Drop in your study materials (even hundreds of MB), tell Claude what you need, and get notes, questions or a mock exam as HTML or PDF.</p>
      </header>

      <div className="grid">
        <section className="left">
          <div className="card">
            <h3>1 · Your Anthropic API key</h3>
            <input type="password" className="input" placeholder="sk-ant-…" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck="false" />
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this device
            </label>
            <p className="muted small">The key is sent only to api.anthropic.com from your browser. Your files never touch this site's server.</p>
            <label className="lbl">Writing model (final output)</label>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          <DropZone title="2 · Study materials" list={materials} accept={ACCEPT}
            hint="PDF, Word (.docx), PowerPoint (.pptx), images, TXT / MD / CSV — any number, any total size" />

          {plan && (
            <div className="card plan">
              <h3>Processing plan</h3>
              <div className="stats">
                <div><b>{fmtSize(plan.bytes)}</b><span>total</span></div>
                {plan.pages > 0 && <div><b>{plan.pages.toLocaleString()}</b><span>PDF pages</span></div>}
                {plan.images > 0 && <div><b>{plan.images}</b><span>images</span></div>}
                <div><b>~{fmtNum(plan.tokens)}</b><span>input tokens</span></div>
              </div>
              {plan.direct ? (
                <p className="muted small">Small enough to send in a single request, so Claude reads the original files directly.</p>
              ) : (
                <>
                  <p className="muted small">
                    Too large for one request, so it is split into <b>{plan.jobs} sections</b>. Claude extracts notes from each section in parallel, condenses them, then writes your output.
                    Keep this tab open while it runs. If anything fails or you stop, Generate resumes from the saved sections.
                  </p>
                  <div className="row2">
                    <div>
                      <label className="lbl">Reading model (per section)</label>
                      <select className="input" value={mapModel} onChange={(e) => setMapModel(e.target.value)} disabled={busy}>
                        {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label.split(" (")[0]}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="lbl">Parallel requests</label>
                      <select className="input" value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} disabled={busy}>
                        {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  </div>
                  <p className="muted small">
                    Haiku keeps reading cost low on large sets. Lower parallel requests if you hit rate limits, since newer API accounts have low per-minute token limits.
                    {cachedCount > 0 && <> · <b>{cachedCount}</b> sections saved{" "}
                      <button className="link" disabled={busy} onClick={() => { cacheRef.current = new Map(); setCachedCount(0); }}>reset</button></>}
                  </p>
                </>
              )}
            </div>
          )}

          <DropZone title="3 · Prompt / instruction files (optional)" list={prompts} accept={ACCEPT}
            hint="e.g. syllabus, exam blueprint, or a prompt.txt describing what to produce" />

          <div className="card">
            <h3>4 · What should Claude make?</h3>
            <div className="chips">
              {PRESETS.map((p) => (
                <button key={p.label} className="chip" onClick={() => setPromptText(p.text)}>{p.label}</button>
              ))}
            </div>
            <textarea className="input ta" rows={6} value={promptText} onChange={(e) => setPromptText(e.target.value)}
              placeholder="Describe the output, e.g. 'Make revision notes for the CSA (Certified System Administrator) exam focusing on topics weighted highest in the blueprint, then 30 practice questions. Output as PDF.'" />
            <label className="lbl">Output format</label>
            <div className="seg">
              {[["auto", "Auto (from prompt)"], ["html", "HTML"], ["pdf", "PDF"]].map(([v, l]) => (
                <button key={v} className={format === v ? "on" : ""} onClick={() => setFormat(v)}>{l}</button>
              ))}
            </div>
            {format === "auto" && <p className="muted small">Detected: <strong>{resolvedFormat.toUpperCase()}</strong></p>}
            {cachedCount > 0 && !busy && <p className="muted small">Tip: you can change the instructions and generate again. Saved sections are reused, so the materials aren't re-read.</p>}
          </div>

          <div className="actions">
            {!busy ? (
              <button className="primary" disabled={!canRun} onClick={run}>{cachedCount > 0 ? "Generate (resume)" : "Generate"}</button>
            ) : (
              <button className="secondary" onClick={() => abortRef.current?.abort()}>Stop</button>
            )}
            <span className="muted small status">{status}</span>
          </div>

          {progress && (
            <div className="progress">
              <div className="progress-head">
                <b>{stageName[progress.stage] || "Working"}</b>
                {pct !== null && progress.stage !== "final" && <span>{progress.done}/{progress.total}</span>}
              </div>
              <div className="bar"><div className={"fill" + (pct === null || progress.stage === "final" ? " indet" : "")} style={{ width: (pct ?? 100) + "%" }} /></div>
              <div className="muted small msg">{progress.message}</div>
            </div>
          )}

          {!canRun && !busy && (
            <p className="muted small">
              {!apiKey.trim() ? "Add your API key. " : ""}
              {readyMaterials.length === 0 ? "Add at least one study material. " : ""}
              {!fullInstructions.trim() ? "Add instructions (text or a prompt file). " : ""}
              {anyReading ? "Still reading files…" : ""}
            </p>
          )}
          {error && <div className="error">{error}</div>}
        </section>

        <section className="right">
          <div className="card preview-card">
            <div className="card-head">
              <h3>Preview</h3>
              <div className="dl">
                <button disabled={!fragment || busy} onClick={wrap(downloadHtml)}>HTML</button>
                <button disabled={!fragment || busy} onClick={wrap(downloadPdf)}>PDF</button>
                <button disabled={!fragment || busy} onClick={wrap(printPdf)} title="Opens the print dialog; choose 'Save as PDF' for a crisp, searchable PDF">Print / Save as PDF</button>
              </div>
            </div>
            {preview ? (
              <iframe title="preview" className="frame" sandbox="allow-same-origin" srcDoc={preview} />
            ) : (
              <div className="empty">
                <div className="empty-art">📘</div>
                <p>Your study guide will appear here as Claude writes it.</p>
              </div>
            )}
          </div>
        </section>
      </div>
      <footer className="muted small foot">Runs entirely in your browser · Uses your own Anthropic API key and is billed to your account</footer>
    </div>
  );
}
