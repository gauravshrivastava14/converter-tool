// Shrinks a PDF by rebuilding it with de-duplicated, compressed internal
// object streams via pdf-lib. This is a lossless, structural optimization -
// it never touches page content, so it's always safe to run, though the
// size reduction varies a lot: PDFs with duplicated resources or bloated
// metadata shrink noticeably, already-optimized scanned PDFs barely move.

export async function convert(file) {
  const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1');

  const bytes = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(err?.message || '')) throw new Error('This PDF is password protected');
    throw err;
  }

  const out = await pdf.save({ useObjectStreams: true });

  // Never hand back something bigger than what came in.
  const bestBytes = out.byteLength < bytes.byteLength ? out : new Uint8Array(bytes);
  return new Blob([bestBytes], { type: 'application/pdf' });
}
