import Anthropic from '@anthropic-ai/sdk';

// Pipeline stage 4: mood/tone tagging.
//
// Per the MVP plan's "Reference Tools per Component" section, this is a
// per-section (not per-speaker) classification task — much lighter-weight
// than the original multi-character detection: no attribution, no
// character-tracking, just "tag the tone of this paragraph."
//
// Categories match the plan's own example list exactly, so tags stay
// meaningful to later phases (delivery-shifting narration in Phase 4/5):
export const ALLOWED_MOODS = ['neutral', 'cautionary', 'exciting', 'serious', 'technical'];

const DEFAULT_MODEL = process.env.MOOD_TAGGING_MODEL || 'claude-haiku-4-5-20251001';

// Batching sections into one request per chunk keeps this "a few cents per
// document" as the plan estimates, instead of one API call per paragraph.
// A ~50-page document can still have 100+ paragraphs, so a single request
// covering all of them risks a huge prompt and an easy-to-truncate response;
// this caps how many sections go in one call.
const MAX_SECTIONS_PER_BATCH = 25;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — mood tagging requires it.');
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function buildPrompt(sections) {
  const list = sections
    .map((s) => `[${s.order_index}] ${s.text}`)
    .join('\n\n');

  return `You are tagging the tone/mood of paragraphs from a non-fiction document (a paper, article, or informational book) so a text-to-speech narrator can adjust its delivery per section. This is NOT dialogue or character speech — there is a single continuous narrator throughout, so do not attribute tone to any speaker.

Allowed moods (use exactly one of these per paragraph, lowercase): ${ALLOWED_MOODS.join(', ')}

For each paragraph below (numbered by its section index), pick the mood that best fits its content and delivery, and a confidence from 0 to 1.

Respond with ONLY a JSON array, no other text, in this exact shape:
[{"index": 0, "mood": "neutral", "confidence": 0.9}, ...]

Include exactly one entry per paragraph index given below, in any order.

Paragraphs:
${list}`;
}

export function parseResponse(responseText, expectedIndices) {
  let parsed;
  try {
    // Models occasionally wrap JSON in a code fence despite instructions —
    // strip that defensively rather than fail the whole batch over it.
    const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Mood tagging response was not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Mood tagging response was not a JSON array');
  }

  const byIndex = new Map();
  for (const entry of parsed) {
    if (typeof entry.index !== 'number') continue;
    const mood = ALLOWED_MOODS.includes(entry.mood) ? entry.mood : 'neutral';
    const confidence = typeof entry.confidence === 'number'
      ? Math.max(0, Math.min(1, entry.confidence))
      : 0;
    byIndex.set(entry.index, { mood, confidence });
  }

  // Any index the model dropped or mis-tagged falls back to a safe default
  // rather than leaving that section's mood_tag null and silently breaking
  // whatever later phase reads it.
  return expectedIndices.map((index) => ({
    index,
    ...(byIndex.get(index) || { mood: 'neutral', confidence: 0 })
  }));
}

/**
 * Tags each section with a mood/tone.
 * @param {Array<{id: string, order_index: number, text: string}>} sections
 * @returns {Promise<Array<{id: string, mood_tag: string, mood_tag_confidence: number}>>}
 */
export async function tagSectionMoods(sections) {
  if (sections.length === 0) return [];

  const anthropic = getClient();
  const batches = chunk(sections, MAX_SECTIONS_PER_BATCH);
  const results = [];

  for (const batch of batches) {
    const expectedIndices = batch.map((s) => s.order_index);
    const message = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildPrompt(batch) }]
    });

    const responseText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const tagged = parseResponse(responseText, expectedIndices);
    const byOrderIndex = new Map(batch.map((s) => [s.order_index, s]));

    for (const { index, mood, confidence } of tagged) {
      const section = byOrderIndex.get(index);
      if (!section) continue;
      results.push({ id: section.id, mood_tag: mood, mood_tag_confidence: confidence });
    }
  }

  return results;
}
