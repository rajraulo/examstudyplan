import React, { useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT, parseFile, toBlocks } from "./fileParsers.js";
import { MODELS, generate } from "./claude.js";
import { buildDocument, cleanFragment, downloadHtml, downloadPdf, printPdf, titleFrom } from "./output.js";

const PRESETS = [
  {
    label: "Revision notes",
    text: "Create comprehensive revision notes covering every topic in the materials. For each topic: key concepts, definitions, how it works, common pitfalls, and a short 'remember this' summary. End with a one-page cheat sheet.",
  },
  {
    label: "Practice questions",
    text: "Create 40 exam-style multiple-choice questions spread across all topics, with 4 options each. Put each answer and a 1–2 line explanation inside a collapsible answer block. Group questions by topic and include difficulty (Easy/Medium/Hard).",
  },
  {
    label: "Cheat sheet",
    text: "Create a dense 2–3 page cheat sheet: the most testable facts, definitions, numbers, commands and comparisons, using tables wherever possible. No fluff.",
  },
  {
    label: "Mock exam",
    text: "Create a full mock exam of 60 questions mirroring the real exam's style and topic weighting as far as the materials suggest. Questions first, then a page break, then an answer key with explanations.",
  },
];

const LS_KEY = "eps.apiKey";
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
let uid = 0;

function useFileList() {
  const [items, setItems] = useState([]);
  const add = async (fileList) => {
    const files = Array.from(fileList);
    const pending = files.map((f) => ({ id: ++uid, name: f.name, size: f.size, status: "reading" }));
    setItems((s) => [...s, ...pending]);
    await Promise.all(
      files.map(async (f, i) => {
        const id = pending[i].id;
        try {
          const parsed = await parseFile(f);
          setItems((s) => s.map((x) => (x.id === id ? { ...x, status: "ready", parsed } : x)));
        } catch (e) {
          setItems((s) => s.map((x) => (x.id === id ? { ...x, status: "error", error: e.message } : x)));
        }
      })
    );
  };
  const remove = (id) => setItems((s) => s.filter((x) => x.id !== id));
  const clear = () => setItems([]);
  return { items, add, remove, clear };
}

function DropZone({ title, hint, list, accept }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {list.items.length > 0 && (
          <button className="link" onClick={list.clear}>Clear all</button>
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
              <span className="muted small">
                {f.status === "reading" ? "reading…" : f.status === "error" ? f.error : fmtSize(f.size)}
              </span>
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
  const [format, setFormat] = useState("auto");
  const [promptText, setPromptText] = useState("");
  const materials = useFileList();
  const prompts = useFileList();

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState("");
  const abortRef = useRef(null);
  const lastPaint = useRef(0);

  useEffect(() => {
    try { remember && apiKey ? localStorage.setItem(LS_KEY, apiKey) : localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }, [apiKey, remember]);

  const promptFileText = prompts.items.filter((p) => p.status === "ready" && p.parsed.kind === "text")
    .map((p) => `# From ${p.name}\n${p.parsed.text}`).join("\n\n");
  const fullInstructions = [promptFileText, promptText].filter((s) => s.trim()).join("\n\n");

  const resolvedFormat = useMemo(() => {
    if (format !== "auto") return format;
    return /\bpdf\b/i.test(fullInstructions) ? "pdf" : "html";
  }, [format, fullInstructions]);

  const readyMaterials = materials.items.filter((m) => m.status === "ready");
  const totalBytes = readyMaterials.reduce((a, m) => a + m.size, 0);
  const anyReading = [...materials.items, ...prompts.items].some((x) => x.status === "reading");
  const fragment = useMemo(() => (raw ? cleanFragment(raw) : ""), [raw]);
  const canRun = apiKey.trim() && readyMaterials.length > 0 && fullInstructions.trim() && !busy && !anyReading;

  async function run() {
    setError(""); setRaw(""); setPreview(""); setBusy(true);
    setStatus("Sending materials to Claude…");
    const content = [];
    for (const m of readyMaterials) content.push(...toBlocks(m.name, m.parsed));
    // Non-text prompt files (e.g. a PDF of the syllabus) are attached as reference.
    for (const p of prompts.items.filter((p) => p.status === "ready" && p.parsed.kind !== "text")) {
      content.push({ type: "text", text: `The next file (${p.name}) contains instructions / exam requirements:` });
      content.push(...toBlocks(p.name, p.parsed));
    }
    content.push({
      type: "text",
      text: `<instructions>\n${fullInstructions}\n</instructions>\n\nUsing ALL the study materials above, produce the exam-prep output described in the instructions. Output format: a single HTML fragment as specified in your system prompt.`,
    });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let started = false;
    try {
      const out = await generate({
        apiKey: apiKey.trim(), model, content, signal: ctrl.signal,
        onStatus: setStatus,
        onText: (t) => {
          if (!started) { started = true; setStatus("Writing…"); }
          setRaw(t);
          const now = Date.now();
          if (now - lastPaint.current > 900) { lastPaint.current = now; setPreview(buildDocument(cleanFragment(t))); }
        },
      });
      const frag = cleanFragment(out);
      setPreview(buildDocument(frag, titleFrom(frag)));
      setStatus("Done.");
      if (resolvedFormat === "pdf") {
        setStatus("Done — preparing PDF download…");
        await downloadPdf(frag);
        setStatus("Done — PDF downloaded.");
      } else {
        downloadHtml(frag);
        setStatus("Done — HTML downloaded.");
      }
    } catch (e) {
      if (e.name === "AbortError") setStatus("Stopped.");
      else { setError(e.message); setStatus(""); }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const wrap = (fn) => async () => { try { setError(""); await fn(fragment); } catch (e) { setError(e.message); } };

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Exam Prep Studio</h1>
          <p className="muted">Drop in your study materials, tell Claude what you need, get notes, questions or a mock exam as HTML or PDF.</p>
        </div>
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
            <p className="muted small">The key is sent only to api.anthropic.com from your browser. It never touches this site's server.</p>
            <label className="lbl">Model</label>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          <DropZone title="2 · Study materials" list={materials} accept={ACCEPT}
            hint="PDF, Word (.docx), PowerPoint (.pptx), images, TXT / MD / CSV — any number" />
          {totalBytes > 25e6 && (
            <p className="warn-text small">Total is {fmtSize(totalBytes)}. Requests over ~32 MB are rejected by the API, so consider splitting into separate runs.</p>
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
          </div>

          <div className="actions">
            {!busy ? (
              <button className="primary" disabled={!canRun} onClick={run}>Generate</button>
            ) : (
              <button className="secondary" onClick={() => abortRef.current?.abort()}>Stop</button>
            )}
            <span className="muted small status">{status}</span>
          </div>
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
