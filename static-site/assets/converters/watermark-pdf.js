// Stamps a semi-transparent, diagonal text watermark across every page.
// The anchor point is computed so the watermark's baseline midpoint lands
// on the page's true center even after the 45deg rotation (pdf-lib rotates
// text around its drawn anchor, not its visual center, so a naive
// center-then-rotate would drift off-page).

const ANGLE = Math.PI / 4;

export async function convert(file, opts = {}) {
  const text = String(opts.text || 'CONFIDENTIAL').slice(0, 60);
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('https://esm.sh/pdf-lib@1.17.1');

  const bytes = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(err?.message || '')) throw new Error('This PDF is password protected');
    throw err;
  }

  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  pdf.getPages().forEach(page => {
    const { width, height } = page.getSize();
    const size = Math.max(20, Math.min(width, height) / 8);
    const textWidth = font.widthOfTextAtSize(text, size);

    const cx = width / 2;
    const cy = height / 2;
    const x = cx - (textWidth / 2) * Math.cos(ANGLE);
    const y = cy - (textWidth / 2) * Math.sin(ANGLE);

    page.drawText(text, {
      x, y, size, font,
      color: rgb(0.55, 0.1, 0.1),
      opacity: 0.16,
      rotate: degrees(45),
    });
  });

  const out = await pdf.save();
  return new Blob([out], { type: 'application/pdf' });
}
