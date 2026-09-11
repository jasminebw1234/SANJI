#!/usr/bin/env node
//
// Checks everything the backend needs before you try to run it, and tells
// you exactly what to do about anything that's missing.
//
//   npm run doctor
//
// Exits 0 if the backend can start, 1 if something required is missing.
// Optional things (the two API keys) are reported but never fail the run.

import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

dotenv.config();

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const results = [];

// `configured` distinguishes "you didn't set this up" (SKIP — fine, the
// feature is optional) from "you set it up and it's broken" (WARN — you
// almost certainly want to know).
function record(name, ok, detail, fix, { required = true, configured = false } = {}) {
  results.push({ name, ok, detail, fix, required });
  const mark = ok
    ? `${GREEN}OK  ${RESET}`
    : required
      ? `${RED}FAIL${RESET}`
      : configured
        ? `${RED}WARN${RESET}`
        : `${YELLOW}SKIP${RESET}`;
  console.log(`${mark} ${name}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
  if (!ok && fix) {
    for (const line of fix.split('\n')) console.log(`       ${line}`);
  }
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  record(
    'Node.js v18+',
    major >= 18,
    `found v${process.versions.node}`,
    'Install Node 18 or newer: https://nodejs.org'
  );
}

async function checkDependencies() {
  try {
    require.resolve('express');
    require.resolve('@anthropic-ai/sdk');
    record('npm dependencies installed', true, 'node_modules present');
  } catch {
    record('npm dependencies installed', false, 'node_modules missing', 'Run: npm install');
  }
}

async function checkPoppler() {
  // Both binaries are used: pdftotext/pdfinfo for text-layer detection,
  // pdftoppm to rasterize pages for OCR.
  for (const bin of ['pdftotext', 'pdfinfo', 'pdftoppm']) {
    try {
      await execFileAsync(bin, ['-v']);
      record(`poppler: ${bin}`, true);
    } catch {
      record(
        `poppler: ${bin}`,
        false,
        'not on PATH',
        'Install poppler-utils:\n' +
        '  macOS:         brew install poppler\n' +
        '  Ubuntu/Debian: sudo apt-get install poppler-utils\n' +
        '  Windows:       https://github.com/oschwartz10612/poppler-windows (add bin/ to PATH)'
      );
    }
  }
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) {
    record(
      'DATABASE_URL configured',
      false,
      'not set',
      'Copy .env.example to .env and set DATABASE_URL.\n' +
      'Easiest option is a free Neon database (no local install): https://neon.tech\n' +
      'Or local Postgres: createdb pdf_voice_reader'
    );
    return;
  }
  record('DATABASE_URL configured', true);

  // Import lazily — importing db/index.js constructs the pool, which is
  // pointless (and noisy) if DATABASE_URL isn't set at all.
  const { query, pool } = await import('../src/db/index.js');

  try {
    await query('SELECT 1');
    record('Database reachable', true);
  } catch (err) {
    record(
      'Database reachable',
      false,
      err.message,
      'Check DATABASE_URL is correct and the database is running.\n' +
      'Local Postgres on macOS: brew services start postgresql\n' +
      'Local Postgres on Linux: sudo service postgresql start'
    );
    await pool.end().catch(() => {});
    return;
  }

  // A reachable database with no tables is the single most confusing
  // failure mode here — everything 500s with no obvious cause.
  const expected = ['documents', 'sections', 'audio_cache', 'voice_selection_history'];
  try {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const present = new Set(rows.map((r) => r.table_name));
    const missing = expected.filter((t) => !present.has(t));

    record(
      'Schema applied',
      missing.length === 0,
      missing.length === 0 ? `${present.size} tables` : `missing: ${missing.join(', ')}`,
      'Apply the schema:\n  psql "$DATABASE_URL" -f src/db/schema.sql\n' +
      '(Or paste src/db/schema.sql into Neon\'s SQL editor.)'
    );
  } catch (err) {
    record('Schema applied', false, err.message, 'Apply src/db/schema.sql against your database.');
  }

  await pool.end().catch(() => {});
}

async function checkAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    record(
      'ANTHROPIC_API_KEY (mood tagging)',
      false,
      'not set — uploads still work, mood tagging reports "skipped"',
      'Optional. Get a key at https://console.anthropic.com/settings/keys and add to .env',
      { required: false }
    );
    return;
  }

  // Cheapest possible real call that still proves the key works.
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    await client.messages.countTokens({
      model: process.env.MOOD_TAGGING_MODEL || 'claude-opus-5',
      messages: [{ role: 'user', content: 'ping' }]
    });
    record('ANTHROPIC_API_KEY (mood tagging)', true, 'key accepted', null, { required: false });
  } catch (err) {
    record(
      'ANTHROPIC_API_KEY (mood tagging)',
      false,
      err.message.slice(0, 120),
      'The key is set but the API rejected it. Check for typos or a revoked key.',
      { required: false, configured: true }
    );
  }
}

async function checkElevenLabs() {
  if (!process.env.ELEVENLABS_API_KEY) {
    record(
      'ELEVENLABS_API_KEY (voice picker)',
      false,
      'not set — voice endpoints return 503',
      'Optional. Get a key at https://elevenlabs.io and add to .env',
      { required: false }
    );
    return;
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      const { voices = [] } = await res.json();
      record('ELEVENLABS_API_KEY (voice picker)', true, `${voices.length} voices available`, null, { required: false });
    } else {
      record(
        'ELEVENLABS_API_KEY (voice picker)',
        false,
        `API returned ${res.status}`,
        res.status === 401 ? 'The key was rejected — check for typos or a revoked key.' : null,
        { required: false, configured: true }
      );
    }
  } catch (err) {
    record(
      'ELEVENLABS_API_KEY (voice picker)',
      false,
      err.message.slice(0, 120),
      'Could not reach api.elevenlabs.io — check your network/firewall.',
      { required: false, configured: true }
    );
  }
}

console.log('Checking your setup…\n');

await checkNode();
await checkDependencies();
await checkPoppler();
await checkDatabase();
await checkAnthropic();
await checkElevenLabs();

const requiredFailures = results.filter((r) => !r.ok && r.required);
const optionalFailures = results.filter((r) => !r.ok && !r.required);

console.log(`\n${DIM}${'─'.repeat(58)}${RESET}`);

if (requiredFailures.length === 0) {
  console.log(`${GREEN}Ready.${RESET} Start the backend with: npm start`);
  if (optionalFailures.length > 0) {
    console.log(
      `${DIM}${optionalFailures.length} optional feature(s) not configured — ` +
      `the pipeline runs without them.${RESET}`
    );
  }
  process.exit(0);
} else {
  console.log(`${RED}${requiredFailures.length} required check(s) failed.${RESET} Fix those, then run npm run doctor again.`);
  process.exit(1);
}
