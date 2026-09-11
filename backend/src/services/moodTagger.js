import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

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

// Defaults to Claude Opus 5. This is a simple classification task, so
// `effort: low` keeps the spend down without changing models — but if you
// want it cheaper still, set MOOD_TAGGING_MODEL=claude-haiku-4-5, which is
// roughly 5x cheaper per token and closer to the MVP plan's "a few cents
// per document" estimate. Spot-check both on a real document before
// deciding: `npm run check-moods -- <file.pdf|file.txt>`.
const DEFAULT_MODEL = process.env.MOOD_TAGGING_MODEL || 'claude-opus-5';

// Batching sections into one request per chunk keeps this cheap, instead of
// one API call per paragraph. A ~50-page document can still have 100+
// paragraphs, so a single request covering all of them risks a huge prompt
// and an easy-to-truncate response; this caps how many go in one call.
const MAX_SECTIONS_PER_BATCH = 25;

// Structured outputs: the API validates the response against this schema
// server-side, so we never have to parse loose text, strip code fences, or
// handle "the model wrapped it in prose" — a whole class of failure that
// the previous hand-rolled JSON parsing had to defend against.
const MoodTagsSchema = z.object({
  tags: z.array(
    z.object({
      index: z.number().int(),
      mood: z.enum(ALLOWED_MOODS),
      confidence: z.number().min(0).max(1)
    })
  )
});

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

Allowed moods: ${ALLOWED_MOODS.join(', ')}

For each paragraph below, pick the mood that best fits how a narrator should deliver it, and a confidence from 0 to 1. Return exactly one entry per paragraph, using the paragraph's bracketed index.

Paragraphs:
${list}`;
}

/**
 * Fills in any index the model dropped, so a section never silently ends up
 * with a null mood_tag that a later phase then has to special-case.
 */
export function normalizeTags(entries, expectedIndices) {
  const byIndex = new Map();
  for (const entry of entries || []) {
    if (typeof entry?.index !== 'number') continue;
    byIndex.set(entry.index, {
      mood: ALLOWED_MOODS.includes(entry.mood) ? entry.mood : 'neutral',
      confidence: typeof entry.confidence === 'number'
        ? Math.max(0, Math.min(1, entry.confidence))
        : 0
    });
  }

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

    const response = await anthropic.messages.parse({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      // Tone classification is a simple judgement call, not a reasoning
      // problem — low effort keeps thinking tokens (and cost) down.
      output_config: {
        effort: 'low',
        format: zodOutputFormat(MoodTagsSchema)
      },
      messages: [{ role: 'user', content: buildPrompt(batch) }]
    });

    // parsed_output is null if the model's output failed schema validation.
    const tagged = normalizeTags(response.parsed_output?.tags, expectedIndices);
    const byOrderIndex = new Map(batch.map((s) => [s.order_index, s]));

    for (const { index, mood, confidence } of tagged) {
      const section = byOrderIndex.get(index);
      if (!section) continue;
      results.push({ id: section.id, mood_tag: mood, mood_tag_confidence: confidence });
    }
  }

  return results;
}
