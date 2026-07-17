// PPT -> Excel: one row per slide (slide number, title, content), mirroring
// the previous PowerPoint-COM implementation but reading the .pptx package's
// own XML directly (JSZip) instead of driving real PowerPoint.

function getOrderedSlidePaths(presDoc, relsDoc) {
  const relMap = {};
  Array.from(relsDoc.getElementsByTagName('Relationship')).forEach(rel => {
    relMap[rel.getAttribute('Id')] = rel.getAttribute('Target');
  });

  const sldIds = Array.from(presDoc.getElementsByTagName('p:sldId'));
  return sldIds
    .map(sldId => relMap[sldId.getAttribute('r:id')])
    .filter(Boolean)
    .map(target => (target.startsWith('slides/') ? `ppt/${target}` : target));
}

function isTitleShape(spEl) {
  return Array.from(spEl.getElementsByTagName('p:ph')).some(ph => {
    const type = ph.getAttribute('type');
    return type === 'title' || type === 'ctrTitle';
  });
}

function shapeText(spEl) {
  const txBody = spEl.getElementsByTagName('p:txBody')[0];
  if (!txBody) return '';
  const paragraphs = Array.from(txBody.getElementsByTagName('a:p'));
  const lines = paragraphs.map(p =>
    Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join('')
  );
  return lines.join('\n').trim();
}

function extractSlideText(slideDoc) {
  const shapes = Array.from(slideDoc.getElementsByTagName('p:sp'));
  const titleShape = shapes.find(isTitleShape);
  const title = titleShape ? shapeText(titleShape) : '';

  const texts = [];
  for (const sp of shapes) {
    const text = shapeText(sp);
    // Matches the original COM-based behaviour exactly: any shape whose text
    // happens to equal the title text is excluded, not just the title shape.
    if (text && text !== title) texts.push(text);
  }
  return { title, content: texts.join('\n') };
}

export async function convert(file) {
  const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const presXmlFile = zip.file('ppt/presentation.xml');
  const relsXmlFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presXmlFile || !relsXmlFile) throw new Error('Not a valid .pptx file');

  const parser = new DOMParser();
  const presDoc = parser.parseFromString(await presXmlFile.async('string'), 'application/xml');
  const relsDoc = parser.parseFromString(await relsXmlFile.async('string'), 'application/xml');
  const slidePaths = getOrderedSlidePaths(presDoc, relsDoc);

  const rows = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const slideFile = zip.file(slidePaths[i]);
    if (!slideFile) continue;
    const slideDoc = parser.parseFromString(await slideFile.async('string'), 'application/xml');
    const { title, content } = extractSlideText(slideDoc);
    rows.push({ num: i + 1, title, content });
  }

  const { default: ExcelJS } = await import('https://esm.sh/exceljs@4.4.0');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Slides');
  ws.columns = [
    { header: 'Slide Number', key: 'num', width: 14 },
    { header: 'Title', key: 'title', width: 40 },
    { header: 'Content', key: 'content', width: 80 },
  ];
  ws.getRow(1).eachCell(cell => { cell.font = { bold: true }; });
  rows.forEach(r => {
    const row = ws.addRow(r);
    row.eachCell(cell => { cell.alignment = { wrapText: true, vertical: 'top' }; });
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
