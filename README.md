# PDFSetu

**Setu** (सेतु) is Hindi/Sanskrit for *bridge* — PDFSetu is a free bridge between file formats and a full PDF toolkit: convert, merge, split, rotate, compress, watermark, and more, without ever leaving your device.

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

All 14 tools live at their own route (e.g. `/word-to-pdf/`) and share one page shell (`assets/bootstrap.js` + `assets/tools.js`):

| Tool | Route | What it does |
|---|---|---|
| Word to PDF | `/word-to-pdf/` | `.docx`/`.docm` → PDF |
| PDF to Word | `/pdf-to-word/` | PDF → editable `.docx` |
| PPT to PDF | `/ppt-to-pdf/` | `.pptx`/`.pptm` → PDF, one page per slide |
| PDF to PPT | `/pdf-to-ppt/` | Each PDF page → a full-slide image on its own slide |
| PPT to Excel | `/ppt-to-excel/` | One row per slide (title + content) into `.xlsx` |
| Merge PDF | `/merge-pdf/` | Combine PDFs into one, reorder before merging |
| Split PDF | `/split-pdf/` | Every page as its own PDF, or custom page ranges (e.g. `1-3, 5, 8-10`) |
| Rotate PDF | `/rotate-pdf/` | Rotate every page 90°/180°/270° |
| Compress PDF | `/compress-pdf/` | Shrink file size losslessly (never returns a bigger file) |
| Images to PDF | `/images-to-pdf/` | Combine JPG/PNG photos into one PDF, reorder before combining |
| PDF to JPG | `/pdf-to-jpg/` | Every PDF page → a high-resolution JPG |
| Add Page Numbers | `/page-numbers-pdf/` | Stamp page numbers at a chosen corner and starting count |
| Watermark PDF | `/watermark-pdf/` | Stamp a diagonal text watermark across every page |
| Edit PDF | `/edit-pdf/` | Add text, images, and freehand signatures anywhere on a page - a lightweight Fill & Sign |

A few of these are genuinely uncommon as *free* features elsewhere — reordering files before merging, custom page-range splitting, and unlimited batch conversion are usually paywalled on other "free" converters. They're free here because there's no server cost to gate: your browser does the work.

**A note on Edit PDF specifically:** it adds new content on top of a page (text boxes, images, freehand strokes), it doesn't rewrite a PDF's *existing* text - reliably detecting and reflowing already-laid-out PDF text in-browser isn't realistically achievable, and every other free "PDF editor" that claims to do this is doing the same overlay trick under the hood. It renders each page via pdf.js at a fixed coordinate scale, lets you place/drag/resize elements as normal DOM nodes, then converts those screen coordinates back to PDF points and bakes them into a fresh copy of the original bytes via pdf-lib on save - the rendered pages themselves are only ever a visual guide.

## How the static site works

There's no build step and no backend. Every conversion runs client-side, in the tab, using libraries loaded on demand from a CDN:

- **pdf.js** — reads/rasterizes PDF pages for PDF → Word, PDF → PPT, PDF → JPG, and as the visual guide for Edit PDF
- **pdf-lib** — merge / split / rotate / compress / watermark / page numbers / images → PDF / Edit PDF, and to assemble the PDF for PPT → PDF
- **mammoth.js + pdfmake** — Word → PDF (docx → semantic HTML → PDF)
- **docx** — rebuilds an editable Word document for PDF → Word
- **pptxgenjs** — builds the `.pptx` for PDF → PPT
- **JSZip** — reads `.pptx` XML directly for PPT → Excel and PPT → PDF (no server-side Office available in a browser tab, so each slide's shapes/text/images/theme colors are parsed from the OOXML and, for PPT → PDF, rasterized onto a canvas that becomes one PDF page); also bundles multi-file downloads (split pages, exported JPGs) into one ZIP
- **ExcelJS** — writes the `.xlsx` for PPT → Excel

Because nothing is uploaded, there's no server cost, no upload size limit besides the browser's own memory, and it works on any OS.

Shared UI code lives in `static-site/assets/`:
- `tools.js` — single source of truth for each tool's copy, extensions, format badges, and options (e.g. rotate angle, watermark text)
- `ui.js` — shared dropzone/progress/results controller for the standard 1-in/1-out tools, including per-tool option controls
- `pages/` — custom controllers for tools that aren't 1-in/1-out: Merge and Images-to-PDF (N-in/1-out, with reordering), Split and PDF-to-JPG (1-in/N-out, zipped), and Edit PDF (its own interactive canvas)
- `theme.js` — dark/light toggle (persisted, respects OS preference) and mobile nav
- `pdfjs-loader.js` — pins pdf.js's main build and worker to the same, cross-browser-compatible version

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

No file is ever uploaded to a server. The static site converts entirely inside your browser tab; the legacy app keeps everything on your own PC. No sign-up, no accounts, no tracking of file contents, no daily conversion limits.
