// Wraps Claude's HTML fragment in a standalone, printable document,
// and handles HTML / PDF export.
import DOMPurify from "dompurify";

export function cleanFragment(raw) {
  let s = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "");
  return DOMPurify.sanitize(s, { ADD_TAGS: ["details", "summary"], FORBID_TAGS: ["script", "style", "iframe"] });
}

export const DOC_CSS = `
:root{--ink:#1d1b26;--muted:#5b5868;--line:#e4e1ea;--accent:#4b3fb5;--soft:#f5f3fb;--tip:#e8f6ef;--tipb:#2f8f62;--warn:#fff4e5;--warnb:#c77700;--key:#eef1ff;--keyb:#4b3fb5}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.65 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.doc{max-width:820px;margin:0 auto;padding:40px 32px 64px}
h1{font-family:Fraunces,Georgia,serif;font-size:2.1rem;line-height:1.2;margin:0 0 .4em;color:var(--accent)}
h2{font-family:Fraunces,Georgia,serif;font-size:1.45rem;margin:1.8em 0 .5em;padding-bottom:.25em;border-bottom:2px solid var(--line)}
h3{font-size:1.1rem;margin:1.4em 0 .4em}
p,li{orphans:3;widows:3}
ul,ol{padding-left:1.4em}
li{margin:.25em 0}
table{width:100%;border-collapse:collapse;margin:1em 0;font-size:.93rem}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--soft)}
blockquote{margin:1em 0;padding:.6em 1em;border-left:4px solid var(--accent);background:var(--soft);border-radius:0 8px 8px 0}
code{background:var(--soft);padding:.1em .35em;border-radius:4px;font-size:.9em}
pre{background:#1d1b26;color:#f2f0f8;padding:14px;border-radius:8px;overflow:auto;font-size:.85rem}
pre code{background:none;padding:0;color:inherit}
.callout{margin:1em 0;padding:.8em 1em;border-radius:8px;border-left:4px solid}
.callout.tip{background:var(--tip);border-color:var(--tipb)}
.callout.warn{background:var(--warn);border-color:var(--warnb)}
.callout.key{background:var(--key);border-color:var(--keyb)}
details{margin:.6em 0;border:1px solid var(--line);border-radius:8px;padding:.6em .9em}
summary{cursor:pointer;font-weight:600}
details[open] summary{margin-bottom:.4em}
.page-break{height:0}
.meta{color:var(--muted);font-size:.85rem;margin-bottom:2em}
@media print{
  .doc{padding:0;max-width:none}
  .page-break{page-break-after:always;break-after:page}
  h2,h3{break-after:avoid}
  table,blockquote,.callout,details,pre{break-inside:avoid}
  details>*{display:block}
}`;

export function buildDocument(fragment, title = "Exam Prep") {
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${DOC_CSS}</style></head>
<body><main class="doc">${fragment}<p class="meta">Generated with Exam Prep Studio · ${date}</p></main></body></html>`;
}

export function titleFrom(fragment) {
  const m = fragment.match(/<h1[^>]*>(.*?)<\/h1>/is);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "Exam Prep";
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "exam-prep";

export function downloadHtml(fragment) {
  const title = titleFrom(fragment);
  const blob = new Blob([buildDocument(fragment, title)], { type: "text/html" });
  triggerDownload(blob, `${slug(title)}.html`);
}

/** Direct PDF download (rendered client-side). Opens <details> so answers appear in the PDF. */
export async function downloadPdf(fragment) {
  const { default: html2pdf } = await import("html2pdf.js");
  const title = titleFrom(fragment);
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "820px";
  host.innerHTML = `<style>${DOC_CSS}</style><main class="doc">${fragment}</main>`;
  host.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
  document.body.appendChild(host);
  try {
    await html2pdf()
      .set({
        margin: [12, 10, 14, 10],
        filename: `${slug(title)}.pdf`,
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], before: ".page-break-before", after: ".page-break", avoid: ["table", "blockquote", ".callout", "details", "pre", "h2", "h3"] },
      })
      .from(host.querySelector(".doc"))
      .save();
  } finally {
    host.remove();
  }
}

/** Print dialog → "Save as PDF" gives a crisp, text-selectable PDF. */
export function printPdf(fragment) {
  const title = titleFrom(fragment);
  const w = window.open("", "_blank");
  if (!w) throw new Error("Pop-up blocked — allow pop-ups to use Print / Save as PDF.");
  const doc = buildDocument(fragment, title).replace(
    "</body>",
    `<script>document.querySelectorAll('details').forEach(d=>d.open=true);document.fonts.ready.then(()=>setTimeout(()=>print(),300));</script></body>`
  );
  w.document.open();
  w.document.write(doc);
  w.document.close();
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
