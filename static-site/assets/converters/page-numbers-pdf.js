// Stamps a page number onto every page of a PDF, at the chosen corner and
// starting count. Runs entirely client-side via pdf-lib.

export async function convert(file, opts = {}) {
  const position = opts.position || 'bottom-center';
  const start = parseInt(opts.start, 10) || 1;
  const { PDFDocument, StandardFonts, rgb } = await import('https://esm.sh/pdf-lib@1.17.1');

  const bytes = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(err?.message || '')) throw new Error('This PDF is password protected');
    throw err;
  }

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const MARGIN = 28;
  const SIZE = 10;

  pdf.getPages().forEach((page, i) => {
    const { width, height } = page.getSize();
    const label = String(start + i);
    const textWidth = font.widthOfTextAtSize(label, SIZE);

    const y = position.startsWith('top') ? height - MARGIN : MARGIN;
    const x = position.endsWith('right') ? width - MARGIN - textWidth : (width - textWidth) / 2;

    page.drawText(label, { x, y, size: SIZE, font, color: rgb(0.35, 0.35, 0.42) });
  });

  const out = await pdf.save();
  return new Blob([out], { type: 'application/pdf' });
}
