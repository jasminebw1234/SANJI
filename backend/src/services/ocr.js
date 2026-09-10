import { createWorker } from 'tesseract.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// Pipeline stage 3: OCR for scanned PDFs, + stage 3a data collection
// (per-word confidence, so the app can flag low-confidence passages for
// user review instead of silently trusting a bad OCR read).
//
// NOTE: rasterization shells out directly to `pdftoppm`, the system
// `poppler-utils` binary (Tesseract can't read PDFs directly). This needs
// to be installed on whatever machine runs the backend:
//   - Debian/Ubuntu: sudo apt-get install poppler-utils
//   - macOS: brew install poppler
//
// We call pdftoppm directly instead of going through the `pdf-poppler` npm
// wrapper: that package calls `process.exit(1)` at import time on any
// platform other than macOS/Windows, which crashes the whole backend the
// moment this module is loaded on Linux — i.e. on most real deployment
// targets (Docker, most PaaS hosts, plain Ubuntu). pdftoppm itself works
// fine cross-platform; only the npm wrapper was broken.

const LOW_CONFIDENCE_THRESHOLD = 60; // Tesseract confidence is 0-100

// tesseract.js's createWorker() lazily downloads its language data (e.g.
// eng.traineddata.gz) on first use. If that fetch fails — flaky network, a
// blocked/unreachable CDN, an offline deployment — the underlying
// worker_threads Worker emits an 'error' event with no listener attached,
// which Node treats as an uncaught exception and crashes the *entire*
// process, not just this one request (confirmed against a real network
// failure, not a hypothetical). Since we can't attach a listener inside
// tesseract.js's own internals, runOcr wraps the OCR attempt with a
// scoped, one-shot 'uncaughtException' guard that converts that specific
// crash into a normal rejected promise so a single failed upload returns
// a 500 instead of taking the server down for every other user.
export async function runOcr(pdfPath) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const crashGuard = (err) => {
      if (settled) return;
      settled = true;
      process.removeListener('uncaughtException', crashGuard);
      reject(new Error(`OCR failed to initialize: ${err && err.message ? err.message : err}`));
    };
    process.once('uncaughtException', crashGuard);

    runOcrInternal(pdfPath).then(
      (result) => {
        if (settled) return;
        settled = true;
        process.removeListener('uncaughtException', crashGuard);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        process.removeListener('uncaughtException', crashGuard);
        reject(err);
      }
    );
  });
}

async function runOcrInternal(pdfPath) {
  const tempDir = path.join(os.tmpdir(), `ocr-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // Step 1: rasterize each page of the PDF into a PNG.
    // pdftoppm zero-pads the page number in output filenames based on the
    // total page count (e.g. page-01.png..page-10.png for a 10-page doc),
    // so a plain alphabetical sort stays correct regardless of page count.
    const outPrefix = path.join(tempDir, 'page');
    await execFileAsync('pdftoppm', ['-png', pdfPath, outPrefix]);

    const files = (await fs.readdir(tempDir))
      .filter((f) => f.endsWith('.png'))
      .sort();

    if (files.length === 0) {
      throw new Error('No pages could be rasterized from this PDF');
    }

    // Step 2: run Tesseract on each page image
    const worker = await createWorker('eng');
    const pageResults = [];
    let fullText = '';

    for (let i = 0; i < files.length; i++) {
      const imagePath = path.join(tempDir, files[i]);
      const { data } = await worker.recognize(imagePath);

      const lowConfidenceWords = (data.words || [])
        .filter((w) => w.confidence < LOW_CONFIDENCE_THRESHOLD)
        .map((w) => ({ text: w.text, confidence: w.confidence }));

      pageResults.push({
        page: i + 1,
        text: data.text,
        avgConfidence: data.confidence,
        lowConfidenceWords
      });

      fullText += data.text + '\n\n';
    }

    await worker.terminate();

    const flaggedPages = pageResults
      .filter((p) => p.avgConfidence < LOW_CONFIDENCE_THRESHOLD || p.lowConfidenceWords.length > 5)
      .map((p) => ({ page: p.page, avgConfidence: p.avgConfidence, issueCount: p.lowConfidenceWords.length }));

    return {
      text: fullText.trim(),
      pageCount: files.length,
      pageResults,
      ocrConfidenceFlags: flaggedPages
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
