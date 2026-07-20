// Split PDF - takes exactly one PDF and produces either one file per page,
// or one file per custom page range (e.g. "1-3, 5, 8-10"). Free range-based
// splitting like this is usually a paid feature elsewhere; here it's just
// pdf-lib running locally, so there's no reason to gate it.

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
  const rangeInput = document.getElementById('splitRanges');
  const modeRadios = Array.from(document.querySelectorAll('input[name="splitMode"]'));

  const SPIN_RING_HTML = '<div class="progress-spin-ring"></div>';
  const TICK_SVG_HTML = `
    <svg class="tick-svg" viewBox="0 0 52 52">
      <circle class="tick-circle" cx="26" cy="26" r="24"/>
      <path class="tick-check" d="M14 27 L22 35 L39 16"/>
    </svg>`;

  let file = null;
  let objectUrls = [];

  modeRadios.forEach(r => r.addEventListener('change', () => {
    if (rangeInput) rangeInput.disabled = document.querySelector('input[name="splitMode"]:checked').value !== 'custom';
  }));

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
    convertBtn.textContent = 'Split PDF';
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

  function parseRanges(input, pageCount) {
    const parts = input.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('Enter at least one page or range, e.g. 1-3, 5');
    const ranges = [];
    for (const part of parts) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`"${part}" isn't a valid page or range`);
      let start = parseInt(m[1], 10);
      let end = m[2] ? parseInt(m[2], 10) : start;
      if (start > end) [start, end] = [end, start];
      if (start < 1 || end > pageCount) throw new Error(`"${part}" is out of range - this PDF has ${pageCount} pages`);
      ranges.push({ start, end });
    }
    return ranges;
  }

  convertBtn.addEventListener('click', async () => {
    if (!file) return;
    errorBanner.style.display = 'none';

    const mode = document.querySelector('input[name="splitMode"]:checked')?.value || 'all';

    resultsBox.style.display = 'none';
    fileListPanel.style.display = 'none';
    revokeObjectUrls();

    progressIcon.innerHTML = SPIN_RING_HTML;
    progressMessage.textContent = 'Splitting your PDF…';
    progressMessage.classList.remove('done');
    progressFill.classList.remove('done');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressPanel.style.display = 'block';

    try {
      const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1');
      const bytes = await file.arrayBuffer();
      let src;
      try {
        src = await PDFDocument.load(bytes);
      } catch (err) {
        const reason = /encrypt/i.test(err?.message || '') ? 'This PDF is password protected' : "This PDF couldn't be read (it may be corrupted)";
        throw new Error(reason);
      }
      const pageCount = src.getPageCount();

      let ranges;
      if (mode === 'custom') {
        ranges = parseRanges(rangeInput?.value || '', pageCount);
      } else {
        ranges = Array.from({ length: pageCount }, (_, i) => ({ start: i + 1, end: i + 1 }));
      }

      const outputs = [];
      for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i];
        const indices = [];
        for (let p = start; p <= end; p++) indices.push(p - 1);

        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, indices);
        pages.forEach(p => out.addPage(p));
        const bytesOut = await out.save();

        const label = start === end ? `page-${start}` : `pages-${start}-${end}`;
        outputs.push({ name: `${baseName(file.name)}-${label}.pdf`, blob: new Blob([bytesOut], { type: 'application/pdf' }) });

        const pct = Math.round(((i + 1) / ranges.length) * 100);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = `${i + 1} / ${ranges.length} files created (${pct}%)`;
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
      console.error('[split-pdf] failed:', err);
      progressPanel.style.display = 'none';
      errorBanner.textContent = '⚠️ ' + (err.message || 'Could not split this PDF');
      errorBanner.style.display = 'block';
      render();
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
      zipBtn.textContent = `⬇ Download All ${outputs.length} Files (ZIP)`;
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
          a.download = 'split_pages.zip';
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
