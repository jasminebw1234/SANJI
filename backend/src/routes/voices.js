import express from 'express';

import {
  getVoiceCatalog,
  filterVoices,
  deriveFilterOptions,
  PROVIDER
} from '../services/voiceCatalog.js';

const router = express.Router();

function unavailable(res, error) {
  // Missing key is a configuration problem (503, fixable by the operator);
  // anything else is the upstream provider failing (502).
  const isConfig = error.message.includes('ELEVENLABS_API_KEY is not set');
  return res.status(isConfig ? 503 : 502).json({
    error: isConfig ? 'VOICES_UNAVAILABLE' : 'VOICE_PROVIDER_FAILED',
    message: isConfig
      ? 'Voice selection is not configured — set ELEVENLABS_API_KEY in the backend .env file.'
      : "We couldn't load the voice list just now. Please try again in a moment."
  });
}

// The full (optionally filtered) voice list for the picker.
// e.g. GET /api/voices?gender=female&age=young
router.get('/', async (req, res) => {
  try {
    const voices = await getVoiceCatalog();
    const filtered = filterVoices(voices, {
      gender: req.query.gender,
      age: req.query.age,
      accent: req.query.accent,
      style: req.query.style,
      useCase: req.query.useCase
    });

    res.json({
      provider: PROVIDER,
      total: voices.length,
      count: filtered.length,
      voices: filtered
    });
  } catch (error) {
    console.error('Voice catalog error:', error.message);
    unavailable(res, error);
  }
});

// The filter values actually present in the catalog, for populating the
// picker's dropdowns without hardcoding ElevenLabs' taxonomy in the UI.
router.get('/filters', async (req, res) => {
  try {
    const voices = await getVoiceCatalog();
    res.json({ provider: PROVIDER, filters: deriveFilterOptions(voices) });
  } catch (error) {
    console.error('Voice filters error:', error.message);
    unavailable(res, error);
  }
});

export default router;
