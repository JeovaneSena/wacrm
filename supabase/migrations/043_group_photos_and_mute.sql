-- ============================================================
-- Group avatars, per-participant avatars, and per-conversation mute.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS group_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS participant_avatar_url TEXT;
