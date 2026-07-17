// PDF -> Word: extracts text from each page and rebuilds it as an editable
// Word document. pdf.js's getTextContent() returns individual positioned
// text runs (not ready-made paragraphs like PyMuPDF's "blocks" mode), so
// runs are clustered into lines by Y-proximity, then consecutive lines are
// merged into paragraphs using a gap-size heuristic - same spirit as the
// previous sort-and-join approach, not pixel-identical block detection.
import { loadPdfjs, isPasswordError } from '../pdfjs-loader.js';

const Y_TOLERANCE = 2; // points; text runs within this are treated as the same line

function joinLineItems(items) {
  let text = '';
  let prevEndX = null;
  for (const it of items) {
    const x = it.transform[4];
    const gap = prevEndX === null ? 0 : x - prevEndX;
    if (gap > (it.height || 5) * 0.25 && text && !text.endsWith(' ') && !it.str.startsWith(' ')) {
      text += ' ';
    }
    text += it.str;
    prevEndX = x + (it.width || 0);
  }
  return text.trim();
}

function groupItemsIntoLines(items) {
  const lines = [];
  for (const item of items) {
    const y = item.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y); // PDF space: y increases upward, so descending = top-to-bottom
  return lines
    .map(l => ({
      y: l.y,
      // Representative font-derived height for this line, used to judge
      // whether the gap to the next line is a paragraph break.
      height: Math.max(...l.items.map(it => it.height || 0), 5),
      text: joinLineItems(l.items.sort((a, b) => a.transform[4] - b.transform[4])),
    }))
    .filter(l => l.text);
}

function linesToParagraphs(lines) {
  if (lines.length === 0) return [];
  // A gap is a paragraph break if it's noticeably larger than this line's own
  // font size - e.g. normal single-spaced lines run ~1.15-1.3x the font size,
  // so 1.5x reliably separates that from an actual paragraph/heading gap.
  // (A single global median-gap threshold breaks down on short pages where
  // most gaps *are* paragraph breaks, skewing the "typical" gap upward.)
  const PARAGRAPH_GAP_RATIO = 1.5;

  const paragraphs = [];
  let current = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    const lineHeight = Math.max(lines[i - 1].height, lines[i].height);
    if (gap > lineHeight * PARAGRAPH_GAP_RATIO) {
      paragraphs.push(current);
      current = lines[i].text;
    } else {
      current += ' ' + lines[i].text;
    }
  }
  paragraphs.push(current);
  return paragraphs;
}

export async function convert(file) {
  const pdfjsLib = await loadPdfjs();
  const arrayBuffer = await file.arrayBuffer();

  // destroy() lives on the loading task, not on the resolved document proxy.
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    if (isPasswordError(err)) throw new Error('File is password protected');
    throw err;
  }

  try {
    if (pdfDoc.numPages === 0) throw new Error('PDF has no pages');

    const { Document, Paragraph, Packer, PageBreak } = await import('https://esm.sh/docx@9.7.1');
    const children = [];

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items.filter(it => it.str && it.str.trim());
      const paragraphs = linesToParagraphs(groupItemsIntoLines(items));

      for (const text of paragraphs) {
        if (text.trim()) children.push(new Paragraph(text.trim()));
      }
      if (pageNum < pdfDoc.numPages) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
    }
    if (children.length === 0) children.push(new Paragraph(''));

    const doc = new Document({ sections: [{ children }] });
    return await Packer.toBlob(doc);
  } finally {
    loadingTask.destroy();
  }
}
