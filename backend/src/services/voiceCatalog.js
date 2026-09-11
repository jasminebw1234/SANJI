// Phase 2: voice selection.
//
// The MVP plan re-scoped this from "auto-infer a voice per character" to
// "the user picks one narrator voice up front, filterable by gender and
// characteristics". This service is the catalog behind that picker: it
// pulls ElevenLabs' voice library, normalizes it into a stable internal
// shape, and derives the filter options from whatever voices actually came
// back (so the dropdowns can never offer a filter that matches nothing).
//
// The provider is deliberately isolated here, the same way storageAdapter
// isolates the file backend: the plan names Google Cloud TTS and Amazon
// Polly as fallbacks if ElevenLabs gets too expensive, and swapping means
// rewriting this one file — the routes and frontend talk only in the
// normalized shape below.

const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v1/voices';

export const PROVIDER = 'elevenlabs';

// The voice library changes rarely, and the picker gets hit on every page
// load — cache it rather than making a third-party API call each time.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = { voices: null, fetchedAt: 0 };

/**
 * ElevenLabs returns most of the useful metadata inside a free-form
 * `labels` object, and which keys are present varies between voices. This
 * reads defensively: a voice missing a label still shows up in the picker
 * (as 'unspecified') rather than being dropped or crashing the normalizer.
 */
export function normalizeVoice(raw) {
  const labels = raw.labels || {};

  return {
    voiceId: raw.voice_id,
    name: raw.name || 'Unnamed',
    gender: labels.gender || 'unspecified',
    age: labels.age || 'unspecified',
    accent: labels.accent || 'unspecified',
    // ElevenLabs uses `description` inside labels for the tonal quality
    // (calm, energetic...), which is what the plan calls "tone style" —
    // distinct from the top-level `description` free-text field.
    style: labels.description || 'unspecified',
    useCase: labels.use_case || 'unspecified',
    description: raw.description || null,
    previewUrl: raw.preview_url || null,
    category: raw.category || 'unspecified'
  };
}

export function normalizeCatalog(payload) {
  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  return voices
    .filter((v) => v && v.voice_id)
    .map(normalizeVoice);
}

/**
 * Builds the set of filter options actually present in the catalog, so the
 * UI only ever offers filters that match at least one voice.
 */
export function deriveFilterOptions(voices) {
  const collect = (key) =>
    [...new Set(voices.map((v) => v[key]).filter((val) => val && val !== 'unspecified'))].sort();

  return {
    gender: collect('gender'),
    age: collect('age'),
    accent: collect('accent'),
    style: collect('style'),
    useCase: collect('useCase')
  };
}

/**
 * Filters the catalog. Unknown or empty filter values are ignored rather
 * than returning an empty list — a picker that silently shows nothing is
 * worse than one that shows too much.
 */
export function filterVoices(voices, filters = {}) {
  const active = Object.entries(filters).filter(
    ([, value]) => typeof value === 'string' && value.trim() !== ''
  );

  if (active.length === 0) return voices;

  return voices.filter((voice) =>
    active.every(([key, value]) => {
      const voiceValue = voice[key];
      if (voiceValue === undefined) return true; // unknown filter key — don't filter on it
      return String(voiceValue).toLowerCase() === String(value).trim().toLowerCase();
    })
  );
}

/**
 * Fetches (and caches) the provider's voice library.
 * @param {{force?: boolean}} options
 * @returns {Promise<Array>} normalized voices
 */
export async function getVoiceCatalog({ force = false } = {}) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not set — voice selection requires it.');
  }

  const fresh = Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!force && cache.voices && fresh) {
    return cache.voices;
  }

  let response;
  try {
    response = await fetch(ELEVENLABS_VOICES_URL, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    throw new Error(`Could not reach the voice provider: ${err.message}`);
  }

  if (response.status === 401) {
    throw new Error('The voice provider rejected the API key (401) — check ELEVENLABS_API_KEY.');
  }
  if (!response.ok) {
    throw new Error(`Voice provider returned ${response.status}.`);
  }

  const payload = await response.json();
  const voices = normalizeCatalog(payload);

  // Serving a stale catalog beats serving an empty picker, so only replace
  // the cache when the response actually contained voices.
  if (voices.length === 0 && cache.voices) {
    return cache.voices;
  }

  cache = { voices, fetchedAt: Date.now() };
  return voices;
}

export function clearCache() {
  cache = { voices: null, fetchedAt: 0 };
}
