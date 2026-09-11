# PDF Voice Reader — Phases 1–3

Working slices from the MVP build plan: **upload → text-layer detection →
OCR fallback → section extraction → mood/tone tagging**, plus **narrator
voice selection**. Stored in Postgres (Neon) with files in local storage
(swappable to Cloudflare R2/Vercel Blob later).

Mood tagging (the plan's Phase 3) was built before voice selection (Phase 2).
That ordering is safe because the two are **independent**: mood tagging reads
only the document's text, and voice selection reads only the provider's voice
library. Neither is an input to the other — they first meet downstream in
Phase 4, where narration generation combines `(voice + mood)` into the TTS
call, and in the `audio_cache` key `(section + voice + tone)`.

## What's included
- `backend/` — Node.js/Express API implementing pipeline stages 1–4 (upload
  through mood tagging) plus the voice-selection catalog
- `frontend/index.html` — a bare-bones upload page + voice picker to test the pipeline (not the real app UI — that comes in Phase 5 with playback and sync)
- `backend/src/db/schema.sql` — full Postgres schema matching every table from the architecture doc, so later phases don't need a schema migration scramble

## Mood tagging
Each section (paragraph) gets tagged with one of five moods — `neutral`,
`cautionary`, `exciting`, `serious`, `technical` — per the MVP plan's own
example categories, using the Claude API (`claude-haiku-4-5-20251001` by
default; cheap enough that this stays a few cents per document, per the
plan's cost estimate). This runs automatically at the end of upload if
`ANTHROPIC_API_KEY` is set; if it's not set, or the call fails, the upload
still succeeds — sections just come back untagged, and can be tagged later
via `POST /api/documents/:id/mood-tags`.

### Spot-checking the tagging quality yourself
The wiring is verified, but whether the *labels are any good* needs a human
eye on real documents. There's a script for exactly that — it skips the
database, the upload flow and the frontend, and just prints every paragraph
next to the mood it got:

```bash
cd backend
# 1. Get a key at https://console.anthropic.com/settings/keys
# 2. Put it in backend/.env:  ANTHROPIC_API_KEY=sk-ant-...
npm run check-moods -- ../path/to/some-paper.pdf
```

It prints each paragraph with its mood and confidence, a distribution
summary, and flags anything tagged below 0.6 confidence — those are the ones
worth reading closely. It also warns if *everything* came back `neutral`,
which usually means the prompt isn't discriminating rather than that the
document is genuinely monotone.

The plan suggests testing on three document types — a paper, a scanned
article, and a chapter of a non-fiction book. For the scanned one, upload it
through the running backend instead (the script skips OCR to stay fast).

To compare models on the same file:
```bash
MOOD_TAGGING_MODEL=claude-haiku-4-5 npm run check-moods -- ../some-paper.pdf
```

## Voice selection (Phase 2)
`GET /api/voices` returns ElevenLabs' voice library normalized to a stable
internal shape, filterable by gender, age, accent and style;
`GET /api/voices/filters` returns the filter values actually present in the
catalog, so the picker can't offer a filter that matches nothing.
`POST /api/documents/:id/voice` records the chosen narrator (validated
against the live catalog first, so an unusable voice ID never reaches
narration generation), and `GET /api/documents/:id/voice` returns the current
choice plus the full history — which is what Phase 6's mid-playback switching
and cache reuse will read.

The provider is isolated in `src/services/voiceCatalog.js`, the same way
`storageAdapter.js` isolates file storage: the plan names Google Cloud TTS
and Amazon Polly as fallbacks if ElevenLabs gets too expensive, and swapping
means rewriting that one file.

**Verification status — read this before trusting it.** `api.elevenlabs.io`
was blocked by network egress policy in the environment this was built in, so
unlike the mood tagging (where the request provably reached Anthropic and came
back with a real structured error), **the live ElevenLabs call has never been
executed**. What *is* tested: normalization, filtering, filter derivation,
defensive handling of voices with missing labels, and every route's error
path — all against `backend/scripts/fixtures/elevenlabs-voices.json`, a
fixture built from ElevenLabs' *documented* response shape, not a real
capture. If the picker misbehaves against the real API, diff a real
`/v1/voices` response against that fixture first; a shape change there is by
far the most likely cause.

## Prerequisites
1. **Node.js** (v18+) installed on your machine
2. **poppler-utils** installed (needed to rasterize PDF pages for OCR, and
   for text-layer extraction — see "Fixes applied" below):
   - Mac: `brew install poppler`
   - Ubuntu/Debian: `sudo apt-get install poppler-utils`
   - Windows: install via [poppler for Windows](https://github.com/oschwartz10612/poppler-windows) and add it to your PATH
3. A **Postgres** database — either a free **Neon** database (sign up at
   neon.tech, create a project, copy the connection string) or a local
   Postgres instance for development (`createdb pdf_voice_reader`, then
   point `DATABASE_URL` at `postgres://user:password@localhost:5432/pdf_voice_reader`)
4. Outbound internet access on first OCR run — `tesseract.js` downloads its
   English language model from `cdn.jsdelivr.net` the first time OCR runs,
   then caches it locally. If that host is blocked by a firewall/proxy, OCR
   will fail (fails cleanly now — see "Fixes applied" below — but won't work
   until the download succeeds).

## Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env:
#   DATABASE_URL        — your Neon (or local Postgres) connection string
#   ANTHROPIC_API_KEY   — optional, enables mood tagging (console.anthropic.com)
#   ELEVENLABS_API_KEY  — optional, enables the voice picker (elevenlabs.io)
```

Both API keys are optional: without them the pipeline still runs end to end,
mood tagging reports `skipped`, and the voice picker returns a 503 explaining
what to configure.

Run the schema against your database (via Neon's SQL editor in their dashboard, or `psql`):
```bash
psql "$DATABASE_URL" -f src/db/schema.sql
```

## Testing it yourself

**1. Check the setup before starting anything.** This catches the confusing
failures (missing poppler, un-migrated schema, a rejected API key) and tells
you exactly what to do about each:

```bash
cd backend
npm run doctor
```

It exits 0 when the backend can start. Missing API keys show as `SKIP` and
never fail the run — a key that's *set but rejected* shows as `WARN`, which
is a different problem worth knowing about.

**2. Start the backend** in one terminal:
```bash
npm start
```

**3. Run the smoke test** in another. It exercises every endpoint — upload,
text extraction, section persistence, mood tagging, voice selection, and the
error paths — and reports pass/fail per check:

```bash
npm run smoke-test
```

It generates its own test PDF, so you don't need to supply a file. To run the
pipeline against a real document instead:

```bash
npm run smoke-test -- ../Hear_me_out_MVP_req_doc.pdf
```

(The MVP plan PDF is a genuinely good test document — it's real informational
content with varied tone, and it splits into ~53 sections.)

Checks needing an unconfigured API key are reported as `SKIP` rather than
counted as failures, so a clean run without any keys is `12 passed, 0 failed,
4 skipped`.

**4. Try it in the browser.** Open `frontend/index.html` directly (or serve it
with any static server), upload a PDF, and — if `ELEVENLABS_API_KEY` is set —
pick a narrator voice with the filters and preview buttons.

**5. Spot-check the mood tagging quality** (needs `ANTHROPIC_API_KEY`) — see
the section above. This is the one thing the smoke test can't judge for you:
it verifies tags got *assigned*, not that they're *right*.

## Fixes applied during setup (worth knowing about)
Getting this running surfaced a few real bugs in the Phase 1 code, not just
environment setup issues — fixed as part of getting the backend running:

- **`pdf-poppler` (npm package) called `process.exit(1)` at import time on
  any platform other than macOS/Windows.** Since `ocr.js` imported it at
  the top level, the backend could never even start on Linux — the most
  common deployment target (Docker, most PaaS hosts, plain Ubuntu) —
  despite the README's own Ubuntu/Debian setup instructions. Replaced with
  a direct `pdftoppm` (poppler-utils) shell-out; same underlying binary,
  no broken wrapper.
- **`pdf-parse` (npm package, bundles a pdf.js build from ~2017) threw
  `bad XRef entry` on spec-valid PDFs** — confirmed against PDFs generated
  by `pdfkit` and by hand, both of which poppler and `qpdf --check` parse
  without complaint. `pdf-parse` is effectively unmaintained. Replaced the
  text-layer check with `pdftotext`/`pdfinfo` (poppler-utils again), which
  is actively maintained and handled every test file correctly.
- **A failed Tesseract OCR worker crashed the entire backend process**, not
  just the one upload request — `tesseract.js`'s worker emits an `error`
  event with no listener attached on init failure (e.g. its language-data
  download fails), and Node treats that as an uncaught exception. Any user
  hitting a network hiccup during OCR would have taken the server down for
  everyone else too. `ocr.js` now wraps OCR attempts with a scoped
  `uncaughtException` guard that converts that specific crash into a normal
  rejected promise.
- **The Postgres connection pool had no `error` listener** — a documented
  `pg` footgun where an idle client hitting a network error (dropped
  connection, reset socket) crashes the whole process if unhandled.
  Confirmed against a real connection reset during testing, not a
  hypothetical. Added the listener in `db/index.js`.
- **Async route handlers had no error handling, so any database error on a
  read endpoint crashed the process.** Express 4 does not catch rejections
  from `async` handlers — an `await query(...)` that throws becomes an
  unhandled rejection, which Node turns into an uncaught exception. Caught
  this the hard way: the database went down mid-test and `GET /:id` killed
  the whole server. (Note this is a *different* bug from the pool listener
  above — that one covers errors on **idle** clients, this one covers errors
  on **in-flight queries**.) Added `middleware/asyncHandler.js` plus terminal
  error middleware, and verified by stopping Postgres mid-request: the same
  calls that killed the process now return a clean 500, the server stays up,
  and the pool reconnects by itself once the database is back.

All five were verified against a running backend: text-layer PDFs upload
and section-split correctly, corrupted/wrong-type/oversized uploads return
the right error codes, and the server now survives OCR and DB failures that
previously killed it outright.

## What this slice does NOT include yet
Per the build plan, these come in later phases:
- Voice generation / TTS, chunked ahead of playback (Phase 4)
- Playback UI + synced sentence highlighting (Phase 5)
- On-the-fly voice/tone switching + `(section + voice + tone)` audio caching (Phase 6)
- Download, feedback (added to the plan after Phase 1)

## A note on next steps
This project will keep growing — multiple services, API integrations, a
real frontend, deployment. From here, building it inside **Claude Code**
(rather than this chat) will let me actually install dependencies, run the
server, and test changes live instead of writing code blind. Worth
switching over for Phase 2 onward.
