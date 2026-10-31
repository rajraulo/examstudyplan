// File handling designed for very large inputs (hundreds of MB).
// Files are kept as File objects and only read when needed. PDFs are
// split into page ranges on demand, images are downscaled, and text is chunked.
import mammoth from "mammoth";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

const TEXT_EXT = [
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml",
  "html", "htm", "log", "py", "js", "ts", "java", "c", "cpp", "go", "sh", "sql", "tex",
];
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];

export const ACCEPT = [".pdf", ".docx", ".pptx", ...IMAGE_EXT.map((e) => "." + e), ...TEXT_EXT.map((e) => "." + e)].join(",");

const ext = (name) => name.split(".").pop().toLowerCase();

export function toBase64(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function pptxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const out = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f).async("string");
    const paras = xml.split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(""))
      .filter(Boolean);
    out.push(`--- Slide ${i + 1} ---\n${decodeXml(paras.join("\n"))}`);
  }
  return out.join("\n\n");
}

/**
 * Light inspection when a file is added.
 * Returns { kind: "pdf", pages } | { kind: "image" } | { kind: "text", text }.
 * Text formats are extracted now (text is small compared with the source file).
 */
export async function inspectFile(file) {
  const e = ext(file.name);
  if (e === "pdf") {
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    return { kind: "pdf", pages: doc.getPageCount() };
  }
  if (IMAGE_EXT.includes(e)) return { kind: "image" };
  if (e === "docx") {
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { kind: "text", text: value };
  }
  if (e === "pptx") return { kind: "text", text: await pptxText(await file.arrayBuffer()) };
  if (TEXT_EXT.includes(e)) return { kind: "text", text: await file.text() };
  throw new Error(`Unsupported file type: .${e}`);
}

// ---- PDF page-range extraction (one source PDF kept in memory at a time) ----
let pdfCache = { file: null, promise: null };
function loadPdf(file) {
  if (pdfCache.file !== file) {
    pdfCache = {
      file,
      promise: file.arrayBuffer().then((b) => PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false })),
    };
  }
  return pdfCache.promise;
}
export function releasePdfCache() { pdfCache = { file: null, promise: null }; }

/** Pages are 1-based and inclusive. Returns Uint8Array of a new PDF. */
export async function pdfRange(file, from, to) {
  const src = await loadPdf(file);
  const out = await PDFDocument.create();
  const idx = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  const pages = await out.copyPages(src, idx);
  pages.forEach((p) => out.addPage(p));
  return out.save({ useObjectStreams: true });
}

export async function wholeFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

// ---- Images: downscale so each stays well under per-image API limits ----
export async function imageBlock(file, maxSide = 1800) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
}

// ---- Text chunking on paragraph boundaries ----
export function chunkText(text, size) {
  if (text.length <= size) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n\n", end);
      if (cut > i + size * 0.6) end = cut;
      else {
        const nl = text.lastIndexOf("\n", end);
        if (nl > i + size * 0.6) end = nl;
      }
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

export const pdfBlock = (bytes, title) => ({
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) },
  title,
});
