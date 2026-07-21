-- Deleting a WhatsApp message ("apagar para todos"). Additive nullable
-- column so `status` (delivery state machine) and `content_type` (media
-- kind, needed to still render an icon in the "message deleted"
-- placeholder) stay untouched.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
