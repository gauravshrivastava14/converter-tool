// Images to PDF - combines JPG/PNG photos, in the order shown, into a
// single PDF (one image per page, scaled to fit an A4-ish page in the
// image's own orientation). N files -> 1 output, so - like Merge PDF - this
// drives the shared panels directly rather than the standard 1-in/1-out
// initToolPage() flow. Reordering before combining mirrors Merge PDF.

const PAGE_PORTRAIT = [595.28, 841.89]; // A4 in points
const MARGIN = 24;

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

  function isImage(name) {
    const ext = name.toLowerCase().split('.').pop();
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png';
  }

  function addFiles(list) {
    const wasEmpty = files.length === 0;
    for (const f of list) {
      if (!isImage(f.name)) continue;
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
      name.textContent = '🖼 ' + f.name;
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
    convertBtn.disabled = files.length < 1;
    convertBtn.textContent = files.length > 0
      ? `Combine ${files.length} Image${files.length > 1 ? 's' : ''} into a PDF`
      : 'Add at least 1 image';
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
    if (!files.length) return;
    errorBanner.style.display = 'none';
    resultsBox.style.display = 'none';
    fileListPanel.style.display = 'none';
    revokeObjectUrls();

    progressIcon.innerHTML = SPIN_RING_HTML;
    progressMessage.textContent = 'Building your PDF…';
    progressMessage.classList.remove('done');
    progressFill.classList.remove('done');
    progressFill.style.width = '0%';
    progressPercent.textContent = `0 / ${files.length} images placed (0%)`;
    progressPanel.style.display = 'block';

    try {
      const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1');
      const pdf = await PDFDocument.create();

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const bytes = await f.arrayBuffer();
        const isPng = f.name.toLowerCase().endsWith('.png');

        let img;
        try {
          img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        } catch (err) {
          throw new Error(`"${f.name}" couldn't be read as a valid ${isPng ? 'PNG' : 'JPG'}`);
        }

        const landscape = img.width > img.height;
        const [pw, ph] = landscape ? [PAGE_PORTRAIT[1], PAGE_PORTRAIT[0]] : PAGE_PORTRAIT;
        const maxW = pw - MARGIN * 2;
        const maxH = ph - MARGIN * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;

        const page = pdf.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - drawW) / 2, y: (ph - drawH) / 2, width: drawW, height: drawH });

        const pct = Math.round(((i + 1) / files.length) * 100);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = `${i + 1} / ${files.length} images placed (${pct}%)`;
        await new Promise(r => setTimeout(r, 0));
      }

      const out = await pdf.save();
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
      name.textContent = '✅ images.pdf';
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'images.pdf';
      link.textContent = '⬇ Download';
      row.append(name, link);
      resultList.appendChild(row);
      resultsBox.style.display = 'block';

      files = [];
      render();
    } catch (err) {
      console.error('[images-to-pdf] failed:', err);
      progressPanel.style.display = 'none';
      errorBanner.textContent = '⚠️ ' + (err.message || 'Could not build a PDF from these images');
      errorBanner.style.display = 'block';
      render();
    }
  });
}
