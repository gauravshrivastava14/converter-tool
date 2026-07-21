// PDF -> JPG: rasterizes each page to a high-resolution JPG image using
// pdf.js (same loader/zoom level already used by the PDF -> PPT converter).
// One PDF in, one JPG per page out, so this drives the shared panels
// directly instead of the standard 1-in/1-out initToolPage() flow.
import { loadPdfjs, isPasswordError } from '../pdfjs-loader.js';

const ZOOM = 150 / 72; // 150 DPI

export function init() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  fileInput.removeAttribute('multiple');

  const fileListPanel = document.getElementById('fileListPanel');
  const fileList = document.getElementById('fileList');
  const convertBtn = document.getElementById('convertBtn');
  const clearBtn = document.getElementById('clearBtn');
  const resultsBox = document.getElementById('results');
  const resultList = document.getElementById('resultList');
  const zipWrap = document.getElementById('zipWrap');
  const errorBanner = document.getElementById('errorBanner');
  const progressPanel = document.getElementById('progressPanel');
  const progressIcon = document.getElementById('progressIcon');
  const progressMessage = document.getElementById('progressMessage');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const dragOverlay = document.getElementById('dragOverlay');

  const SPIN_RING_HTML = '<div class="progress-spin-ring"></div>';
  const TICK_SVG_HTML = `
    <svg class="tick-svg" viewBox="0 0 52 52">
      <circle class="tick-circle" cx="26" cy="26" r="24"/>
      <path class="tick-check" d="M14 27 L22 35 L39 16"/>
    </svg>`;

  let file = null;
  let objectUrls = [];

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { setFile(fileInput.files[0]); fileInput.value = ''; });

  let dragCounter = 0;
  window.addEventListener('dragenter', e => {
    e.preventDefault();
    dragCounter++;
    dragOverlay.classList.add('active');
    dropzone.classList.add('dragover');
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => {
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      dragOverlay.classList.remove('active');
      dropzone.classList.remove('dragover');
    }
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) setFile(e.dataTransfer.files[0]);
  });

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function setFile(f) {
    if (!f || !f.name.toLowerCase().endsWith('.pdf')) return;
    file = f;
    resultsBox.style.display = 'none';
    errorBanner.style.display = 'none';
    render();
  }

  function render() {
    fileList.innerHTML = '';
    if (file) {
      const row = document.createElement('div');
      row.className = 'file-item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '📄 ' + file.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = humanSize(file.size);
      const rm = document.createElement('button');
      rm.className = 'remove'; rm.textContent = '✕'; rm.title = 'Remove';
      rm.onclick = () => { file = null; render(); };
      row.append(name, size, rm);
      fileList.appendChild(row);
    }
    fileListPanel.style.display = file ? 'block' : 'none';
    convertBtn.textContent = 'Convert to JPG';
  }

  clearBtn.addEventListener('click', () => {
    file = null;
    render();
    resultsBox.style.display = 'none';
    errorBanner.style.display = 'none';
  });

  function revokeObjectUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  function baseName(filename) {
    const idx = filename.lastIndexOf('.');
    return idx === -1 ? filename : filename.slice(0, idx);
  }

  convertBtn.addEventListener('click', async () => {
    if (!file) return;
    errorBanner.style.display = 'none';
    resultsBox.style.display = 'none';
    fileListPanel.style.display = 'none';
    revokeObjectUrls();

    progressIcon.innerHTML = SPIN_RING_HTML;
    progressMessage.textContent = 'Exporting pages…';
    progressMessage.classList.remove('done');
    progressFill.classList.remove('done');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressPanel.style.display = 'block';

    let loadingTask;
    try {
      const pdfjsLib = await loadPdfjs();
      const arrayBuffer = await file.arrayBuffer();
      loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      let pdfDoc;
      try {
        pdfDoc = await loadingTask.promise;
      } catch (err) {
        throw new Error(isPasswordError(err) ? 'This PDF is password protected' : "This PDF couldn't be read (it may be corrupted)");
      }

      const outputs = [];
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: ZOOM });

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        canvas.width = 0;
        canvas.height = 0;

        outputs.push({ name: `${baseName(file.name)}-page-${pageNum}.jpg`, blob });

        const pct = Math.round((pageNum / pdfDoc.numPages) * 100);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = `${pageNum} / ${pdfDoc.numPages} pages exported (${pct}%)`;
        await new Promise(r => setTimeout(r, 0));
      }

      progressIcon.innerHTML = TICK_SVG_HTML;
      progressMessage.textContent = 'All done!';
      progressMessage.classList.add('done');
      progressFill.classList.add('done');
      await new Promise(r => setTimeout(r, 650));
      progressPanel.style.display = 'none';

      showResults(outputs);
      file = null;
      render();
    } catch (err) {
      console.error('[pdf-to-jpg] failed:', err);
      progressPanel.style.display = 'none';
      errorBanner.textContent = '⚠️ ' + (err.message || 'Could not export this PDF');
      errorBanner.style.display = 'block';
      render();
    } finally {
      loadingTask?.destroy();
    }
  });

  function showResults(outputs) {
    resultList.innerHTML = '';
    zipWrap.innerHTML = '';

    outputs.forEach(o => {
      const row = document.createElement('div');
      row.className = 'result-item ok';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '✅ ' + o.name;
      const url = URL.createObjectURL(o.blob);
      objectUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = o.name;
      link.textContent = '⬇ Download';
      row.append(name, link);
      resultList.appendChild(row);
    });

    if (outputs.length > 1) {
      const zipBtn = document.createElement('button');
      zipBtn.className = 'btn btn-success';
      zipBtn.textContent = `⬇ Download All ${outputs.length} Images (ZIP)`;
      zipBtn.onclick = async () => {
        zipBtn.disabled = true;
        const originalText = zipBtn.textContent;
        zipBtn.innerHTML = '<span class="spinner"></span>Zipping…';
        try {
          const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
          const zip = new JSZip();
          outputs.forEach(o => zip.file(o.name, o.blob));
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          const url = URL.createObjectURL(zipBlob);
          objectUrls.push(url);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'pdf_pages.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          zipBtn.disabled = false;
          zipBtn.textContent = originalText;
        }
      };
      zipWrap.appendChild(zipBtn);
    }
    resultsBox.style.display = 'block';
  }
}
