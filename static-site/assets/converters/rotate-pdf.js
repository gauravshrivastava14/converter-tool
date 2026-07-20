// Rotates every page of a PDF by a fixed angle. Runs entirely client-side
// via pdf-lib (loaded from CDN, same pattern as the other converters here).

export async function convert(file, opts = {}) {
  const angle = Number(opts.angle) || 90;
  const { PDFDocument, degrees } = await import('https://esm.sh/pdf-lib@1.17.1');

  const bytes = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(err?.message || '')) throw new Error('This PDF is password protected');
    throw err;
  }

  for (const page of pdf.getPages()) {
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + angle + 360) % 360));
  }

  const out = await pdf.save();
  return new Blob([out], { type: 'application/pdf' });
}
