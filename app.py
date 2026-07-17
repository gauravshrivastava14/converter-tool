"""
PDFSetu - a small local office-file converter suite.

Tools: Word <-> PDF, PPT -> PDF, PDF -> PPT, PPT -> Excel.
Uses Microsoft Word / PowerPoint (COM automation) for fidelity, plus
PyMuPDF + python-pptx for the PDF -> PPT page-image conversion (PowerPoint
itself has no native "import PDF" feature, unlike Word).

Run:  python app.py   then open http://127.0.0.1:5000
"""

import contextlib
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path

import pythoncom
import win32com.client
from flask import Flask, abort, jsonify, render_template, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB per request

JOBS_ROOT = Path(tempfile.gettempdir()) / "word2pdf_jobs"
JOBS_ROOT.mkdir(exist_ok=True)

JOB_MAX_AGE_SECONDS = 2 * 60 * 60  # jobs are deleted after 2 hours
PER_FILE_TIMEOUT_SECONDS = 120       # a single stuck file can't hang the whole batch
MAX_OFFICE_WORKERS = min(4, os.cpu_count() or 2)  # parallel Office instances

WD_FORMAT_PDF = 17
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3  # never show macro/security dialogs
PP_SAVE_AS_PDF = 32

ILLEGAL_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

TOOLS = {
    "word-to-pdf": {
        "label": "Word to PDF",
        "hero_title": "Word to PDF",
        "tagline": "Select multiple Word documents and convert them all to PDF in one go "
                   "&mdash; fast, free, and 100% offline. Your files never leave this PC.",
        "input_exts": [".doc", ".docx", ".docm", ".dot", ".dotx", ".rtf", ".odt"],
        "output_ext": ".pdf",
        "button_label": "Select Word Files",
        "drop_hint": "or drop .doc / .docx / .docm / .rtf / .odt files here &mdash; multiple allowed",
    },
    "pdf-to-word": {
        "label": "PDF to Word",
        "hero_title": "PDF to Word",
        "tagline": "Extracts the text from each page and rebuilds it as an editable Word "
                   "document &mdash; convert as many at once as you like, 100% offline.",
        "input_exts": [".pdf"],
        "output_ext": ".docx",
        "button_label": "Select PDF Files",
        "drop_hint": "or drop .pdf files here &mdash; multiple allowed",
    },
    "ppt-to-pdf": {
        "label": "PPT to PDF",
        "hero_title": "PPT to PDF",
        "tagline": "Convert PowerPoint presentations to PDF in one go &mdash; fast, free, "
                   "and 100% offline.",
        "input_exts": [".ppt", ".pptx", ".pptm"],
        "output_ext": ".pdf",
        "button_label": "Select PPT Files",
        "drop_hint": "or drop .ppt / .pptx / .pptm files here &mdash; multiple allowed",
    },
    "pdf-to-ppt": {
        "label": "PDF to PPT",
        "hero_title": "PDF to PPT",
        "tagline": "Turn each PDF page into a PowerPoint slide &mdash; every page is placed as "
                   "a full-slide image, so the layout matches the PDF exactly.",
        "input_exts": [".pdf"],
        "output_ext": ".pptx",
        "button_label": "Select PDF Files",
        "drop_hint": "or drop .pdf files here &mdash; multiple allowed",
    },
    "ppt-to-excel": {
        "label": "PPT to Excel",
        "hero_title": "PPT to Excel",
        "tagline": "Extract the text from every slide into an Excel sheet &mdash; one row per "
                   "slide, with its title and content in separate columns.",
        "input_exts": [".ppt", ".pptx", ".pptm"],
        "output_ext": ".xlsx",
        "button_label": "Select PPT Files",
        "drop_hint": "or drop .ppt / .pptx / .pptm files here &mdash; multiple allowed",
    },
}
TOOL_SLUGS = ",".join(f'"{slug}"' for slug in TOOLS.keys())
DEFAULT_TOOL = "word-to-pdf"

# Bounds how many Office.exe instances run at once, across all requests.
office_executor = ThreadPoolExecutor(max_workers=MAX_OFFICE_WORKERS, thread_name_prefix="office-worker")

# In-memory progress tracking so the frontend can poll for a live percentage.
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

_spawn_lock = threading.Lock()


def sanitize_filename(name: str) -> str:
    """Keep Unicode (Hindi etc.) filenames but strip path separators and
    characters Windows does not allow."""
    name = Path(name).name  # drop any client-side directory part
    name = ILLEGAL_CHARS.sub("_", name).strip(" .")
    return name or "document"


def unique_path(directory: Path, filename: str) -> Path:
    """Avoid collisions when two uploads share a name."""
    candidate = directory / filename
    stem, suffix = candidate.stem, candidate.suffix
    counter = 1
    while candidate.exists():
        candidate = directory / f"{stem} ({counter}){suffix}"
        counter += 1
    return candidate


def cleanup_old_jobs() -> None:
    now = time.time()
    for job_dir in JOBS_ROOT.iterdir():
        try:
            if job_dir.is_dir() and now - job_dir.stat().st_mtime > JOB_MAX_AGE_SECONDS:
                shutil.rmtree(job_dir, ignore_errors=True)
                with jobs_lock:
                    jobs.pop(job_dir.name, None)
        except OSError:
            pass


def list_office_pids(image_name: str) -> set:
    """PIDs of every currently running process with the given image name."""
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
            creationflags=subprocess.CREATE_NO_WINDOW,
            stderr=subprocess.DEVNULL,
        ).decode(errors="ignore")
    except subprocess.CalledProcessError:
        return set()
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.strip().split('","')]
        if len(parts) >= 2 and parts[0].upper() == image_name.upper():
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
    return pids


def kill_pid(pid: int) -> None:
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            creationflags=subprocess.CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


@contextlib.contextmanager
def spawned_office_app(prog_id: str, image_name: str):
    """Spawns an invisible Office COM app, yields it, and guarantees it is
    fully gone afterwards - Quit() first, then a force-kill on its specific
    PID if it didn't exit on its own (e.g. a stuck dialog)."""
    pythoncom.CoInitialize()
    app = None
    pid = None
    try:
        with _spawn_lock:
            before = list_office_pids(image_name)
            app = win32com.client.DispatchEx(prog_id)
            after = list_office_pids(image_name)
        new_pids = after - before
        if len(new_pids) == 1:
            pid = new_pids.pop()
        yield app
    finally:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        if pid is not None:
            time.sleep(0.3)
            if pid in list_office_pids(image_name):
                kill_pid(pid)
        pythoncom.CoUninitialize()


def _configure_word(word) -> None:
    word.Visible = False
    word.DisplayAlerts = 0
    # Prevents Word from ever popping the macro/security-warning modal,
    # which would otherwise freeze this thread (and the whole request) forever.
    word.AutomationSecurity = MSO_AUTOMATION_SECURITY_FORCE_DISABLE
    try:
        word.Options.ConfirmConversions = False
    except Exception:
        pass


def convert_word_to_pdf(src: Path, dest: Path) -> None:
    with spawned_office_app("Word.Application", "WINWORD.EXE") as word:
        _configure_word(word)
        doc = word.Documents.Open(
            str(src), ReadOnly=True, AddToRecentFiles=False,
            # a wrong password makes protected files fail fast instead of
            # popping a dialog that would hang the server
            PasswordDocument="~~not-the-password~~",
        )
        try:
            doc.SaveAs(str(dest), FileFormat=WD_FORMAT_PDF)
        finally:
            doc.Close(SaveChanges=False)


def convert_pdf_to_word(src: Path, dest: Path) -> None:
    """Extracts text from the PDF and rebuilds it as an editable Word
    document. Word does have a built-in "open a PDF" reflow feature, but
    driving it via COM automation is unreliable in practice: it shows an
    internal progress/conversion dialog that has no visible window to
    dismiss it when Visible=False, so it can hang indefinitely instead of
    erroring - confirmed by testing here, where it hung until force-killed
    by the per-file timeout. Extracting text with PyMuPDF and rebuilding the
    document with python-docx avoids Office automation for this direction
    entirely, trading exact layout fidelity for reliability."""
    import fitz
    from docx import Document

    pdf = fitz.open(str(src))
    try:
        if pdf.page_count == 0:
            raise ValueError("PDF has no pages")
        document = Document()
        for page_index, page in enumerate(pdf):
            blocks = sorted(page.get_text("blocks"), key=lambda b: (round(b[1], 1), round(b[0], 1)))
            for block in blocks:
                # Lines within one text block are usually a single wrapped
                # paragraph, so they're joined back into one flowing line.
                paragraph_text = " ".join(
                    line.strip() for line in block[4].split("\n") if line.strip()
                )
                if paragraph_text:
                    document.add_paragraph(paragraph_text)
            if page_index < pdf.page_count - 1:
                document.add_page_break()
        document.save(str(dest))
    finally:
        pdf.close()


def convert_ppt_to_pdf(src: Path, dest: Path) -> None:
    with spawned_office_app("PowerPoint.Application", "POWERPNT.EXE") as ppt:
        try:
            ppt.DisplayAlerts = 0
        except Exception:
            pass
        pres = ppt.Presentations.Open(str(src), ReadOnly=True, Untitled=False, WithWindow=False)
        try:
            # ExportAsFixedFormat has ~16 positional parameters, several of
            # them object-typed - win32com's dynamic dispatch fails to
            # marshal that call ("The Python instance can not be converted
            # to a COM object") regardless of how many are supplied. The
            # plain two-argument SaveAs works reliably instead.
            pres.SaveAs(str(dest), PP_SAVE_AS_PDF)
        finally:
            pres.Close()


def convert_pdf_to_ppt(src: Path, dest: Path) -> None:
    """PowerPoint has no native PDF import, so each PDF page is rendered to a
    high-resolution image and placed as a full-bleed picture on its own slide -
    the result looks exactly like the PDF, though slide text isn't editable."""
    import fitz
    from pptx import Presentation
    from pptx.util import Emu

    pdf = fitz.open(str(src))
    try:
        if pdf.page_count == 0:
            raise ValueError("PDF has no pages")

        zoom = 150 / 72.0  # render at 150 DPI
        matrix = fitz.Matrix(zoom, zoom)
        first_rect = pdf[0].rect

        prs = Presentation()
        prs.slide_width = Emu(int(first_rect.width / 72 * 914400))
        prs.slide_height = Emu(int(first_rect.height / 72 * 914400))
        blank_layout = prs.slide_layouts[6]

        for page in pdf:
            pix = page.get_pixmap(matrix=matrix)
            img_stream = io.BytesIO(pix.tobytes("png"))
            slide = prs.slides.add_slide(blank_layout)
            slide.shapes.add_picture(
                img_stream, 0, 0, width=prs.slide_width, height=prs.slide_height
            )
        prs.save(str(dest))
    finally:
        pdf.close()


def convert_ppt_to_excel(src: Path, dest: Path) -> None:
    """One row per slide: slide number, title, and the rest of its text."""
    from openpyxl import Workbook
    from openpyxl.styles import Font

    rows = []
    with spawned_office_app("PowerPoint.Application", "POWERPNT.EXE") as ppt:
        try:
            ppt.DisplayAlerts = 0
        except Exception:
            pass
        pres = ppt.Presentations.Open(str(src), ReadOnly=True, Untitled=False, WithWindow=False)
        try:
            for i, slide in enumerate(pres.Slides, start=1):
                title = ""
                try:
                    if slide.Shapes.HasTitle:
                        # PowerPoint's TextRange.Text uses \r for line breaks
                        # internally, which Excel won't render - normalize to \n.
                        title = (slide.Shapes.Title.TextFrame.TextRange.Text or "").replace("\r", "\n").strip()
                except Exception:
                    pass
                texts = []
                for shape in slide.Shapes:
                    try:
                        if shape.HasTextFrame and shape.TextFrame.HasText:
                            text = (shape.TextFrame.TextRange.Text or "").replace("\r", "\n").strip()
                            if text and text != title:
                                texts.append(text)
                    except Exception:
                        continue
                rows.append((i, title, "\n".join(texts)))
        finally:
            pres.Close()

    wb = Workbook()
    ws = wb.active
    ws.title = "Slides"
    ws.append(["Slide Number", "Title", "Content"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    ws.column_dimensions["A"].width = 14
    ws.column_dimensions["B"].width = 40
    ws.column_dimensions["C"].width = 80
    for row_cells in ws.iter_rows(min_row=2):
        for cell in row_cells:
            cell.alignment = cell.alignment.copy(wrap_text=True, vertical="top")
    wb.save(str(dest))


TOOL_CONVERTERS = {
    "word-to-pdf": convert_word_to_pdf,
    "pdf-to-word": convert_pdf_to_word,
    "ppt-to-pdf": convert_ppt_to_pdf,
    "pdf-to-ppt": convert_pdf_to_ppt,
    "ppt-to-excel": convert_ppt_to_excel,
}


def convert_one_file(tool_id: str, src: Path, output_dir: Path) -> dict:
    """Runs in a worker thread. Never lets an exception escape - always
    returns a result dict."""
    entry = {"original": src.name, "ok": False, "output": None, "error": None}
    dest_path = unique_path(output_dir, src.stem + TOOLS[tool_id]["output_ext"])
    try:
        TOOL_CONVERTERS[tool_id](src, dest_path)
        entry["ok"] = True
        entry["output"] = dest_path.name
    except Exception as exc:
        message = str(exc)
        print(f"[convert_one_file] {tool_id} failed on {src.name}: {exc!r}")
        if "password" in message.lower():
            entry["error"] = "File is password protected"
        else:
            entry["error"] = "Could not convert this file"
    return entry


def run_conversion_job(job_id: str, tool_id: str, input_paths: list[Path],
                        input_dir: Path, output_dir: Path) -> None:
    """Runs in a background thread. Converts every file in parallel, each
    isolated in its own Office instance, updating jobs[job_id] after every
    file so /status can report a live percentage. A single hung/crashed file
    can never block the others - it is force-killed after PER_FILE_TIMEOUT_SECONDS."""
    futures = {
        office_executor.submit(convert_one_file, tool_id, src, output_dir): src
        for src in input_paths
    }
    for future, src in futures.items():
        try:
            result = future.result(timeout=PER_FILE_TIMEOUT_SECONDS)
        except FutureTimeoutError:
            result = {
                "original": src.name, "ok": False, "output": None,
                "error": "Conversion timed out (file may be too complex or corrupted)",
            }
        except Exception:
            result = {
                "original": src.name, "ok": False, "output": None,
                "error": "Unexpected error while converting this file",
            }
        with jobs_lock:
            jobs[job_id]["results"].append(result)
            jobs[job_id]["done"] += 1

    shutil.rmtree(input_dir, ignore_errors=True)  # originals are no longer needed
    with jobs_lock:
        jobs[job_id]["status"] = "complete"


def job_dir_or_404(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        abort(404)
    job_dir = JOBS_ROOT / job_id / "output"
    if not job_dir.is_dir():
        abort(404)
    return job_dir


@app.errorhandler(Exception)
def handle_any_error(exc):
    """Guarantees the client always gets JSON back, never an HTML error
    page - an HTML response is what breaks res.json() in the browser."""
    from werkzeug.exceptions import HTTPException
    if isinstance(exc, HTTPException):
        return jsonify({"error": exc.description or str(exc)}), exc.code
    traceback.print_exc()
    return jsonify({"error": f"Server error: {exc}"}), 500


@app.get("/")
def index():
    return render_template("index.html", tool_id=DEFAULT_TOOL, tool=TOOLS[DEFAULT_TOOL], tools=TOOLS)


@app.get(f"/<any({TOOL_SLUGS}):tool_id>")
def tool_page(tool_id):
    return render_template("index.html", tool_id=tool_id, tool=TOOLS[tool_id], tools=TOOLS)


@app.post(f"/convert/<any({TOOL_SLUGS}):tool_id>")
def convert(tool_id):
    files = request.files.getlist("files")
    if not files or all(not f.filename for f in files):
        return jsonify({"error": "No files were uploaded"}), 400

    cleanup_old_jobs()
    allowed_exts = set(TOOLS[tool_id]["input_exts"])

    job_id = uuid.uuid4().hex
    job_dir = JOBS_ROOT / job_id
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)

    saved, rejected = [], []
    try:
        for f in files:
            if not f.filename:
                continue
            name = sanitize_filename(f.filename)
            if Path(name).suffix.lower() not in allowed_exts:
                rejected.append({"original": name, "ok": False, "output": None,
                                 "error": "Unsupported file type for this tool"})
                continue
            dest = unique_path(input_dir, name)
            f.save(dest)
            saved.append(dest)

        if not saved:
            shutil.rmtree(job_dir, ignore_errors=True)
            return jsonify({"error": "No supported files found for this tool."}), 400
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        traceback.print_exc()
        return jsonify({"error": f"Upload failed: {exc}"}), 500

    total = len(saved) + len(rejected)
    with jobs_lock:
        jobs[job_id] = {
            "total": total,
            "done": len(rejected),
            "results": list(rejected),
            "status": "processing",
        }

    threading.Thread(
        target=run_conversion_job, args=(job_id, tool_id, saved, input_dir, output_dir), daemon=True
    ).start()

    return jsonify({"job_id": job_id, "total": total})


@app.get("/status/<job_id>")
def status(job_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        abort(404)
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            abort(404)
        return jsonify({
            "total": job["total"],
            "done": job["done"],
            "status": job["status"],
            "results": list(job["results"]),
        })


@app.get("/download/<job_id>/<path:filename>")
def download_one(job_id: str, filename: str):
    output_dir = job_dir_or_404(job_id)
    file_path = (output_dir / Path(filename).name).resolve()
    if file_path.parent != output_dir.resolve() or not file_path.is_file():
        abort(404)
    return send_file(file_path, as_attachment=True, download_name=file_path.name)


@app.get("/download-zip/<job_id>")
def download_zip(job_id: str):
    output_dir = job_dir_or_404(job_id)
    outputs = sorted(p for p in output_dir.iterdir() if p.is_file())
    if not outputs:
        abort(404)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in outputs:
            zf.write(f, arcname=f.name)
    buffer.seek(0)
    return send_file(buffer, as_attachment=True, download_name="converted_files.zip",
                     mimetype="application/zip")


if __name__ == "__main__":
    threading.Timer(1.5, lambda: webbrowser.open("http://127.0.0.1:5000")).start()
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
