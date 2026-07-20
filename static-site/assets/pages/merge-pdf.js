// Merge PDF - combines every selected PDF, in the order shown, into one
// file. Unlike the other tools this is N files -> 1 output, so it doesn't
// fit the shared initToolPage() batch flow; it drives the same panels
// directly. The reorder buttons (move files up/down before merging) are a
// deliberate step up from most free mergers, which only merge in upload
// order.

export function init() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
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

  let files = [];
  let objectUrls = [];

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

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
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  function addFiles(list) {
    const wasEmpty = files.length === 0;
    for (const f of list) {
      if (!f.name.toLowerCase().endsWith('.pdf')) continue;
      const dup = files.some(s => s.name === f.name && s.size === f.size);
      if (!dup) files.push(f);
    }
    if (wasEmpty && files.length > 0) {
      resultsBox.style.display = 'none';
      errorBanner.style.display = 'none';
    }
    render();
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function render() {
    fileList.innerHTML = '';
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'file-item';

      const badge = document.createElement('span');
      badge.className = 'order-badge';
      badge.textContent = i + 1;

      const order = document.createElement('div');
      order.className = 'reorder';
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'reorder-btn'; up.textContent = '▲'; up.title = 'Move up';
      up.disabled = i === 0;
      up.onclick = () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; render(); };
      const down = document.createElement('button');
      down.type = 'button'; down.className = 'reorder-btn'; down.textContent = '▼'; down.title = 'Move down';
      down.disabled = i === files.length - 1;
      down.onclick = () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; render(); };
      order.append(up, down);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '📄 ' + f.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = humanSize(f.size);
      const rm = document.createElement('button');
      rm.className = 'remove'; rm.textContent = '✕'; rm.title = 'Remove';
      rm.onclick = () => { files.splice(i, 1); render(); };

      row.append(badge, order, name, size, rm);
      fileList.appendChild(row);
    });
    const has = files.length > 0;
    fileListPanel.style.display = has ? 'block' : 'none';
    convertBtn.disabled = files.length < 2;
    convertBtn.textContent = files.length >= 2
      ? `Merge ${files.length} Files into One PDF`
      : 'Add at least 2 PDFs to merge';
  }

  clearBtn.addEventListener('click', () => {
    files = [];
    render();
    resultsBox.style.display = 'none';
    errorBanner.style.display = 'none';
  });

  function revokeObjectUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  convertBtn.addEventListener('click', async () => {
    if (files.length < 2) return;
    errorBanner.style.display = 'none';
    resultsBox.style.display = 'none';
    fileListPanel.style.display = 'none';
    revokeObjectUrls();

    progressIcon.innerHTML = SPIN_RING_HTML;
    progressMessage.textContent = 'Merging your files…';
    progressMessage.classList.remove('done');
    progressFill.classList.remove('done');
    progressFill.style.width = '0%';
    progressPercent.textContent = `0 / ${files.length} files merged (0%)`;
    progressPanel.style.display = 'block';

    try {
      const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1');
      const merged = await PDFDocument.create();

      for (let i = 0; i < files.length; i++) {
        const bytes = await files[i].arrayBuffer();
        let src;
        try {
          src = await PDFDocument.load(bytes);
        } catch (err) {
          const reason = /encrypt/i.test(err?.message || '') ? 'is password protected' : "couldn't be read (it may be corrupted)";
          throw new Error(`"${files[i].name}" ${reason}`);
        }
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));

        const pct = Math.round(((i + 1) / files.length) * 100);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = `${i + 1} / ${files.length} files merged (${pct}%)`;
        await new Promise(r => setTimeout(r, 0));
      }

      const out = await merged.save();
      const blob = new Blob([out], { type: 'application/pdf' });

      progressIcon.innerHTML = TICK_SVG_HTML;
      progressMessage.textContent = 'All done!';
      progressMessage.classList.add('done');
      progressFill.classList.add('done');
      await new Promise(r => setTimeout(r, 650));
      progressPanel.style.display = 'none';

      resultList.innerHTML = '';
      zipWrap.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'result-item ok';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '✅ merged.pdf';
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'merged.pdf';
      link.textContent = '⬇ Download';
      row.append(name, link);
      resultList.appendChild(row);
      resultsBox.style.display = 'block';

      files = [];
      render();
    } catch (err) {
      console.error('[merge-pdf] failed:', err);
      progressPanel.style.display = 'none';
      errorBanner.textContent = '⚠️ ' + (err.message || 'Could not merge these files');
      errorBanner.style.display = 'block';
      render();
    }
  });
}
