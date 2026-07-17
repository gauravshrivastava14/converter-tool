// PDF -> PPT: each PDF page is rendered to a high-resolution image and placed
// as a full-bleed picture on its own slide, mirroring the previous
// PyMuPDF + python-pptx server-side implementation (same 150/72 zoom level).
import { loadPdfjs, isPasswordError } from '../pdfjs-loader.js';

const PT_TO_IN = 1 / 72;
const ZOOM = 150 / 72; // render at 150 DPI

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

    const { default: PptxGenJS } = await import('https://esm.sh/pptxgenjs@4.0.1');
    const pptx = new PptxGenJS();

    const firstPageViewport = (await pdfDoc.getPage(1)).getViewport({ scale: 1 });
    const widthIn = firstPageViewport.width * PT_TO_IN;
    const heightIn = firstPageViewport.height * PT_TO_IN;
    pptx.defineLayout({ name: 'PDF_PAGE', width: widthIn, height: heightIn });
    pptx.layout = 'PDF_PAGE';

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: ZOOM });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 0; // release the backing buffer before moving to the next page
      canvas.height = 0;

      const slide = pptx.addSlide();
      slide.addImage({ data: dataUrl, x: 0, y: 0, w: widthIn, h: heightIn });
    }

    return await pptx.write({ outputType: 'blob' });
  } finally {
    loadingTask.destroy();
  }
}
