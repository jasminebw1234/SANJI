#!/usr/bin/env node
//
// Spot-check the mood tagging without touching the database, the upload
// pipeline, or the frontend. Give it a PDF or a .txt file and it prints
// every paragraph next to the mood it got tagged with, plus what the run
// cost, so you can eyeball whether the tags are actually any good.
//
//   npm run check-moods -- ../some-paper.pdf
//   npm run check-moods -- notes.txt
//   MOOD_TAGGING_MODEL=claude-haiku-4-5 npm run check-moods -- paper.pdf
//
// Requires ANTHROPIC_API_KEY in backend/.env (or the environment).

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

import { checkTextLayer } from '../src/services/textLayerCheck.js';
import { splitIntoSections } from '../src/services/sectionSplitter.js';
import { tagSectionMoods, ALLOWED_MOODS } from '../src/services/moodTagger.js';

// Per-MTok pricing, for the cost estimate below. Update if prices change —
// this is only ever an estimate printed for your benefit.
const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

const COLORS = {
  neutral: '\x1b[37m',      // white
  cautionary: '\x1b[33m',   // yellow
  exciting: '\x1b[35m',     // magenta
  serious: '\x1b[36m',      // cyan
  technical: '\x1b[34m',    // blue
  reset: '\x1b[0m',
  dim: '\x1b[2m'
};

function truncate(text, max = 140) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return fs.readFile(filePath, 'utf-8');
  }

  if (ext !== '.pdf') {
    throw new Error(`Unsupported file type "${ext}" — give me a .pdf, .txt, or .md file.`);
  }

  const buffer = await fs.readFile(filePath);
  const layerCheck = await checkTextLayer(buffer);

  if (!layerCheck.readable) {
    throw new Error('That PDF could not be read at all — it may be corrupted.');
  }
  if (!layerCheck.hasTextLayer) {
    throw new Error(
      'That PDF has no text layer (it is a scan). This script skips OCR to stay fast — ' +
      'upload it through the running backend instead, which will OCR it first.'
    );
  }

  return layerCheck.text;
}

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npm run check-moods -- <file.pdf|file.txt>');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set.\n' +
      'Get a key at https://console.anthropic.com/settings/keys, then add it to backend/.env:\n' +
      '  ANTHROPIC_API_KEY=sk-ant-...'
    );
    process.exit(1);
  }

  const model = process.env.MOOD_TAGGING_MODEL || 'claude-opus-5';
  console.log(`${COLORS.dim}Model: ${model}${COLORS.reset}`);
  console.log(`${COLORS.dim}Reading ${filePath}…${COLORS.reset}`);

  const text = await extractText(filePath);
  const sections = splitIntoSections(text).map((s, i) => ({ ...s, id: `local-${i}` }));

  if (sections.length === 0) {
    console.error('No paragraphs found in that file.');
    process.exit(1);
  }

  console.log(`${COLORS.dim}Tagging ${sections.length} paragraphs…${COLORS.reset}\n`);

  const startedAt = Date.now();
  const tags = await tagSectionMoods(sections);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const moodById = new Map(tags.map((t) => [t.id, t]));
  const counts = Object.fromEntries(ALLOWED_MOODS.map((m) => [m, 0]));

  for (const section of sections) {
    const tag = moodById.get(section.id);
    const mood = tag?.mood_tag || 'neutral';
    const confidence = tag?.mood_tag_confidence ?? 0;
    counts[mood] = (counts[mood] || 0) + 1;

    const color = COLORS[mood] || COLORS.reset;
    const label = mood.padEnd(11);
    const conf = confidence.toFixed(2);
    // A low-confidence tag is the one most worth your eyeballs.
    const flag = confidence < 0.6 ? '  <- low confidence, check this' : '';

    console.log(`${color}${label}${COLORS.reset} ${COLORS.dim}${conf}${COLORS.reset}  ${truncate(section.text)}${flag}`);
  }

  console.log(`\n${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
  console.log('Distribution:');
  for (const mood of ALLOWED_MOODS) {
    const n = counts[mood] || 0;
    const pct = ((n / sections.length) * 100).toFixed(0);
    const bar = '█'.repeat(Math.round((n / sections.length) * 30));
    console.log(`  ${(COLORS[mood] || '')}${mood.padEnd(11)}${COLORS.reset} ${String(n).padStart(4)} (${pct.padStart(3)}%) ${bar}`);
  }

  const lowConfidence = tags.filter((t) => t.mood_tag_confidence < 0.6).length;
  console.log(`\n${sections.length} paragraphs tagged in ${elapsed}s`);
  if (lowConfidence > 0) {
    console.log(`${lowConfidence} tagged with confidence below 0.6 — those are the ones worth reading closely.`);
  }

  // If everything came back 'neutral', that's usually a signal the prompt
  // isn't discriminating, not that the document is genuinely monotone.
  if (counts.neutral === sections.length && sections.length > 3) {
    console.log(
      `\n${COLORS.cautionary}Every paragraph came back "neutral". On a document with any variation in tone ` +
      `that usually means the prompt isn't discriminating well — worth tuning before wiring up narration.${COLORS.reset}`
    );
  }

  const pricing = PRICING[model];
  if (pricing) {
    console.log(
      `${COLORS.dim}Rough cost: input $${pricing.input}/MTok, output $${pricing.output}/MTok. ` +
      `Set MOOD_TAGGING_MODEL to compare models on the same file.${COLORS.reset}`
    );
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
