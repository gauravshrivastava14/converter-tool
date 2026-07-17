// Shared pdf.js loader used by both PDF-based converters. The worker script
// must be the exact same version as the main library, so both are pinned
// together here instead of each converter guessing a CDN URL on its own.
// Loaded from pdf.js's own official build (not esm.sh) because the worker
// needs to be the unmodified original file.
const PDFJS_VERSION = '6.1.200';
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
