-- ============================================================
-- New notification types.
--
-- 027 shipped with a single type ('conversation_assigned', created by
-- the assignment trigger). This adds three app-inserted types:
--
--   'unattended_conversation' — customer waiting with no assigned
--       agent past a threshold (created by /api/notifications/cron)
--   'new_message_assigned'    — inbound message in a conversation
--       assigned to the recipient (created by the webhook)
--   'ai_handoff'              — the AI assistant asked for a human
--       (created by the auto-reply engine)
--
-- App inserts go through the service-role client — the 027 policy set
-- (no client INSERT) stays as-is.
-- ============================================================

DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%type%conversation_assigned%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'unattended_conversation',
    'new_message_assigned',
    'ai_handoff'
  ));
