-- ============================================================
-- Sticker as a first-class content type.
--
-- Inbound stickers were being stored as content_type='image'
-- (the 001 CHECK didn't allow 'sticker'), which made them render
-- as regular photos inside a message bubble. The inbox now renders
-- 'sticker' frameless at sticker size, so the type must survive
-- the insert.
-- ============================================================

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%content_type%'
  LOOP
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE messages ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'sticker'
  ));
