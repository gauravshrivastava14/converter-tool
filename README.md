# PDFSetu

**Setu** (सेतु) is Hindi/Sanskrit for *bridge* — PDFSetu is a free bridge between file formats: PDF, Word, PowerPoint, and Excel, converted back and forth without ever leaving your device.

The project ships two implementations of the same idea, built at different times:

| | [`static-site/`](static-site) (current) | [`app.py`](app.py) (legacy) |
|---|---|---|
| Where it runs | Entirely in the browser | Local Python/Flask server |
| Platform | Any OS, any device | Windows only |
| Dependency | None (just a browser) | Microsoft Word/PowerPoint installed |
| File privacy | Files never leave the tab | Files never leave your PC, but pass through a local server |
| Fidelity | Very good (library-based reconstruction) | Excellent (real Office rendering) |

**`static-site/` is the one to deploy and use day-to-day.** `app.py` is kept around for the rare case where you're on Windows, have Office installed, and want maximum layout fidelity.

## Tools

All 8 tools live at their own route (e.g. `/word-to-pdf/`) and share one page shell (`assets/bootstrap.js` + `assets/tools.js`):

| Tool | Route | What it does |
|---|---|---|
| Word to PDF | `/word-to-pdf/` | `.docx`/`.docm` → PDF |
| PDF to Word | `/pdf-to-word/` | PDF → editable `.docx` |
| PDF to PPT | `/pdf-to-ppt/` | Each PDF page → a full-slide image on its own slide |
| PPT to Excel | `/ppt-to-excel/` | One row per slide (title + content) into `.xlsx` |
| Merge PDF | `/merge-pdf/` | Combine PDFs into one, reorder before merging |
| Split PDF | `/split-pdf/` | Every page as its own PDF, or custom page ranges |
| Rotate PDF | `/rotate-pdf/` | Rotate every page 90°/180°/270° |
| Compress PDF | `/compress-pdf/` | Shrink file size losslessly |

## How the static site works

There's no build step and no backend. Every conversion runs client-side, in the tab, using libraries loaded on demand from a CDN:

- **pdf.js** — reads PDF pages/text for PDF → Word and PDF → PPT
- **pdf-lib** — merge / split / rotate / compress
- **mammoth.js + pdfmake** — Word → PDF (docx → semantic HTML → PDF)
- **docx** — rebuilds an editable Word document for PDF → Word
- **pptxgenjs** — builds the `.pptx` for PDF → PPT
- **JSZip / ExcelJS** — reads `.pptx` XML and writes `.xlsx` for PPT → Excel

Because nothing is uploaded, there's no server cost, no upload size limit besides the browser's own memory, and it works on any OS.

Shared UI code lives in `static-site/assets/`:
- `tools.js` — single source of truth for each tool's copy, extensions, and options
- `ui.js` — shared dropzone/progress/results controller for the standard 1-in/1-out tools
- `pages/` — custom controllers for merge & split (N-in/1-out and 1-in/N-out don't fit the shared flow)
- `theme.js` — dark/light toggle and mobile nav
- `pdfjs-loader.js` — pins pdf.js's main build and worker to the same version

### Running it locally

No install needed — it's static files:

```bash
cd static-site
python -m http.server 8000
# open http://localhost:8000
```

### Deploying

`vercel.json` at the repo root serves `static-site/` as a static site on Vercel — push to the connected branch and Vercel picks it up.

## The legacy desktop app (`app.py`)

A Flask server that drives real Word/PowerPoint via COM automation for pixel-perfect conversions. Windows + Microsoft Office required.

```bash
pip install -r requirements.txt
python app.py    # opens http://127.0.0.1:5000 automatically
```

Or on Windows, just double-click `start.bat`.

## Privacy

No file is ever uploaded to a server. The static site converts entirely inside your browser tab; the legacy app keeps everything on your own PC. No sign-up, no accounts, no tracking of file contents.
