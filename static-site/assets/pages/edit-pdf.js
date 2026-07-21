// Edit PDF - a lightweight "Fill & Sign" style editor. Renders each page as
// a canvas via pdf.js, then lets the user place draggable text boxes,
// images, and freehand strokes on top as absolutely-positioned overlay
// elements. On save, the overlay coordinates (in a fixed CSS-pixel space
// per page) are converted back to PDF points and baked into a fresh copy
// of the original bytes via pdf-lib - the rendered pages are only ever a
// visual guide, never touched themselves.
import { loadPdfjs, isPasswordError } from '../pdfjs-loader.js';

const DISPLAY_WIDTH = 760; // fixed CSS-pixel coordinate space per page
const DPR_CAP = 2; // cap device-pixel-ratio scaling so huge PDFs stay light

export function init() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  fileInput.removeAttribute('multiple');

  const heroSection = document.querySelector('.hero');
  const workspace = document.querySelector('.workspace');
  const errorBanner = document.getElementById('errorBanner');
  const dragOverlay = document.getElementById('dragOverlay');

  const editorShell = document.getElementById('editorShell');
  const editorPages = document.getElementById('editorPages');
  const editorPageCount = document.getElementById('editorPageCount');
  const toolAddText = document.getElementById('toolAddText');
  const toolAddImage = document.getElementById('toolAddImage');
  const imageInput = document.getElementById('imageInput');
  const toolDraw = document.getElementById('toolDraw');
  const downloadPdfBtn = document.getElementById('downloadPdfBtn');
  const startOverBtn = document.getElementById('startOverBtn');

  let originalBytes = null;
  let originalFile = null;
  let pageMeta = []; // { widthPt, heightPt, scale, el }
  let elements = []; // flat list across all pages
  let activePage = 0;
  let selectedId = null;
  let drawMode = false;
  let uid = 0;
  const objectUrls = [];

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });

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
    if (editorShell.style.display === 'block') return; // already editing - ignore stray drops
    if (e.dataTransfer?.files?.length) loadFile(e.dataTransfer.files[0]);
  });

  async function loadFile(f) {
    if (!f || !f.name.toLowerCase().endsWith('.pdf')) return;
    errorBanner.style.display = 'none';

    let pdfjsLib, loadingTask;
    try {
      originalBytes = new Uint8Array(await f.arrayBuffer());
      originalFile = f;
      pdfjsLib = await loadPdfjs();
      loadingTask = pdfjsLib.getDocument({ data: originalBytes.slice() });
      const pdfDoc = await loadingTask.promise;
      await renderPages(pdfDoc);
    } catch (err) {
      console.error('[edit-pdf] failed to load:', err);
      errorBanner.textContent = '⚠️ ' + (isPasswordError(err) ? 'This PDF is password protected' : "This PDF couldn't be read (it may be corrupted)");
      errorBanner.style.display = 'block';
      return;
    } finally {
      loadingTask?.destroy();
    }

    heroSection.style.display = 'none';
    workspace.style.display = 'none';
    editorShell.style.display = 'block';
  }

  async function renderPages(pdfDoc) {
    editorPages.innerHTML = '';
    pageMeta = [];
    elements = [];
    selectedId = null;
    activePage = 0;

    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

    for (let i = 0; i < pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = DISPLAY_WIDTH / unscaled.width;
      const viewport = page.getViewport({ scale: scale * dpr });

      const canvas = document.createElement('canvas');
      canvas.className = 'page-bg';
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const pageEl = document.createElement('div');
      pageEl.className = 'editor-page';
      pageEl.style.width = DISPLAY_WIDTH + 'px';
      pageEl.dataset.page = String(i);

      const label = document.createElement('div');
      label.className = 'editor-page-label';
      label.textContent = `Page ${i + 1}`;

      pageEl.append(canvas, label);
      editorPages.appendChild(pageEl);

      pageEl.addEventListener('pointerdown', e => {
        activePage = i;
        if (e.target === pageEl || e.target === canvas || e.target === label) deselect();
        if (drawMode && (e.target === pageEl || e.target === canvas)) startDrawStroke(pageEl, i, e);
      });

      pageMeta.push({ widthPt: unscaled.width, heightPt: unscaled.height, scale, el: pageEl });
    }

    editorPageCount.textContent = `${pdfDoc.numPages} page${pdfDoc.numPages > 1 ? 's' : ''}`;
  }

  function deselect() {
    if (!selectedId) return;
    const prev = elements.find(el => el.id === selectedId);
    prev?.node.classList.remove('selected');
    prev?.controlsNode?.remove();
    selectedId = null;
  }

  function selectElement(record) {
    if (selectedId === record.id) return;
    deselect();
    selectedId = record.id;
    record.node.classList.add('selected');
    showControlsFor(record);
  }

  function nextId() { return 'el' + (uid++); }

  // ---------- Text elements ----------

  toolAddText.addEventListener('click', () => {
    const meta = pageMeta[activePage];
    if (!meta) return;
    const count = elements.filter(e => e.page === activePage && e.type === 'text').length;
    addTextElement(activePage, 60 + (count % 6) * 18, 60 + (count % 6) * 18);
  });

  function addTextElement(page, x, y) {
    const meta = pageMeta[page];
    const node = document.createElement('div');
    node.className = 'pdf-el pdf-el-text';
    node.contentEditable = 'true';
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    node.textContent = 'Type here…';

    const record = {
      id: nextId(), type: 'text', page, node,
      get x() { return parseFloat(node.style.left); },
      get y() { return parseFloat(node.style.top); },
      fontSize: 16, color: '#111111', bold: false,
    };

    node.addEventListener('pointerdown', e => {
      activePage = page;
      selectElement(record);
      // Contenteditable focuses on the browser's default mousedown handling,
      // which would fire before we know whether this becomes a drag - so
      // block it up front and, if it turns out *not* to be a drag, focus
      // manually in the pointerup handler instead.
      if (document.activeElement !== node) startTextDrag(node, e);
    });
    node.addEventListener('focus', () => {
      if (node.textContent === 'Type here…') { node.textContent = ''; }
    });
    node.addEventListener('blur', () => {
      if (!node.textContent.trim()) removeElement(record);
    });

    meta.el.appendChild(node);
    elements.push(record);
    selectElement(record);
    node.focus();
    placeCaretAtEnd(node);
  }

  // Text boxes need to distinguish "click to place the caret" from "drag to
  // move" - both start the same way (pointerdown on an unfocused box), so
  // dragging is only committed once the pointer actually moves past a small
  // threshold; otherwise pointerup focuses the box for editing instead.
  function startTextDrag(node, downEvent) {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const originLeft = parseFloat(node.style.left);
    const originTop = parseFloat(node.style.top);
    const THRESHOLD = 4;
    let dragging = false;

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
        dragging = true;
      }
      node.style.left = (originLeft + dx) + 'px';
      node.style.top = (originTop + dy) + 'px';
      const record = elements.find(el => el.node === node);
      if (record) repositionControls(record);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragging) {
        node.focus();
        placeCaretAtEnd(node);
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function placeCaretAtEnd(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- Image elements ----------

  toolAddImage.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const f = imageInput.files[0];
    imageInput.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    objectUrls.push(url);
    const dims = await new Promise(resolve => {
      const probe = new Image();
      probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
      probe.src = url;
    });
    const count = elements.filter(e => e.page === activePage && e.type === 'image').length;
    addImageElement(activePage, 80 + (count % 6) * 18, 80 + (count % 6) * 18, f, url, dims);
  });

  function addImageElement(page, x, y, file, url, dims) {
    const meta = pageMeta[page];
    const width = Math.min(200, DISPLAY_WIDTH - 40);
    const height = width * (dims.h / dims.w);

    const node = document.createElement('div');
    node.className = 'pdf-el pdf-el-image';
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    node.style.width = width + 'px';
    node.style.height = height + 'px';
    const img = document.createElement('img');
    img.src = url;
    node.appendChild(img);

    const resize = document.createElement('div');
    resize.className = 'pdf-el-resize';
    node.appendChild(resize);

    const record = {
      id: nextId(), type: 'image', page, node, file,
      get x() { return parseFloat(node.style.left); },
      get y() { return parseFloat(node.style.top); },
    };

    node.addEventListener('pointerdown', e => {
      if (e.target === resize) return;
      activePage = page;
      selectElement(record);
      startDrag(node, e, record);
    });
    resize.addEventListener('pointerdown', e => {
      e.stopPropagation();
      activePage = page;
      selectElement(record);
      startResize(node, e);
    });

    meta.el.appendChild(node);
    elements.push(record);
    selectElement(record);
  }

  // ---------- Freehand draw ----------

  toolDraw.addEventListener('click', () => {
    drawMode = !drawMode;
    toolDraw.classList.toggle('active', drawMode);
    pageMeta.forEach(m => m.el.classList.toggle('draw-mode', drawMode));
    deselect();
  });

  function startDrawStroke(pageEl, page, downEvent) {
    downEvent.preventDefault();
    const rect = pageEl.getBoundingClientRect();
    const factor = DISPLAY_WIDTH / rect.width;
    const toLocal = e => ({ x: (e.clientX - rect.left) * factor, y: (e.clientY - rect.top) * factor });

    const points = [toLocal(downEvent)];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pdf-el-draw-svg');
    svg.setAttribute('width', DISPLAY_WIDTH);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'draw-hit');
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('class', 'draw-visible');
    visible.setAttribute('stroke', '#e5322d');
    visible.setAttribute('stroke-width', '3');
    svg.append(hit, visible);
    pageEl.appendChild(svg);

    const pathData = () => 'M ' + points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ');
    hit.setAttribute('d', pathData());
    visible.setAttribute('d', pathData());

    function onMove(e) {
      points.push(toLocal(e));
      const d = pathData();
      hit.setAttribute('d', d);
      visible.setAttribute('d', d);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (points.length < 2) { svg.remove(); return; }
      finalizeDrawStroke(page, svg, hit, visible, points);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function finalizeDrawStroke(page, svg, hit, visible, points) {
    const record = { id: nextId(), type: 'draw', page, node: svg, points, color: '#e5322d', strokeWidth: 3 };
    svg.addEventListener('pointerdown', e => {
      if (drawMode) return;
      e.stopPropagation();
      selectElement(record);
    });
    elements.push(record);
  }

  // ---------- Shared drag / resize ----------

  function startDrag(node, downEvent, record) {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const originLeft = parseFloat(node.style.left);
    const originTop = parseFloat(node.style.top);
    node.setPointerCapture?.(downEvent.pointerId);

    function onMove(e) {
      node.style.left = (originLeft + (e.clientX - startX)) + 'px';
      node.style.top = (originTop + (e.clientY - startY)) + 'px';
      repositionControls(record);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function startResize(node, downEvent) {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const originW = node.offsetWidth;
    const originH = node.offsetHeight;

    function onMove(e) {
      node.style.width = Math.max(24, originW + (e.clientX - startX)) + 'px';
      node.style.height = Math.max(24, originH + (e.clientY - startY)) + 'px';
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---------- Per-element floating controls ----------

  function showControlsFor(record) {
    const bar = document.createElement('div');
    bar.className = 'pdf-el-controls';

    if (record.type === 'text') {
      const smaller = document.createElement('button');
      smaller.type = 'button'; smaller.textContent = 'A−';
      smaller.onclick = () => { record.fontSize = Math.max(8, record.fontSize - 2); record.node.style.fontSize = record.fontSize + 'px'; };
      const bigger = document.createElement('button');
      bigger.type = 'button'; bigger.textContent = 'A+';
      bigger.onclick = () => { record.fontSize = Math.min(72, record.fontSize + 2); record.node.style.fontSize = record.fontSize + 'px'; };
      const bold = document.createElement('button');
      bold.type = 'button'; bold.textContent = 'B'; bold.style.fontWeight = '800';
      bold.onclick = () => { record.bold = !record.bold; record.node.style.fontWeight = record.bold ? '800' : '400'; };
      const color = document.createElement('input');
      color.type = 'color'; color.value = record.color;
      color.oninput = () => { record.color = color.value; record.node.style.color = color.value; };
      record.node.style.fontSize = record.fontSize + 'px';
      bar.append(smaller, bigger, bold, color);
    } else if (record.type === 'draw') {
      const color = document.createElement('input');
      color.type = 'color'; color.value = record.color;
      color.oninput = () => {
        record.color = color.value;
        record.node.querySelector('.draw-visible').setAttribute('stroke', color.value);
      };
      bar.appendChild(color);
    }

    const del = document.createElement('button');
    del.type = 'button'; del.className = 'el-delete'; del.textContent = '✕';
    del.onclick = () => removeElement(record);
    bar.appendChild(del);

    // Appended as a *sibling* of the element in the page container, not as
    // a child of it - a text element is contenteditable, and a child would
    // have its button labels folded into el.node.textContent, corrupting
    // both the placeholder-clearing check and the saved PDF text.
    record.node.parentElement.appendChild(bar);
    record.controlsNode = bar;
    repositionControls(record);
  }

  function repositionControls(record) {
    if (!record.controlsNode) return;
    if (record.type === 'draw') {
      const p0 = record.points[0];
      record.controlsNode.style.left = p0.x + 'px';
      record.controlsNode.style.top = (p0.y - 34) + 'px';
    } else {
      record.controlsNode.style.left = record.node.style.left;
      record.controlsNode.style.top = (parseFloat(record.node.style.top) - 34) + 'px';
    }
  }

  function removeElement(record) {
    record.node.remove();
    record.controlsNode?.remove();
    elements = elements.filter(e => e.id !== record.id);
    if (selectedId === record.id) selectedId = null;
  }

  // ---------- Save ----------

  startOverBtn.addEventListener('click', () => {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls.length = 0;
    editorPages.innerHTML = '';
    elements = [];
    pageMeta = [];
    originalBytes = null;
    originalFile = null;
    drawMode = false;
    toolDraw.classList.remove('active');
    editorShell.style.display = 'none';
    heroSection.style.display = '';
    workspace.style.display = '';
  });

  function hexToRgbTuple(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  downloadPdfBtn.addEventListener('click', async () => {
    if (!originalBytes) return;
    const originalText = downloadPdfBtn.textContent;
    downloadPdfBtn.disabled = true;
    downloadPdfBtn.innerHTML = '<span class="spinner"></span>Saving…';

    try {
      const { PDFDocument, StandardFonts, rgb } = await import('https://esm.sh/pdf-lib@1.17.1');
      const pdf = await PDFDocument.load(originalBytes.slice());
      const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

      for (const el of elements) {
        const page = pdf.getPage(el.page);
        const { heightPt, scale } = pageMeta[el.page];

        if (el.type === 'text') {
          const text = (el.node.textContent || '').trim();
          if (!text) continue;
          const font = el.bold ? fontBold : fontRegular;
          const sizePt = el.fontSize / scale;
          const xPt = el.x / scale;
          const topPt = heightPt - el.y / scale;
          const [r, g, b] = hexToRgbTuple(el.color);
          text.split('\n').forEach((line, i) => {
            if (!line) return;
            page.drawText(line, {
              x: xPt, y: topPt - sizePt * (i + 1) * 1.25,
              size: sizePt, font, color: rgb(r, g, b),
            });
          });
        } else if (el.type === 'image') {
          const bytes = await el.file.arrayBuffer();
          const isPng = el.file.type === 'image/png' || el.file.name?.toLowerCase().endsWith('.png');
          let img;
          try {
            img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          } catch {
            continue; // skip an unreadable image rather than aborting the whole save
          }
          const wPx = el.node.offsetWidth;
          const hPx = el.node.offsetHeight;
          const xPt = el.x / scale;
          const yPt = heightPt - (el.y + hPx) / scale;
          page.drawImage(img, { x: xPt, y: yPt, width: wPx / scale, height: hPx / scale });
        } else if (el.type === 'draw') {
          const [r, g, b] = hexToRgbTuple(el.color);
          for (let i = 1; i < el.points.length; i++) {
            const p0 = el.points[i - 1], p1 = el.points[i];
            page.drawLine({
              start: { x: p0.x / scale, y: heightPt - p0.y / scale },
              end: { x: p1.x / scale, y: heightPt - p1.y / scale },
              thickness: el.strokeWidth,
              color: rgb(r, g, b),
            });
          }
        }
      }

      const outBytes = await pdf.save();
      const blob = new Blob([outBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const base = originalFile.name.replace(/\.pdf$/i, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}-edited.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('[edit-pdf] save failed:', err);
      errorBanner.textContent = '⚠️ Could not save this PDF. Please try again.';
      errorBanner.style.display = 'block';
    } finally {
      downloadPdfBtn.disabled = false;
      downloadPdfBtn.textContent = originalText;
    }
  });
}
