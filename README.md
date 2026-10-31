# Exam Prep Studio

Upload any number of study materials and an instruction prompt (typed or as files), and Claude generates exam-prep output such as revision notes, practice questions, cheat sheets or a mock exam. Download the result as **HTML** or **PDF**.

- **Inputs:** PDF (read natively by Claude, including tables and diagrams), Word (.docx), PowerPoint (.pptx), images, TXT / MD / CSV / JSON and code files
- **Prompt files:** syllabus, exam blueprint, `prompt.txt` and similar. They combine with the text box.
- **Output format:** HTML, PDF, or *Auto*, which picks PDF if your prompt mentions "PDF"
- **Live preview** streams as Claude writes. Long outputs auto-continue past the token limit.
- **Bring your own key.** The app is fully static. Your Anthropic API (Application Programming Interface) key goes straight from your browser to `api.anthropic.com`. It is never sent to any other server.

## Large inputs (500 MB+, 1,000+ page PDFs)

A single API request is limited to 128 MB, at most 600 PDF pages, and the model's context window. For anything larger, the app switches automatically to a three-step pipeline:

1. **Read.** It splits the materials into sections: PDFs into page ranges sized by bytes per page, text into about 240k-character parts, and images into groups of 20. Claude extracts complete notes from each section in parallel. If the API rejects a section as too large, that section is halved and retried automatically.
2. **Condense.** The notes are merged and de-duplicated, in rounds if needed, until they fit comfortably in one request.
3. **Write.** Your chosen model writes the final output from the condensed notes.

Other behaviour:

- Rate-limit (429) and overload (529) errors are retried with backoff.
- Completed sections are kept in memory. After a failure or a stop, **Generate** resumes from where it left off.
- You can change the instructions and generate again without re-reading the materials.
- A cheaper **reading model** (Haiku by default) and the number of **parallel requests** are both configurable.

All of this runs in the browser, so no upload limits apply. Vercel serverless functions would cap uploads at about 4.5 MB, which is why the app has no backend. Tested with 519 MB of input (1,405 PDF pages, including a single 1,200-page PDF).

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
```

## Deploy free on Vercel

1. Go to https://vercel.com/new and import this GitHub repository.
2. Vercel auto-detects **Vite**. Keep the defaults (build: `npm run build`, output: `dist`).
3. Click **Deploy**. Every push to `main` redeploys automatically.

Alternatives: Netlify, Cloudflare Pages or GitHub Pages also work. Use the same build command with `dist` as the output folder.

## PDF options

- **PDF** button: a one-click download rendered in the browser (image-based pages).
- **Print / Save as PDF** button: opens the print dialog. Choose *Save as PDF* for a crisp, text-searchable PDF.

Collapsible answers (`<details>`) are expanded automatically in both PDF modes.

## Cost and time

- Costs are billed to your own Anthropic account. The plan card shows estimated input tokens before you start. Haiku is cheapest and Opus is deepest.
- PDF pages are read as text plus an image, at roughly 1,500–3,000 tokens of text per page plus the image cost. For example, 1,000 pages is roughly 2.5M input tokens in the reading step.
- New API accounts have low per-minute token limits. If you see repeated rate-limit retries, set parallel requests to 1–2. The run will be slower but won't fail.
