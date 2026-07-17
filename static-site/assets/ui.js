// Shared dropzone / progress / results controller used by every tool page.
// Each page's converter module supplies `convert(file) -> Promise<Blob>` and
// calls initToolPage() with it; everything else (drag & drop, file list,
// progress bar, downloads, zip-all) lives here so it isn't duplicated 5x.

const MAX_FILE_BYTES = 75 * 1024 * 1024; // conversions now run in the browser tab's own memory

export function initToolPage({ tool, convert }) {
  const dropzone       = document.getElementById('dropzone');
  const fileInput      = document.getElementById('fileInput');
  const fileListPanel  = document.getElementById('fileListPanel');
  const fileList       = document.getElementById('fileList');
  const convertBtn     = document.getElementById('convertBtn');
  const clearBtn       = document.getElementById('clearBtn');
  const resultsBox     = document.getElementById('results');
  const resultList     = document.getElementById('resultList');
  const zipWrap        = document.getElementById('zipWrap');
  const errorBanner    = document.getElementById('errorBanner');
  const progressPanel  = document.getElementById('progressPanel');
  const progressIcon   = document.getElementById('progressIcon');
  const progressMessage = document.getElementById('progressMessage');
  const progressFill   = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const dragOverlay    = document.getElementById('dragOverlay');

  const SPIN_RING_HTML = '<div class="progress-spin-ring"></div>';
  const TICK_SVG_HTML = `
    <svg class="tick-svg" viewBox="0 0 52 52">
      <circle class="tick-circle" cx="26" cy="26" r="24"/>
      <path class="tick-check" d="M14 27 L22 35 L39 16"/>
    </svg>`;

  const ALLOWED = tool.input_exts;
  let selectedFiles = [];
  let objectUrls = [];

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // Files can be dropped anywhere on the page, not just inside the dropzone box.
  // A counter (instead of a plain dragenter/dragleave toggle) avoids flicker when
  // the drag moves over child elements, since dragleave fires for those too.
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
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  function addFiles(list) {
    // If the previous batch already finished and results are showing, starting
    // a new selection should feel like a clean slate, not an append.
    const wasEmpty = selectedFiles.length === 0;
    for (const f of list) {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      if (!ALLOWED.includes(ext)) continue;
      const dup = selectedFiles.some(s => s.name === f.name && s.size === f.size);
      if (!dup) selectedFiles.push(f);
    }
    if (wasEmpty && selectedFiles.length > 0) {
      resultsBox.style.display = 'none';
      errorBanner.style.display = 'none';
    }
    renderFileList();
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'file-item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '📄 ' + f.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = humanSize(f.size);
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.onclick = () => { selectedFiles.splice(i, 1); renderFileList(); };
      row.append(name, size, rm);
      fileList.appendChild(row);
    });
    const has = selectedFiles.length > 0;
    fileListPanel.style.display = has ? 'block' : 'none';
    convertBtn.textContent = has
      ? `Convert ${selectedFiles.length} File${selectedFiles.length > 1 ? 's' : ''}`
      : 'Convert All';
  }

  clearBtn.addEventListener('click', () => {
    selectedFiles = [];
    renderFileList();
    resultsBox.style.display = 'none';
    errorBanner.style.display = 'none';
  });

  function updateProgressUI(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressPercent.textContent = `${done} / ${total} files converted (${pct}%)`;
  }

  function revokeObjectUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  convertBtn.addEventListener('click', async () => {
    if (!selectedFiles.length) return;
    errorBanner.style.display = 'none';
    resultsBox.style.display = 'none';
    fileListPanel.style.display = 'none';
    revokeObjectUrls();

    progressIcon.innerHTML = SPIN_RING_HTML;
    progressMessage.textContent = 'Converting your files…';
    progressMessage.classList.remove('done');
    progressFill.classList.remove('done');
    const total = selectedFiles.length;
    updateProgressUI(0, total);
    progressPanel.style.display = 'block';

    const results = [];
    const outputs = []; // { name, blob } for successful conversions, used by the zip button

    for (const file of selectedFiles) {
      const outputName = baseName(file.name) + tool.output_ext;
      if (file.size > MAX_FILE_BYTES) {
        results.push({
          original: file.name, ok: false, output: null,
          error: `File is too large to convert in-browser (max ${humanSize(MAX_FILE_BYTES)})`,
        });
      } else {
        try {
          const blob = await convert(file);
          const uniqueName = uniqueOutputName(outputName, outputs);
          outputs.push({ name: uniqueName, blob });
          results.push({ original: file.name, ok: true, output: uniqueName, error: null });
        } catch (err) {
          console.error(`[convert] ${tool.output_ext} failed on ${file.name}:`, err);
          results.push({ original: file.name, ok: false, output: null, error: mapError(err) });
        }
      }
      updateProgressUI(results.length, total);
      // Yield to the browser so the progress bar actually repaints between files.
      await new Promise(r => setTimeout(r, 0));
    }

    progressIcon.innerHTML = TICK_SVG_HTML;
    progressMessage.textContent = 'All done!';
    progressMessage.classList.add('done');
    progressFill.classList.add('done');
    await new Promise(r => setTimeout(r, 650)); // let the tick animation play

    progressPanel.style.display = 'none';
    showResults(results, outputs);

    // The batch is finished - clear it so picking new files starts fresh
    // instead of appending to files that are already converted.
    selectedFiles = [];
    renderFileList();
  });

  function baseName(filename) {
    const idx = filename.lastIndexOf('.');
    return idx === -1 ? filename : filename.slice(0, idx);
  }

  function uniqueOutputName(name, existingOutputs) {
    const dot = name.lastIndexOf('.');
    const stem = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? '' : name.slice(dot);
    let candidate = name;
    let counter = 1;
    while (existingOutputs.some(o => o.name === candidate)) {
      candidate = `${stem} (${counter})${ext}`;
      counter++;
    }
    return candidate;
  }

  function mapError(err) {
    const message = (err && err.message) || String(err);
    if (/password/i.test(message)) return 'File is password protected';
    return 'Could not convert this file';
  }

  function showResults(results, outputs) {
    resultList.innerHTML = '';
    zipWrap.innerHTML = '';
    let okCount = 0;

    results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'result-item ' + (r.ok ? 'ok' : 'fail');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (r.ok ? '✅ ' : '❌ ') + (r.ok ? r.output : r.original);
      row.appendChild(name);
      if (r.ok) {
        okCount++;
        const output = outputs.find(o => o.name === r.output);
        const url = URL.createObjectURL(output.blob);
        objectUrls.push(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = output.name;
        link.textContent = '⬇ Download';
        row.appendChild(link);
      } else {
        const err = document.createElement('span');
        err.className = 'err';
        err.textContent = r.error || 'Failed';
        row.appendChild(err);
      }
      resultList.appendChild(row);
    });

    if (okCount > 1) {
      const zipBtn = document.createElement('button');
      zipBtn.className = 'btn btn-success';
      zipBtn.textContent = `⬇ Download All ${okCount} Files (ZIP)`;
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
          a.download = 'converted_files.zip';
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

export function showFatalError(message) {
  const errorBanner = document.getElementById('errorBanner');
  errorBanner.textContent = '⚠️ ' + message;
  errorBanner.style.display = 'block';
}
