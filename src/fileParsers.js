// Turns a browser File into one or more Claude content blocks.
// PDFs and images go to Claude natively (it reads layout, tables, diagrams).
// DOCX / PPTX / text formats are converted to plain text in the browser.
import mammoth from "mammoth";
import JSZip from "jszip";

const TEXT_EXT = [
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml",
  "html", "htm", "log", "py", "js", "ts", "java", "c", "cpp", "go", "sh", "sql", "tex",
];
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export const ACCEPT = [
  ".pdf", ".docx", ".pptx", ...Object.keys(IMAGE_TYPES).map((e) => "." + e), ...TEXT_EXT.map((e) => "." + e),
].join(",");

const ext = (name) => name.split(".").pop().toLowerCase();

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function pptxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const out = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f).async("string");
    const paras = xml.split(/<\/a:p>/).map((p) =>
      [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("")
    ).filter(Boolean);
    out.push(`--- Slide ${i + 1} ---\n${paras.join("\n")}`);
  }
  return out.join("\n\n");
}

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Returns { kind: "text"|"pdf"|"image", text?, data?, mediaType?, chars } */
export async function parseFile(file) {
  const e = ext(file.name);
  const buf = await file.arrayBuffer();

  if (e === "pdf") {
    return { kind: "pdf", data: toBase64(buf), mediaType: "application/pdf", size: file.size };
  }
  if (IMAGE_TYPES[e]) {
    return { kind: "image", data: toBase64(buf), mediaType: IMAGE_TYPES[e], size: file.size };
  }
  if (e === "docx") {
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return { kind: "text", text: value, size: file.size };
  }
  if (e === "pptx") {
    const t = decode(await pptxText(buf));
    return { kind: "text", text: t, size: file.size };
  }
  if (TEXT_EXT.includes(e)) {
    return { kind: "text", text: new TextDecoder().decode(buf), size: file.size };
  }
  throw new Error(`Unsupported file type: .${e}`);
}

/** Build Claude content blocks for a parsed material file. */
export function toBlocks(name, parsed) {
  if (parsed.kind === "pdf") {
    return [{
      type: "document",
      source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
      title: name,
    }];
  }
  if (parsed.kind === "image") {
    return [
      { type: "text", text: `Image file: ${name}` },
      { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } },
    ];
  }
  return [{ type: "text", text: `<material name="${name}">\n${parsed.text}\n</material>` }];
}
