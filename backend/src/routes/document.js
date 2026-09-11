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
import { tagSectionMoods } from '../services/moodTagger.js';
import { getVoiceCatalog, PROVIDER } from '../services/voiceCatalog.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

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
      const insertedSections = [];
      for (const section of sections) {
        const result = await query(
          `INSERT INTO sections (document_id, order_index, text) VALUES ($1, $2, $3) RETURNING id, order_index, text`,
          [documentId, section.order_index, section.text]
        );
        insertedSections.push(result.rows[0]);
      }

      // --- Stage 4: mood/tone tagging ---
      // Runs synchronously as part of upload for MVP simplicity. A failure
      // here (missing API key, network issue, malformed model output)
      // should never take down the whole upload — the document is still
      // fully usable for reading, just without mood tags, and can be
      // re-tagged later via POST /:id/mood-tags.
      let moodTaggingStatus = 'skipped';
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const tags = await tagSectionMoods(insertedSections);
          for (const tag of tags) {
            await query(
              `UPDATE sections SET mood_tag = $2, mood_tag_confidence = $3 WHERE id = $1`,
              [tag.id, tag.mood_tag, tag.mood_tag_confidence]
            );
          }
          moodTaggingStatus = 'tagged';
        } catch (err) {
          console.error('Mood tagging failed:', err);
          moodTaggingStatus = 'failed';
        }
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
        needsReview: Boolean(ocrFlags && ocrFlags.length > 0),
        // 'tagged' | 'failed' | 'skipped' (no ANTHROPIC_API_KEY configured)
        moodTaggingStatus
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
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const docResult = await query(`SELECT * FROM documents WHERE id = $1`, [id]);

  if (docResult.rows.length === 0) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'This session has expired or the document is no longer available. Please upload it again.'
    });
  }

  const sectionsResult = await query(
    `SELECT id, order_index, text, mood_tag, mood_tag_confidence, user_mood_override FROM sections WHERE document_id = $1 ORDER BY order_index`,
    [id]
  );

  res.json({ document: docResult.rows[0], sections: sectionsResult.rows });
}));

// Re-run mood tagging for a document's sections. Useful when the initial
// upload's tagging pass was skipped (no API key configured yet) or failed
// (transient API/network issue) — lets a document be re-tagged without
// re-uploading and re-running OCR.
router.post('/:id/mood-tags', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const docResult = await query(`SELECT id FROM documents WHERE id = $1`, [id]);
  if (docResult.rows.length === 0) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'This document is no longer available. Please upload it again.'
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'MOOD_TAGGING_UNAVAILABLE',
      message: 'Mood tagging is not configured — set ANTHROPIC_API_KEY in the backend .env file.'
    });
  }

  const sectionsResult = await query(
    `SELECT id, order_index, text FROM sections WHERE document_id = $1 ORDER BY order_index`,
    [id]
  );

  try {
    const tags = await tagSectionMoods(sectionsResult.rows);
    for (const tag of tags) {
      await query(
        `UPDATE sections SET mood_tag = $2, mood_tag_confidence = $3 WHERE id = $1`,
        [tag.id, tag.mood_tag, tag.mood_tag_confidence]
      );
    }

    const updated = await query(
      `SELECT id, order_index, text, mood_tag, mood_tag_confidence FROM sections WHERE document_id = $1 ORDER BY order_index`,
      [id]
    );

    res.json({ documentId: id, moodTaggingStatus: 'tagged', sections: updated.rows });
  } catch (error) {
    console.error('Mood re-tagging failed:', error);
    res.status(502).json({
      error: 'MOOD_TAGGING_FAILED',
      message: 'Mood tagging failed — please try again in a moment.'
    });
  }
}));

// --- Phase 2: per-document voice selection ---
//
// Stored as history rather than a single column (the schema's
// voice_selection_history table): the latest row is the current voice, and
// keeping the earlier ones is what Phase 6's mid-playback switching and
// cache-reuse will read to know which voices this document has already
// been narrated in.

// Record the narrator voice the user picked for this document.
router.post('/:id/voice', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { voiceId } = req.body || {};

  if (!voiceId || typeof voiceId !== 'string') {
    return res.status(400).json({
      error: 'MISSING_VOICE_ID',
      message: 'Please choose a voice.'
    });
  }

  const docResult = await query(`SELECT id FROM documents WHERE id = $1`, [id]);
  if (docResult.rows.length === 0) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'This document is no longer available. Please upload it again.'
    });
  }

  // Validate against the real catalog so we never store a voice ID that
  // narration generation will later fail on. If the provider is down we
  // say so rather than silently accepting an unverifiable ID.
  let voice;
  try {
    const voices = await getVoiceCatalog();
    voice = voices.find((v) => v.voiceId === voiceId);
  } catch (error) {
    console.error('Voice validation failed:', error.message);
    return res.status(502).json({
      error: 'VOICE_PROVIDER_FAILED',
      message: "We couldn't confirm that voice just now. Please try again in a moment."
    });
  }

  if (!voice) {
    return res.status(400).json({
      error: 'UNKNOWN_VOICE',
      message: "That voice isn't available anymore. Please pick another one."
    });
  }

  await query(
    `INSERT INTO voice_selection_history (document_id, voice_id, provider) VALUES ($1, $2, $3)`,
    [id, voiceId, PROVIDER]
  );

  res.json({ documentId: id, voice });
}));

// The document's currently selected voice (most recent selection), plus the
// full selection history for later phases.
router.get('/:id/voice', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const historyResult = await query(
    `SELECT voice_id, provider, selected_at FROM voice_selection_history
     WHERE document_id = $1 ORDER BY selected_at DESC`,
    [id]
  );

  if (historyResult.rows.length === 0) {
    return res.status(404).json({
      error: 'NO_VOICE_SELECTED',
      message: 'No voice has been selected for this document yet.'
    });
  }

  res.json({
    documentId: id,
    current: historyResult.rows[0],
    history: historyResult.rows
  });
}));

export default router;
