import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { randomUUID } from 'crypto';

import { query } from '../db/index.js';
import { saveFile } from '../services/storageAdapter.js';
import { checkTextLayer } from '../services/textLayerCheck.js';
import { runOcr } from '../services/ocr.js';
import { splitIntoSections } from '../services/sectionSplitter.js';

const router = express.Router();

// MVP page/size cap, per the requirements doc's non-functional requirements.
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB — generous for ~50 pages

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  }
});

router.post('/upload', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    // --- Failure modes from the architecture doc's error table ---
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: 'This file is larger than we can process right now (max ~50MB). Try splitting it or uploading a shorter section.'
      });
    }
    if (err && err.message === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(400).json({
        error: 'UNSUPPORTED_FILE_TYPE',
        message: "This doesn't look like a PDF. Please upload a .pdf file."
      });
    }
    if (err) {
      return res.status(500).json({ error: 'UPLOAD_FAILED', message: 'Something went wrong on our end. Please try again in a moment.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No file was received.' });
    }

    const documentId = randomUUID();
    const filename = req.file.originalname;

    try {
      // Insert a "processing" row immediately so the frontend has something
      // to poll/show progress against right away.
      await query(
        `INSERT INTO documents (id, filename, status) VALUES ($1, $2, 'processing')`,
        [documentId, filename]
      );

      // Save the original upload to storage (via the adapter, per the
      // swappable-services design — this line doesn't change if you move
      // from local disk to R2 later).
      const pdfKey = `documents/${documentId}/original.pdf`;
      await saveFile(pdfKey, req.file.buffer);

      // --- Stage 2: text layer check ---
      const layerCheck = await checkTextLayer(req.file.buffer);

      if (!layerCheck.readable) {
        await query(
          `UPDATE documents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
          [documentId, 'corrupted']
        );
        return res.status(422).json({
          error: 'CORRUPTED_PDF',
          message: 'This PDF appears to be corrupted or unreadable. Try re-saving or re-exporting it and upload again.',
          documentId
        });
      }

      let extractedText;
      let ocrFlags = null;

      if (layerCheck.hasTextLayer) {
        // --- Text-based PDF: skip straight past OCR ---
        extractedText = layerCheck.text;
        await query(`UPDATE documents SET has_text_layer = true WHERE id = $1`, [documentId]);
      } else {
        // --- Stage 3: OCR fallback ---
        // Write the buffer to a temp file since pdf-poppler needs a file path.
        const tempPdfPath = path.join(os.tmpdir(), `${documentId}.pdf`);
        await fs.writeFile(tempPdfPath, req.file.buffer);

        let ocrResult;
        try {
          ocrResult = await runOcr(tempPdfPath);
        } finally {
          await fs.rm(tempPdfPath, { force: true });
        }

        extractedText = ocrResult.text;
        ocrFlags = ocrResult.ocrConfidenceFlags;

        await query(
          `UPDATE documents SET has_text_layer = false, ocr_confidence_flags = $2 WHERE id = $1`,
          [documentId, JSON.stringify(ocrFlags)]
        );

        // "No text found after OCR" failure mode from the architecture doc.
        if (!extractedText || extractedText.trim().length < 20) {
          await query(
            `UPDATE documents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
            [documentId, 'no_text_found']
          );
          return res.status(422).json({
            error: 'NO_TEXT_FOUND',
            message: "We couldn't find any readable text in this PDF. It may be a low-quality scan or contain no text. Try a clearer scan, or a different file.",
            documentId
          });
        }
      }

      // Save extracted text to storage, pointer in the database
      const textKey = `documents/${documentId}/extracted.txt`;
      await saveFile(textKey, Buffer.from(extractedText, 'utf-8'));
      await query(`UPDATE documents SET extracted_text_path = $2 WHERE id = $1`, [documentId, textKey]);

      // --- Split into sections and store ---
      const sections = splitIntoSections(extractedText);
      for (const section of sections) {
        await query(
          `INSERT INTO sections (document_id, order_index, text) VALUES ($1, $2, $3)`,
          [documentId, section.order_index, section.text]
        );
      }

      await query(`UPDATE documents SET status = 'ready' WHERE id = $1`, [documentId]);

      res.status(200).json({
        documentId,
        status: 'ready',
        hasTextLayer: layerCheck.hasTextLayer,
        sectionCount: sections.length,
        ocrConfidenceFlags: ocrFlags, // null if no OCR was needed
        // Flag pages needing review — this is what stage 3a's frontend
        // checkpoint will read from.
        needsReview: Boolean(ocrFlags && ocrFlags.length > 0)
      });
    } catch (error) {
      console.error('Upload pipeline error:', error);
      await query(
        `UPDATE documents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
        [documentId, 'unexpected_error']
      ).catch(() => {}); // don't let a logging failure mask the original error response
      res.status(500).json({
        error: 'PROCESSING_FAILED',
        message: 'Something went wrong on our end. Please try again in a moment.',
        documentId
      });
    }
  });
});

// Fetch a document's status + sections, e.g. for the frontend's processing screen
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const docResult = await query(`SELECT * FROM documents WHERE id = $1`, [id]);

  if (docResult.rows.length === 0) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'This session has expired or the document is no longer available. Please upload it again.'
    });
  }

  const sectionsResult = await query(
    `SELECT id, order_index, text, mood_tag FROM sections WHERE document_id = $1 ORDER BY order_index`,
    [id]
  );

  res.json({ document: docResult.rows[0], sections: sectionsResult.rows });
});

export default router;
