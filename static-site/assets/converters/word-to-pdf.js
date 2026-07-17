// Word -> PDF (.docx/.docm only): mammoth.js turns the docx into a narrow,
// known subset of semantic HTML (p/h1-h6/strong/em/ul/ol/table/img), which is
// walked here into a pdfmake content tree so pdfmake can render a real vector
// PDF client-side. This is a text/structure reconstruction, not a pixel-exact
// copy of the original Word layout (headers/footers, exact fonts, and complex
// layout are not preserved) - the same tradeoff the previous PDF<->Word tools
// already made when there's no real Office engine available.

function inlineRuns(node) {
  const runs = [];
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) runs.push(child.textContent);
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const tag = child.tagName.toLowerCase();
    if (tag === 'br') {
      runs.push('\n');
    } else if (tag === 'strong' || tag === 'b') {
      runs.push({ text: child.textContent, bold: true });
    } else if (tag === 'em' || tag === 'i') {
      runs.push({ text: child.textContent, italics: true });
    } else if (tag === 'a') {
      runs.push({ text: child.textContent, color: '#e5322d' });
    } else if (child.textContent) {
      runs.push(child.textContent);
    }
  });
  return runs.length ? runs : [''];
}

function blockToPdfmake(node) {
  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case 'h1':
      return { text: inlineRuns(node), fontSize: 22, bold: true, margin: [0, 14, 0, 8] };
    case 'h2':
      return { text: inlineRuns(node), fontSize: 18, bold: true, margin: [0, 12, 0, 6] };
    case 'h3':
      return { text: inlineRuns(node), fontSize: 15, bold: true, margin: [0, 10, 0, 6] };
    case 'h4':
    case 'h5':
    case 'h6':
      return { text: inlineRuns(node), fontSize: 13, bold: true, margin: [0, 8, 0, 4] };
    case 'ul':
      return { ul: Array.from(node.children).map(li => ({ text: inlineRuns(li) })) };
    case 'ol':
      return { ol: Array.from(node.children).map(li => ({ text: inlineRuns(li) })) };
    case 'table': {
      const rows = Array.from(node.querySelectorAll('tr')).map(tr =>
        Array.from(tr.children).map(cell => ({ text: inlineRuns(cell) }))
      );
      const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0) || 1;
      return { table: { widths: Array(colCount).fill('*'), body: rows }, margin: [0, 6, 0, 6] };
    }
    case 'img':
      return { image: node.getAttribute('src'), width: 400, margin: [0, 6, 0, 6] };
    case 'p':
    default:
      return { text: inlineRuns(node), margin: [0, 0, 0, 8] };
  }
}

function htmlToPdfmakeContent(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  return Array.from(doc.body.children)
    .filter(node => node.textContent.trim() || node.tagName.toLowerCase() === 'img')
    .map(blockToPdfmake);
}

export async function convert(file) {
  const mammoth = await import('https://esm.sh/mammoth@1.12.0');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const content = htmlToPdfmakeContent(result.value);
  if (content.length === 0) throw new Error('No content could be extracted from this document');

  const { default: pdfMake } = await import('https://esm.sh/pdfmake@0.2.23');
  const { default: vfsFonts } = await import('https://esm.sh/pdfmake@0.2.23/build/vfs_fonts');
  pdfMake.vfs = vfsFonts;

  const docDefinition = {
    content,
    defaultStyle: { fontSize: 11, lineHeight: 1.25 },
    pageMargins: [50, 50, 50, 50],
  };

  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDefinition).getBlob(resolve);
    } catch (err) {
      reject(err);
    }
  });
}
