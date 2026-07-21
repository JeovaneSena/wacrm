-- ============================================================
-- Group conversations.
--
-- Conversations were strictly 1:1 (contact_id NOT NULL). This adds a
-- 'group' chat_type so WhatsApp groups can show up in the inbox as
-- their own conversation, with per-participant attribution on
-- messages. Bots (flows/automations/AI) never run in groups — that
-- gate lives in application code, not here.
-- ============================================================

ALTER TABLE conversations ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS chat_type TEXT NOT NULL DEFAULT 'direct'
    CHECK (chat_type IN ('direct', 'group')),
  ADD COLUMN IF NOT EXISTS group_jid TEXT,
  ADD COLUMN IF NOT EXISTS group_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_group_unique
  ON conversations (account_id, group_jid) WHERE group_jid IS NOT NULL;

-- Per-message participant attribution for group chats (inbound only —
-- direct-chat messages leave these null, sender is the contact).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS participant_phone TEXT,
  ADD COLUMN IF NOT EXISTS participant_name TEXT;
