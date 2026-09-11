// PPT -> PDF: parses the .pptx package's own XML directly (JSZip, same
// approach as ppt-to-excel.js) and rasterizes each slide onto an offscreen
// canvas - shapes, text runs, pictures, fills, and theme colors positioned
// from their OOXML transforms (falling back to the slide layout, then the
// slide master, for placeholders that don't repeat their position on the
// slide itself) - then embeds each canvas as a full-page image in a PDF via
// pdf-lib, one slide per page. This is a visual reconstruction, not a
// pixel-exact copy: there is no real PowerPoint engine available in a
// browser tab, so tables get a simplified grid, charts/SmartArt become a
// labeled placeholder box, and effects like gradients/shadows/animations are
// not reproduced - the same "close, not identical" tradeoff word-to-pdf.js
// and pdf-to-ppt.js already make elsewhere in this codebase.

const EMU_PER_PT = 12700;
const ZOOM = 150 / 72; // render at 150 DPI, matching pdf-to-ppt.js's rasterization step
const FONT_STACK = "'Segoe UI', Arial, Helvetica, sans-serif";
const ALIGN_MAP = { l: 'left', ctr: 'center', r: 'right', just: 'left' };
const SCHEME_ALIASES = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2', phClr: 'dk1' };
const DEFAULT_THEME = {
  dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
  accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
  accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
};

function emuToPt(v) { return v / EMU_PER_PT; }

// ---- tiny XML helpers (mirrors ppt-to-excel.js's getElementsByTagName use -
// DOMParser keeps OOXML's "p:"/"a:" prefixes as literal tagNames/attr names) ----

function parseXml(str) {
  return new DOMParser().parseFromString(str, 'application/xml');
}

function directChild(el, tag) {
  if (!el) return undefined;
  return Array.from(el.children).find(c => c.tagName === tag);
}

function directChildren(el, tag) {
  if (!el) return [];
  return Array.from(el.children).filter(c => c.tagName === tag);
}

function resolvePath(baseDir, target) {
  if (!target) return target;
  if (/^[a-z]+:\/\//i.test(target)) return target; // external URL, not a package part
  const parts = target.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  target.split('/').forEach(seg => {
    if (seg === '..') parts.pop();
    else if (seg === '.' || seg === '') { /* skip */ }
    else parts.push(seg);
  });
  return parts.join('/');
}

async function loadRelsMap(zip, partPath) {
  const slash = partPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : partPath.slice(0, slash);
  const base = slash === -1 ? partPath : partPath.slice(slash + 1);
  const relsFile = zip.file(`${dir ? dir + '/' : ''}_rels/${base}.rels`);
  if (!relsFile) return {};
  const doc = parseXml(await relsFile.async('string'));
  const map = {};
  Array.from(doc.getElementsByTagName('Relationship')).forEach(rel => {
    map[rel.getAttribute('Id')] = {
      type: rel.getAttribute('Type') || '',
      target: resolvePath(dir, rel.getAttribute('Target') || ''),
    };
  });
  return map;
}

function findRelByTypeSuffix(relsMap, suffix) {
  return Object.values(relsMap).find(r => r.type.endsWith(suffix));
}

// ---- theme colors ----

function parseTheme(themeDoc) {
  if (!themeDoc) return DEFAULT_THEME;
  const scheme = themeDoc.getElementsByTagName('a:clrScheme')[0];
  if (!scheme) return DEFAULT_THEME;
  const theme = { ...DEFAULT_THEME };
  Array.from(scheme.children).forEach(node => {
    const key = node.tagName.replace('a:', '');
    const colorEl = node.children[0];
    if (!colorEl) return;
    if (colorEl.tagName === 'a:srgbClr') theme[key] = '#' + colorEl.getAttribute('val');
    else if (colorEl.tagName === 'a:sysClr') theme[key] = '#' + (colorEl.getAttribute('lastClr') || '000000');
  });
  return theme;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const c = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function applyLumMod(hex, lumMod, lumOff) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newL = Math.min(1, Math.max(0, l * lumMod + lumOff));
  const rgb = hslToRgb(h, s, newL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

// Resolves a <a:srgbClr>/<a:sysClr>/<a:schemeClr> element (with optional
// alpha/lumMod/lumOff modifier children) to a drawable {hex, alpha}.
function resolveColorEl(colorEl, theme) {
  if (!colorEl) return null;
  let hex;
  if (colorEl.tagName === 'a:srgbClr') hex = '#' + colorEl.getAttribute('val');
  else if (colorEl.tagName === 'a:sysClr') hex = '#' + (colorEl.getAttribute('lastClr') || '000000');
  else if (colorEl.tagName === 'a:schemeClr') {
    const key = SCHEME_ALIASES[colorEl.getAttribute('val')] || colorEl.getAttribute('val');
    hex = theme[key] || '#000000';
  } else return null;

  let alpha = 1, lumMod = null, lumOff = null;
  Array.from(colorEl.children).forEach(mod => {
    const val = parseInt(mod.getAttribute('val'), 10);
    if (Number.isNaN(val)) return;
    if (mod.tagName === 'a:alpha') alpha = val / 100000;
    else if (mod.tagName === 'a:lumMod') lumMod = val / 100000;
    else if (mod.tagName === 'a:lumOff') lumOff = val / 100000;
  });
  if (lumMod !== null || lumOff !== null) hex = applyLumMod(hex, lumMod ?? 1, lumOff ?? 0);
  return { hex, alpha };
}

function resolveBackground(slideDoc, layoutDoc, masterDoc, theme) {
  const fromDoc = doc => {
    const cSld = doc && doc.getElementsByTagName('p:cSld')[0];
    const bgPr = cSld && directChild(directChild(cSld, 'p:bg'), 'p:bgPr');
    const solidFill = bgPr && directChild(bgPr, 'a:solidFill');
    const c = solidFill && resolveColorEl(solidFill.children[0], theme);
    return c ? c.hex : null;
  };
  return fromDoc(slideDoc) || fromDoc(layoutDoc) || fromDoc(masterDoc) || '#FFFFFF';
}

// ---- placeholder position inheritance (slide -> layout -> master) ----

function getPh(spEl) {
  const ph = directChild(directChild(directChild(spEl, 'p:nvSpPr'), 'p:nvPr'), 'p:ph');
  if (!ph) return null;
  return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') };
}

function findPlaceholderShape(spTreeEl, slidePh) {
  if (!spTreeEl) return null;
  const candidates = directChildren(spTreeEl, 'p:sp').map(sp => ({ sp, ph: getPh(sp) })).filter(c => c.ph);
  if (slidePh.idx != null) {
    const byIdx = candidates.find(c => c.ph.idx === slidePh.idx);
    if (byIdx) return byIdx.sp;
  }
  const byType = candidates.find(c => c.ph.type === slidePh.type);
  if (byType) return byType.sp;
  if (slidePh.type === 'title' || slidePh.type === 'ctrTitle') {
    const t = candidates.find(c => c.ph.type === 'title' || c.ph.type === 'ctrTitle');
    if (t) return t.sp;
  }
  return null;
}

function getShapeXfrmRaw(el) {
  const xfrm = directChild(directChild(el, 'p:spPr'), 'a:xfrm');
  if (!xfrm) return null;
  const off = directChild(xfrm, 'a:off');
  const ext = directChild(xfrm, 'a:ext');
  if (!off || !ext) return null;
  return {
    x: +off.getAttribute('x'), y: +off.getAttribute('y'),
    cx: +ext.getAttribute('cx'), cy: +ext.getAttribute('cy'),
    rot: +(xfrm.getAttribute('rot') || 0),
  };
}

// ---- coordinate transform (handles nested <p:grpSp> child coordinate spaces) ----

function ctmPoint(ctm, x, y) {
  return { x: ctm.offX + (x - ctm.chOffX) * ctm.scaleX, y: ctm.offY + (y - ctm.chOffY) * ctm.scaleY };
}

function groupCtm(grpSpEl, ctm) {
  const xfrm = directChild(directChild(grpSpEl, 'p:grpSpPr'), 'a:xfrm');
  if (!xfrm) return null;
  const off = directChild(xfrm, 'a:off');
  const ext = directChild(xfrm, 'a:ext');
  const chOff = directChild(xfrm, 'a:chOff');
  const chExt = directChild(xfrm, 'a:chExt');
  if (!off || !ext) return null;
  const x = +off.getAttribute('x'), y = +off.getAttribute('y');
  const cx = +ext.getAttribute('cx'), cy = +ext.getAttribute('cy');
  const abs = ctmPoint(ctm, x, y);
  const absCx = cx * ctm.scaleX, absCy = cy * ctm.scaleY;
  const chOffX = chOff ? +chOff.getAttribute('x') : x;
  const chOffY = chOff ? +chOff.getAttribute('y') : y;
  const chExtCx = chExt ? +chExt.getAttribute('cx') : cx;
  const chExtCy = chExt ? +chExt.getAttribute('cy') : cy;
  return {
    offX: abs.x, offY: abs.y, chOffX, chOffY,
    scaleX: chExtCx ? absCx / chExtCx : 1,
    scaleY: chExtCy ? absCy / chExtCy : 1,
  };
}

// ---- text layout ----

function defaultRunSize(isTitle, lvl, fontScale) {
  const base = isTitle ? 40 : Math.max(12, 22 - lvl * 2);
  return Math.round(base * fontScale);
}

function makeRunStyle(rPr, text, theme, isTitle, lvl, fontScale) {
  const size = rPr && rPr.hasAttribute('sz')
    ? Math.round((+rPr.getAttribute('sz') / 100) * fontScale)
    : defaultRunSize(isTitle, lvl, fontScale);
  const bold = !!(rPr && rPr.getAttribute('b') === '1') || isTitle;
  const italic = !!(rPr && rPr.getAttribute('i') === '1');
  let color = theme.dk1 || '#1A1A1A';
  const solidFill = rPr && directChild(rPr, 'a:solidFill');
  const c = solidFill && resolveColorEl(solidFill.children[0], theme);
  if (c) color = c.hex;
  return { text, size: Math.max(6, size), bold, italic, color };
}

function fontOf(tok) {
  return `${tok.italic ? 'italic ' : ''}${tok.bold ? 'bold ' : ''}${tok.size}pt ${FONT_STACK}`;
}

function lineTokensWidth(ctx, tokens) {
  let w = 0;
  tokens.forEach(tok => { ctx.font = fontOf(tok); w += ctx.measureText(tok.text).width; });
  return w;
}

function trimTrailingWhitespace(tokens) {
  const out = tokens.slice();
  while (out.length && /^\s+$/.test(out[out.length - 1].text)) out.pop();
  return out;
}

// Greedily wraps a run list (each run tagged with its own size/weight/color)
// into lines no wider than maxWidth, splitting on whitespace and honoring
// explicit <a:br/> tokens.
function wrapRuns(ctx, runs, maxWidth) {
  const tokens = [];
  runs.forEach(r => {
    if (r.break) { tokens.push({ forceBreak: true }); return; }
    r.text.split(/(\s+)/).filter(Boolean).forEach(p =>
      tokens.push({ text: p, size: r.size, bold: r.bold, italic: r.italic, color: r.color }));
  });

  const lines = [];
  let current = [];
  let currentWidth = 0;
  tokens.forEach(tok => {
    if (tok.forceBreak) { lines.push(current); current = []; currentWidth = 0; return; }
    ctx.font = fontOf(tok);
    const w = ctx.measureText(tok.text).width;
    if (currentWidth + w > maxWidth && current.length) {
      lines.push(current);
      current = [];
      currentWidth = 0;
      if (/^\s+$/.test(tok.text)) return;
    }
    current.push(tok);
    currentWidth += w;
  });
  lines.push(current);
  return lines.map(trimTrailingWhitespace);
}

function drawTextBody(ctx, spEl, boxW, boxH, theme, ph) {
  const txBody = directChild(spEl, 'p:txBody');
  const paragraphs = directChildren(txBody, 'a:p');
  if (!paragraphs.length) return;

  const bodyPr = directChild(txBody, 'a:bodyPr');
  const ins = attr => (bodyPr && bodyPr.hasAttribute(attr) ? emuToPt(+bodyPr.getAttribute(attr)) : null);
  const lIns = ins('lIns') ?? 7.2, tIns = ins('tIns') ?? 3.6, rIns = ins('rIns') ?? 7.2, bIns = ins('bIns') ?? 3.6;
  const anchor = (bodyPr && bodyPr.getAttribute('anchor')) || 't';

  let fontScale = 1, lnSpcReduction = 0;
  const autofit = bodyPr && directChild(bodyPr, 'a:normAutofit');
  if (autofit) {
    if (autofit.hasAttribute('fontScale')) fontScale = +autofit.getAttribute('fontScale') / 100000;
    if (autofit.hasAttribute('lnSpcReduction')) lnSpcReduction = +autofit.getAttribute('lnSpcReduction') / 100000;
  }

  const isTitle = !!(ph && (ph.type === 'title' || ph.type === 'ctrTitle'));
  const innerW = Math.max(1, boxW - lIns - rIns);

  const laidOutLines = [];
  paragraphs.forEach(pEl => {
    const pPr = directChild(pEl, 'a:pPr');
    const align = ALIGN_MAP[pPr && pPr.getAttribute('algn')] || 'left';
    const lvl = pPr && pPr.hasAttribute('lvl') ? Math.min(4, +pPr.getAttribute('lvl')) : 0;
    const indent = lvl * 14;
    const buChar = pPr && directChild(pPr, 'a:buChar');
    const bulletChar = buChar && !directChild(pPr, 'a:buNone') ? (buChar.getAttribute('char') || '•') : null;

    const runs = [];
    Array.from(pEl.children).forEach(child => {
      if (child.tagName === 'a:r') {
        const t = directChild(child, 'a:t');
        const text = t ? t.textContent : '';
        if (!text) return;
        runs.push(makeRunStyle(directChild(child, 'a:rPr'), text, theme, isTitle, lvl, fontScale));
      } else if (child.tagName === 'a:br') {
        runs.push({ break: true });
      }
    });

    if (!runs.length) { laidOutLines.push({ align, indent, tokens: [] }); return; }
    if (bulletChar) {
      runs.unshift({ text: bulletChar + ' ', size: runs[0].size, bold: false, italic: false, color: runs[0].color });
    }
    wrapRuns(ctx, runs, Math.max(1, innerW - indent)).forEach(tokens => laidOutLines.push({ align, indent, tokens }));
  });

  const lineHeights = laidOutLines.map(l => {
    const maxSize = l.tokens.length ? Math.max(...l.tokens.map(t => t.size)) : defaultRunSize(isTitle, 0, fontScale);
    return maxSize * 1.22 * (1 - lnSpcReduction);
  });
  const totalH = lineHeights.reduce((a, b) => a + b, 0);

  let curY = tIns;
  if (anchor === 'ctr') curY = Math.max(tIns, (boxH - totalH) / 2);
  else if (anchor === 'b') curY = Math.max(tIns, boxH - bIns - totalH);

  laidOutLines.forEach((line, i) => {
    const lh = lineHeights[i];
    const baseline = curY + lh * 0.78;
    const width = lineTokensWidth(ctx, line.tokens);
    let curX = lIns + line.indent;
    if (line.align === 'center') curX = lIns + Math.max(0, (innerW - width) / 2);
    else if (line.align === 'right') curX = lIns + Math.max(0, innerW - width);
    ctx.textBaseline = 'alphabetic';
    line.tokens.forEach(tok => {
      ctx.font = fontOf(tok);
      ctx.fillStyle = tok.color;
      ctx.fillText(tok.text, curX, baseline);
      curX += ctx.measureText(tok.text).width;
    });
    curY += lh;
  });
}

// ---- plain-text wrap for table cells (no per-run styling there) ----

function wrapPlainText(ctx, text, maxWidth) {
  const lines = [];
  text.split('\n').forEach(paragraph => {
    let line = '';
    paragraph.split(/\s+/).filter(Boolean).forEach(word => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
      else line = test;
    });
    lines.push(line);
  });
  return lines.length ? lines : [''];
}

// ---- shape renderers ----

function renderSp(ctx, spEl, ctm, theme, layoutSpTree, masterSpTree) {
  const ph = getPh(spEl);
  let raw = getShapeXfrmRaw(spEl);
  // A placeholder's own layout shape often has no xfrm either (e.g. a
  // "Title and Content" layout that itself inherits from the master) - each
  // level is tried in turn rather than stopping at the first shape found.
  if (!raw && ph) raw = getShapeXfrmRaw(findPlaceholderShape(layoutSpTree, ph));
  if (!raw && ph) raw = getShapeXfrmRaw(findPlaceholderShape(masterSpTree, ph));
  if (!raw) return;

  const abs = ctmPoint(ctm, raw.x, raw.y);
  const w = emuToPt(raw.cx * ctm.scaleX), h = emuToPt(raw.cy * ctm.scaleY);
  const x = emuToPt(abs.x), y = emuToPt(abs.y);
  if (w <= 0 || h <= 0) return;

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (raw.rot) ctx.rotate((raw.rot / 60000) * Math.PI / 180);
  ctx.translate(-w / 2, -h / 2);

  const spPr = directChild(spEl, 'p:spPr');
  const solidFill = spPr && directChild(spPr, 'a:solidFill');
  const fillColor = solidFill && resolveColorEl(solidFill.children[0], theme);
  if (fillColor) {
    ctx.globalAlpha = fillColor.alpha;
    ctx.fillStyle = fillColor.hex;
    const geom = spPr.getElementsByTagName('a:prstGeom')[0];
    if (geom && geom.getAttribute('prst') === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, Math.max(w, 0.01) / 2, Math.max(h, 0.01) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  }

  drawTextBody(ctx, spEl, w, h, theme, ph);
  ctx.restore();
}

async function renderPic(ctx, picEl, ctm, zip, slideRels) {
  const raw = getShapeXfrmRaw(picEl);
  if (!raw) return;
  const abs = ctmPoint(ctm, raw.x, raw.y);
  const w = emuToPt(raw.cx * ctm.scaleX), h = emuToPt(raw.cy * ctm.scaleY);
  const x = emuToPt(abs.x), y = emuToPt(abs.y);
  if (w <= 0 || h <= 0) return;

  const blip = directChild(directChild(picEl, 'p:blipFill'), 'a:blip');
  const embedId = blip && blip.getAttribute('r:embed');
  const rel = embedId && slideRels[embedId];
  const mediaFile = rel && zip.file(rel.target);
  if (!mediaFile) return;

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (raw.rot) ctx.rotate((raw.rot / 60000) * Math.PI / 180);
  ctx.translate(-w / 2, -h / 2);

  try {
    const bytes = await mediaFile.async('uint8array');
    const bitmap = await createImageBitmap(new Blob([bytes]));
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
  } catch {
    // Formats canvas can't decode (e.g. legacy EMF/WMF clip art) - show a
    // placeholder instead of silently leaving a gap.
    ctx.fillStyle = '#E5E7EB';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9CA3AF';
    ctx.font = `${Math.max(7, Math.min(12, h / 2))}pt ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('image', w / 2, h / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

function renderCxn(ctx, cxnEl, ctm, theme) {
  const raw = getShapeXfrmRaw(cxnEl);
  if (!raw) return;
  const spPr = directChild(cxnEl, 'p:spPr');
  const xfrmEl = directChild(spPr, 'a:xfrm');
  const flipH = xfrmEl && xfrmEl.getAttribute('flipH') === '1';
  const flipV = xfrmEl && xfrmEl.getAttribute('flipV') === '1';

  const abs = ctmPoint(ctm, raw.x, raw.y);
  const w = emuToPt(raw.cx * ctm.scaleX), h = emuToPt(raw.cy * ctm.scaleY);
  const x = emuToPt(abs.x), y = emuToPt(abs.y);

  let color = '#000000', width = 1;
  const ln = directChild(spPr, 'a:ln');
  const lnFill = ln && directChild(ln, 'a:solidFill');
  const c = lnFill && resolveColorEl(lnFill.children[0], theme);
  if (c) color = c.hex;
  if (ln && ln.hasAttribute('w')) width = Math.max(0.5, emuToPt(+ln.getAttribute('w')));

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(flipH ? x + w : x, flipV ? y + h : y);
  ctx.lineTo(flipH ? x : x + w, flipV ? y : y + h);
  ctx.stroke();
  ctx.restore();
}

function renderTable(ctx, tblEl, boxW, boxH, theme) {
  const cols = directChildren(directChild(tblEl, 'a:tblGrid'), 'a:gridCol').map(c => emuToPt(+c.getAttribute('w')));
  const rows = directChildren(tblEl, 'a:tr');
  const rowHeights = rows.map(r => emuToPt(+r.getAttribute('h') || 0));

  const totalColW = cols.reduce((a, b) => a + b, 0) || boxW;
  const scaleX = boxW / totalColW;
  const totalRowH = rowHeights.reduce((a, b) => a + b, 0) || boxH;
  const scaleY = boxH / totalRowH;

  let y = 0;
  rows.forEach((tr, ri) => {
    const rh = (rowHeights[ri] || totalRowH / rows.length) * scaleY;
    let x = 0;
    const cells = directChildren(tr, 'a:tc');
    cells.forEach((tc, ci) => {
      const cw = (cols[ci] || totalColW / cells.length) * scaleX;
      const tcPr = directChild(tc, 'a:tcPr');
      const fill = tcPr && directChild(tcPr, 'a:solidFill');
      const c = fill && resolveColorEl(fill.children[0], theme);
      ctx.fillStyle = c ? c.hex : '#FFFFFF';
      ctx.fillRect(x, y, cw, rh);
      ctx.strokeStyle = '#B0B0B0';
      ctx.lineWidth = 0.75;
      ctx.strokeRect(x, y, cw, rh);

      const text = directChildren(tc, 'a:txBody')
        .flatMap(tb => directChildren(tb, 'a:p'))
        .map(p => Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join(''))
        .join('\n')
        .trim();
      if (text) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw, rh);
        ctx.clip();
        const fontSize = Math.min(11, Math.max(7, rh / 2.2));
        ctx.fillStyle = '#1A1A1A';
        ctx.font = `${fontSize}pt ${FONT_STACK}`;
        ctx.textBaseline = 'middle';
        const pad = 4;
        const lines = wrapPlainText(ctx, text, cw - pad * 2);
        const lh = fontSize * 1.15;
        const startY = y + rh / 2 - ((lines.length - 1) / 2) * lh;
        lines.forEach((line, li) => ctx.fillText(line, x + pad, startY + li * lh));
        ctx.restore();
      }
      x += cw;
    });
    y += rh;
  });
}

function renderGraphicFrame(ctx, gfEl, ctm, theme) {
  const xfrm = directChild(gfEl, 'p:xfrm');
  const off = xfrm && directChild(xfrm, 'a:off');
  const ext = xfrm && directChild(xfrm, 'a:ext');
  if (!off || !ext) return;
  const raw = { x: +off.getAttribute('x'), y: +off.getAttribute('y'), cx: +ext.getAttribute('cx'), cy: +ext.getAttribute('cy') };

  const abs = ctmPoint(ctm, raw.x, raw.y);
  const w = emuToPt(raw.cx * ctm.scaleX), h = emuToPt(raw.cy * ctm.scaleY);
  const x = emuToPt(abs.x), y = emuToPt(abs.y);
  if (w <= 0 || h <= 0) return;

  const graphicData = gfEl.getElementsByTagName('a:graphicData')[0];
  const uri = (graphicData && graphicData.getAttribute('uri')) || '';
  const tbl = graphicData && directChild(graphicData, 'a:tbl');

  ctx.save();
  ctx.translate(x, y);
  if (tbl) {
    renderTable(ctx, tbl, w, h, theme);
  } else {
    ctx.fillStyle = '#F3F4F6';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#D1D5DB';
    ctx.strokeRect(0, 0, w, h);
    ctx.fillStyle = '#6B7280';
    ctx.font = `12pt ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText(/chart/i.test(uri) ? 'Chart' : /diagram/i.test(uri) ? 'Diagram' : 'Embedded object', w / 2, h / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

async function renderChildren(ctx, treeEl, ctm, theme, zip, slideRels, layoutSpTree, masterSpTree) {
  for (const node of Array.from(treeEl.children)) {
    try {
      switch (node.tagName) {
        case 'p:sp':
          renderSp(ctx, node, ctm, theme, layoutSpTree, masterSpTree);
          break;
        case 'p:pic':
          await renderPic(ctx, node, ctm, zip, slideRels);
          break;
        case 'p:cxnSp':
          renderCxn(ctx, node, ctm, theme);
          break;
        case 'p:graphicFrame':
          renderGraphicFrame(ctx, node, ctm, theme);
          break;
        case 'p:grpSp': {
          const childCtm = groupCtm(node, ctm);
          if (childCtm) await renderChildren(ctx, node, childCtm, theme, zip, slideRels, layoutSpTree, masterSpTree);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn('[ppt-to-pdf] skipped a shape:', err);
    }
  }
}

// ---- slide master/layout/theme resolution (cached per file, shared by every slide) ----

async function resolveAncestry(zip, layoutPath, cache) {
  if (!layoutPath) return { layoutDoc: null, masterDoc: null, theme: DEFAULT_THEME };

  if (!cache.layouts.has(layoutPath)) {
    const f = zip.file(layoutPath);
    cache.layouts.set(layoutPath, f ? parseXml(await f.async('string')) : null);
  }
  const layoutDoc = cache.layouts.get(layoutPath);

  const layoutRels = await loadRelsMap(zip, layoutPath);
  const masterPath = findRelByTypeSuffix(layoutRels, '/slideMaster')?.target;
  if (!masterPath) return { layoutDoc, masterDoc: null, theme: DEFAULT_THEME };

  if (!cache.masters.has(masterPath)) {
    const f = zip.file(masterPath);
    cache.masters.set(masterPath, f ? parseXml(await f.async('string')) : null);
  }
  const masterDoc = cache.masters.get(masterPath);

  const masterRels = await loadRelsMap(zip, masterPath);
  const themePath = findRelByTypeSuffix(masterRels, '/theme')?.target;
  if (themePath && !cache.themes.has(themePath)) {
    const f = zip.file(themePath);
    cache.themes.set(themePath, f ? parseTheme(parseXml(await f.async('string'))) : DEFAULT_THEME);
  }
  const theme = themePath ? cache.themes.get(themePath) : DEFAULT_THEME;

  return { layoutDoc, masterDoc, theme };
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error('Could not render this slide')); return; }
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
    }, 'image/png');
  });
}

async function isEncryptedOfficeFile(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 8));
  const oleSig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return oleSig.every((b, i) => bytes[i] === b);
}

export async function convert(file) {
  const arrayBuffer = await file.arrayBuffer();
  if (await isEncryptedOfficeFile(arrayBuffer)) throw new Error('File is password protected');

  const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
  const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1');

  const zip = await JSZip.loadAsync(arrayBuffer);
  const presXmlFile = zip.file('ppt/presentation.xml');
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presXmlFile || !presRelsFile) throw new Error('Not a valid .pptx file');

  const presDoc = parseXml(await presXmlFile.async('string'));
  const presRelsDoc = parseXml(await presRelsFile.async('string'));
  const relMap = {};
  Array.from(presRelsDoc.getElementsByTagName('Relationship')).forEach(rel => {
    relMap[rel.getAttribute('Id')] = rel.getAttribute('Target');
  });
  const slidePaths = Array.from(presDoc.getElementsByTagName('p:sldId'))
    .map(sldId => relMap[sldId.getAttribute('r:id')])
    .filter(Boolean)
    .map(target => resolvePath('ppt', target));
  if (!slidePaths.length) throw new Error('This presentation has no slides');

  const sldSzEl = presDoc.getElementsByTagName('p:sldSz')[0];
  const pageW = emuToPt(sldSzEl ? +sldSzEl.getAttribute('cx') : 12192000);
  const pageH = emuToPt(sldSzEl ? +sldSzEl.getAttribute('cy') : 6858000);

  const pdf = await PDFDocument.create();
  const cache = { layouts: new Map(), masters: new Map(), themes: new Map() };

  for (const slidePath of slidePaths) {
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideDoc = parseXml(await slideFile.async('string'));
    const slideRels = await loadRelsMap(zip, slidePath);
    const layoutPath = findRelByTypeSuffix(slideRels, '/slideLayout')?.target;
    const { layoutDoc, masterDoc, theme } = await resolveAncestry(zip, layoutPath, cache);

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(pageW * ZOOM);
    canvas.height = Math.ceil(pageH * ZOOM);
    const ctx = canvas.getContext('2d');
    ctx.scale(ZOOM, ZOOM);

    ctx.fillStyle = resolveBackground(slideDoc, layoutDoc, masterDoc, theme);
    ctx.fillRect(0, 0, pageW, pageH);

    const spTree = slideDoc.getElementsByTagName('p:spTree')[0];
    if (spTree) {
      const rootCtm = { offX: 0, offY: 0, chOffX: 0, chOffY: 0, scaleX: 1, scaleY: 1 };
      const layoutSpTree = layoutDoc && layoutDoc.getElementsByTagName('p:spTree')[0];
      const masterSpTree = masterDoc && masterDoc.getElementsByTagName('p:spTree')[0];
      await renderChildren(ctx, spTree, rootCtm, theme, zip, slideRels, layoutSpTree, masterSpTree);
    }

    const pngBytes = await canvasToPngBytes(canvas);
    canvas.width = 0; // release the backing buffer before moving to the next slide
    canvas.height = 0;

    const pngImage = await pdf.embedPng(pngBytes);
    const page = pdf.addPage([pageW, pageH]);
    page.drawImage(pngImage, { x: 0, y: 0, width: pageW, height: pageH });
  }

  const out = await pdf.save();
  return new Blob([out], { type: 'application/pdf' });
}
