# Exam Prep Studio

Upload any number of study materials and an instruction prompt (typed or as files), and Claude generates exam-prep output such as revision notes, practice questions, cheat sheets or a mock exam. Download the result as **HTML** or **PDF**.

- **Inputs:** PDF (read natively by Claude, including tables and diagrams), Word (.docx), PowerPoint (.pptx), images, TXT / MD / CSV / JSON and code files
- **Prompt files:** syllabus, exam blueprint, `prompt.txt` and similar. They combine with the text box.
- **Output format:** HTML, PDF, or *Auto*, which picks PDF if your prompt mentions "PDF"
- **Live preview** streams as Claude writes. Long outputs auto-continue past the token limit.
- **Bring your own key.** The app is fully static. Your Anthropic API (Application Programming Interface) key goes straight from your browser to `api.anthropic.com`. It is never sent to any other server.

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

## Limits

- The API rejects requests larger than about 32 MB, so split very large sets of materials across runs.
- Costs are billed to your own Anthropic account. Haiku is cheapest and Opus is deepest.
