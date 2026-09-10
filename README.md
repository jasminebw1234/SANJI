# PDF Voice Reader — Phase 1

This is the first working slice from the MVP build plan: **upload → text-layer
detection → OCR fallback → section extraction**, stored in Postgres (Neon)
with files in local storage (swappable to Cloudflare R2/Vercel Blob later).

## What's included
- `backend/` — Node.js/Express API implementing pipeline stages 1–3a
- `frontend/index.html` — a bare-bones upload page to test the pipeline (not the real app UI — that comes in Phase 4/5 with playback and sync)
- `backend/src/db/schema.sql` — full Postgres schema matching every table from the architecture doc, so later phases don't need a schema migration scramble

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
# edit .env and paste your Neon (or local Postgres) connection string into DATABASE_URL
```

Run the schema against your database (via Neon's SQL editor in their dashboard, or `psql`):
```bash
psql "$DATABASE_URL" -f src/db/schema.sql
```

Start the backend:
```bash
npm start
```

Open `frontend/index.html` directly in your browser (or serve it with any
static server) and upload a PDF to test the pipeline end to end.

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

All four were verified against a running backend: text-layer PDFs upload
and section-split correctly, corrupted/wrong-type/oversized uploads return
the right error codes, and the server now survives OCR and DB failures that
previously killed it outright.

## What this Phase 1 slice does NOT include yet
Per the build plan, these come in later phases:
- Mood tagging (Phase 3)
- Voice generation / TTS (Phase 3)
- Playback UI + synced highlighting (Phase 5)
- On-the-fly voice switching + caching (Phase 6)
- Voice history, download, feedback (added to the plan after Phase 1)

## A note on next steps
This project will keep growing — multiple services, API integrations, a
real frontend, deployment. From here, building it inside **Claude Code**
(rather than this chat) will let me actually install dependencies, run the
server, and test changes live instead of writing code blind. Worth
switching over for Phase 2 onward.
