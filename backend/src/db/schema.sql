-- Schema for the Multi-Voice PDF Reader
-- Matches the data model in the architecture doc.
-- Run this once against your Neon database to set up tables.
-- Phase 1 only needs `documents` and `sections` — the rest are here
-- so the schema is ready for later phases without a migration scramble.

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  upload_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  has_text_layer BOOLEAN,
  status TEXT NOT NULL DEFAULT 'processing', -- processing | ready | failed
  failure_reason TEXT,
  extracted_text_path TEXT, -- pointer into storage, not the raw text itself
  ocr_confidence_flags JSONB -- list of {page, confidence} needing review
);

CREATE TABLE IF NOT EXISTS sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  user_corrected_text TEXT,
  mood_tag TEXT,
  mood_tag_confidence REAL,
  user_mood_override TEXT
);

CREATE TABLE IF NOT EXISTS audio_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  voice_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  tone_override TEXT,
  audio_file_path TEXT NOT NULL,
  timestamp_map JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_selection_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  voice_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS full_narrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  voice_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  audio_file_path TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_id UUID REFERENCES sections(id),
  playback_timestamp REAL,
  voice_id TEXT,
  provider TEXT,
  comment_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sections_document ON sections(document_id);
CREATE INDEX IF NOT EXISTS idx_audio_cache_lookup ON audio_cache(section_id, voice_id, provider, tone_override);
CREATE INDEX IF NOT EXISTS idx_voice_history_document ON voice_selection_history(document_id);
CREATE INDEX IF NOT EXISTS idx_feedback_document ON feedback(document_id);
