// Shared pdf.js loader used by both PDF-based converters. The worker script
// must be the exact same version as the main library, so both are pinned
// together here instead of each converter guessing a CDN URL on its own.
// Loaded from pdf.js's own official build (not esm.sh) because the worker
// needs to be the unmodified original file.
// Pinned to 5.x, not the 6.x latest: pdf.js 6.1.200 calls the brand-new
// Uint8Array.prototype.toHex() with no fallback, which throws
// "a.toHex is not a function" on any browser that doesn't ship it yet
// (breaking PDF -> Word, PDF -> PPT, and PDF -> JPG alike). 5.4.149 has
// none of that and was verified to still render pages and extract text
// correctly.
const PDFJS_VERSION = '5.4.149';
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;

let pdfjsLibPromise = null;

export function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* @vite-ignore */ `${BASE}pdf.mjs`).then(pdfjsLib => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

export function isPasswordError(err) {
  return !!err && err.name === 'PasswordException';
}
