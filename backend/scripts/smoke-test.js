#!/usr/bin/env node
//
// Exercises every endpoint against a running backend and reports pass/fail
// per check, so you can confirm the whole pipeline works without clicking
// through the frontend.
//
//   npm start            # in one terminal
//   npm run smoke-test   # in another
//
// Generates its own test PDFs, so you don't need to supply a file. Pass a
// real PDF to run the pipeline against that instead:
//
//   npm run smoke-test -- ../some-paper.pdf

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

dotenv.config();

const BASE = process.env.SMOKE_TEST_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(name, detail) {
  passed++;
  console.log(`${GREEN}PASS${RESET} ${name}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
}

function fail(name, detail) {
  failed++;
  console.log(`${RED}FAIL${RESET} ${name}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
}

function skip(name, why) {
  skipped++;
  console.log(`${YELLOW}SKIP${RESET} ${name} ${DIM}— ${why}${RESET}`);
}

/** Asserts an endpoint returns the expected HTTP status. */
async function expectStatus(name, requestPromise, expectedStatus) {
  try {
    const res = await requestPromise;
    const body = await res.json().catch(() => ({}));
    if (res.status === expectedStatus) {
      pass(name, `${res.status}`);
    } else {
      fail(name, `expected ${expectedStatus}, got ${res.status}: ${JSON.stringify(body).slice(0, 120)}`);
    }
    return body;
  } catch (err) {
    fail(name, err.message);
    return null;
  }
}

/**
 * Builds a minimal valid PDF with a real text layer, so the test doesn't
 * depend on any file being present. Written by hand rather than pulled from
 * a library to keep the test's own dependencies at zero.
 */
function buildTestPdf() {
  const content = Buffer.from(
    `BT
/F1 14 Tf
50 720 Td
(Smoke test paragraph one: a neutral explanatory sentence about the system.) Tj
0 -60 Td
(Smoke test paragraph two: warning, failure to configure this correctly may cause data loss.) Tj
0 -60 Td
(Smoke test paragraph three: the measured throughput was 4.2 units per second.) Tj
ET
`,
    'latin1'
  );

  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      'latin1'
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('\nendstream', 'latin1')
    ])
  ];

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let position = chunks[0].length;

  objects.forEach((obj, i) => {
    offsets.push(position);
    const block = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      obj,
      Buffer.from('\nendobj\n', 'latin1')
    ]);
    chunks.push(block);
    position += block.length;
  });

  const xrefOffset = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}

async function uploadPdf(name, buffer, filename) {
  const form = new FormData();
  form.append('pdf', new Blob([buffer], { type: 'application/pdf' }), filename);
  return fetch(`${BASE}/api/documents/upload`, { method: 'POST', body: form });
}

async function main() {
  console.log(`Testing ${BASE}\n`);

  // --- Is the server even up? Everything else is meaningless if not. ---
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`health returned ${res.status}`);
    pass('Server is running', '/health');
  } catch (err) {
    console.log(`${RED}FAIL${RESET} Server is running — ${err.message}`);
    console.log(`\nStart it first:  npm start`);
    process.exit(1);
  }

  // --- The happy path: a real PDF through the whole pipeline ---
  const customPath = process.argv[2];
  let pdfBuffer;
  let pdfName;

  if (customPath) {
    try {
      pdfBuffer = await fs.readFile(customPath);
      pdfName = path.basename(customPath);
      console.log(`${DIM}Using your file: ${pdfName}${RESET}`);
    } catch (err) {
      console.log(`${RED}Could not read ${customPath}: ${err.message}${RESET}`);
      process.exit(1);
    }
  } else {
    pdfBuffer = buildTestPdf();
    pdfName = 'smoke-test.pdf';
  }

  const upload = await expectStatus('Upload a text-layer PDF', uploadPdf('upload', pdfBuffer, pdfName), 200);
  const documentId = upload?.documentId;

  // A *failed* upload still returns a documentId in its error body, so the
  // presence of an ID is not proof the pipeline ran. Gate on the actual
  // status instead — otherwise every downstream check runs against garbage
  // and reports nonsense.
  if (upload?.status !== 'ready') {
    console.log(
      `\n${RED}The upload did not complete, so the rest of the pipeline can't be tested.${RESET}\n` +
      `Check the backend logs, then run ${DIM}npm run doctor${RESET} — a database that is ` +
      `down or un-migrated is the usual cause.`
    );
    process.exit(1);
  }

  if (upload.sectionCount > 0) {
    pass('Text extracted and split into sections', `${upload.sectionCount} sections`);
  } else {
    fail('Text extracted and split into sections', 'got 0 sections');
  }

  pass(
    'Text-layer detection',
    upload.hasTextLayer ? 'detected a text layer, skipped OCR' : 'no text layer — ran OCR'
  );

  // --- Mood tagging: what happened depends on whether a key is set ---
  if (upload.moodTaggingStatus === 'tagged') {
    pass('Mood tagging', 'tagged');
  } else if (upload.moodTaggingStatus === 'skipped') {
    skip('Mood tagging', 'ANTHROPIC_API_KEY not set');
  } else {
    fail('Mood tagging', `status "${upload.moodTaggingStatus}" — check the backend logs`);
  }

  // --- Reading the document back ---
  const doc = await expectStatus(
    'Fetch document + sections',
    fetch(`${BASE}/api/documents/${documentId}`),
    200
  );

  // Array.isArray first: without it, a failed fetch makes this
  // `undefined === undefined`, which passes and then crashes on .length.
  if (Array.isArray(doc?.sections) && doc.sections.length === upload.sectionCount) {
    pass('Sections persisted to the database', `${doc.sections.length} rows`);
  } else {
    fail(
      'Sections persisted to the database',
      `expected ${upload.sectionCount}, got ${Array.isArray(doc?.sections) ? doc.sections.length : 'no sections in response'}`
    );
  }

  if (upload.moodTaggingStatus === 'tagged') {
    const tagged = (doc?.sections || []).filter((s) => s.mood_tag);
    if (tagged.length === doc.sections.length) {
      const distribution = {};
      for (const s of doc.sections) distribution[s.mood_tag] = (distribution[s.mood_tag] || 0) + 1;
      pass('Every section has a mood tag', JSON.stringify(distribution));
    } else {
      fail('Every section has a mood tag', `${tagged.length}/${doc.sections.length} tagged`);
    }
  }

  // --- Error paths. These matter as much as the happy path: they're what
  // a real user hits, and several of them used to crash the server. ---
  await expectStatus(
    'Reject a non-PDF file',
    (async () => {
      const form = new FormData();
      form.append('pdf', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');
      return fetch(`${BASE}/api/documents/upload`, { method: 'POST', body: form });
    })(),
    400
  );

  await expectStatus(
    'Reject a corrupted PDF',
    uploadPdf('corrupt', Buffer.from('%PDF-1.4 this is not really a pdf'), 'broken.pdf'),
    422
  );

  await expectStatus(
    'Unknown document returns 404',
    fetch(`${BASE}/api/documents/00000000-0000-0000-0000-000000000000`),
    404
  );

  await expectStatus(
    'Voice selection requires a voice ID',
    fetch(`${BASE}/api/documents/${documentId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }),
    400
  );

  await expectStatus(
    'No voice selected yet returns 404',
    fetch(`${BASE}/api/documents/${documentId}/voice`),
    404
  );

  // --- Voice catalog: 503 without a key, 200 with one. Both are correct
  // outcomes, so branch rather than calling either a failure. ---
  try {
    const res = await fetch(`${BASE}/api/voices`);
    if (res.status === 503) {
      skip('Voice catalog', 'ELEVENLABS_API_KEY not set (endpoint correctly returns 503)');
      skip('Voice filters', 'ELEVENLABS_API_KEY not set');
      skip('Select a narrator voice', 'ELEVENLABS_API_KEY not set');
    } else if (res.ok) {
      const data = await res.json();
      pass('Voice catalog', `${data.total} voices from ${data.provider}`);

      const filtersRes = await fetch(`${BASE}/api/voices/filters`);
      if (filtersRes.ok) {
        const { filters } = await filtersRes.json();
        pass('Voice filters', `gender: ${(filters.gender || []).join('/') || 'none'}`);
      } else {
        fail('Voice filters', `returned ${filtersRes.status}`);
      }

      if (data.voices?.length) {
        const voice = data.voices[0];
        const selectRes = await fetch(`${BASE}/api/documents/${documentId}/voice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceId: voice.voiceId })
        });
        if (selectRes.ok) {
          pass('Select a narrator voice', `chose ${voice.name}`);
          const current = await fetch(`${BASE}/api/documents/${documentId}/voice`);
          const currentBody = await current.json();
          if (current.ok && currentBody.current?.voice_id === voice.voiceId) {
            pass('Selected voice persisted', currentBody.current.voice_id);
          } else {
            fail('Selected voice persisted', JSON.stringify(currentBody).slice(0, 120));
          }
        } else {
          fail('Select a narrator voice', `returned ${selectRes.status}`);
        }
      }
    } else {
      fail('Voice catalog', `returned ${res.status}`);
    }
  } catch (err) {
    fail('Voice catalog', err.message);
  }

  // --- The server surviving all of that is itself the point: several of
  // these paths used to take the whole process down. ---
  try {
    const res = await fetch(`${BASE}/health`);
    if (res.ok) {
      pass('Server still running after all checks', 'no crash');
    } else {
      fail('Server still running after all checks', `health returned ${res.status}`);
    }
  } catch (err) {
    fail('Server still running after all checks', `server is gone — ${err.message}`);
  }

  console.log(`\n${DIM}${'─'.repeat(58)}${RESET}`);
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped > 0) {
    console.log(`${DIM}Skipped checks need an API key — see .env.example.${RESET}`);
  }
  console.log(`${DIM}Test document: ${documentId}${RESET}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nSmoke test crashed: ${err.message}`);
  process.exit(1);
});
