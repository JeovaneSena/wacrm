-- ============================================================
-- One conversation per contact per account — enforced by the DB.
--
-- Why: the webhook's findOrCreateConversation had no backstop
-- against concurrent inserts. A burst of inbound messages (e.g.
-- a bot sending many messages in one second) fans out into
-- parallel webhook invocations; each one finds no existing
-- conversation and inserts its own, leaving N duplicate threads
-- for the same contact. Worse, once duplicates exist the
-- `.single()` lookup errors on every subsequent message and
-- creates yet another conversation.
--
-- The app-level find-or-create remains, but this index is the
-- real guarantee — the same pattern contacts already use with
-- their unique phone index (migration 022). Application code
-- catches SQLSTATE 23505 and re-fetches the winner.
--
-- Data precondition: duplicates must be merged before this
-- runs (messages moved to the oldest conversation, extras
-- deleted). Production was repaired on 2026-07-15.
-- ============================================================

-- Defensive in-migration dedupe so the index can't fail on an
-- environment that still has duplicates: keep the oldest
-- conversation per (account_id, contact_id), move messages to
-- it, then delete the rest.
DO $$
DECLARE
  dup RECORD;
  keeper UUID;
BEGIN
  FOR dup IN
    SELECT account_id, contact_id
    FROM conversations
    WHERE contact_id IS NOT NULL
    GROUP BY account_id, contact_id
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keeper
    FROM conversations
    WHERE account_id = dup.account_id AND contact_id = dup.contact_id
    ORDER BY created_at ASC
    LIMIT 1;

    UPDATE messages
    SET conversation_id = keeper
    WHERE conversation_id IN (
      SELECT id FROM conversations
      WHERE account_id = dup.account_id
        AND contact_id = dup.contact_id
        AND id <> keeper
    );

    DELETE FROM conversations
    WHERE account_id = dup.account_id
      AND contact_id = dup.contact_id
      AND id <> keeper;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_unique
  ON conversations (account_id, contact_id)
  WHERE contact_id IS NOT NULL;
