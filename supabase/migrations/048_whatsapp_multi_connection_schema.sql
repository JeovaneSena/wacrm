-- ============================================================
-- 048 — schema + RLS foundation for multi-WhatsApp-number accounts
-- (Fase 1a of the Master/Gestor/Agente per-number model).
--
-- Today: 1 account = 1 whatsapp_config row (UNIQUE(account_id),
-- migration 017), shared by every member. Target: 1 whatsapp_config
-- row per OWNING USER (a Gestor connects their own number; Master
-- can see every Gestor's). `whatsapp_config.user_id` already exists
-- and is already populated with the connecting user at creation time
-- (see src/app/api/whatsapp/config/route.ts POST) — it just lost its
-- UNIQUE constraint in 017 when tenancy moved to account_id. Re-adding
-- it is exactly the "1 number per owner" rule; no new column needed
-- on whatsapp_config itself.
--
-- `conversations`/`contacts` DON'T have any column tying a row to a
-- specific number today — only `account_id`. This migration adds
-- `whatsapp_config_id` to both, backfills it from the (today, always
-- singular) config row of each row's account, and layers a new RLS
-- clause on top of the existing account-membership check:
--
--   visible if: caller is account owner (Master, bypasses)
--            OR (whatsapp_config_id IS NOT NULL
--                AND that config's owner is the caller OR the
--                    caller's inviter (profiles.invited_by_user_id,
--                    migration 047 — the Gestor who brought an
--                    Agente in))
--
-- `messages` has no account_id/whatsapp_config_id of its own — its
-- policies already join through `conversations`, so extending that
-- EXISTS clause covers messages automatically.
--
-- Deliberately NOT touched here (staged for the next migration, once
-- the webhook/send routes are updated to stamp whatsapp_config_id on
-- new rows): the contacts phone-dedup unique index (022) stays
-- account-scoped for now. Rows created between this migration and
-- that follow-up will have whatsapp_config_id = NULL, which the RLS
-- clause above treats as "Master-only" (safe default — nobody but
-- Master is actively relying on Gestor/Agente conversation visibility
-- yet, since that never existed before this feature).
-- ============================================================

-- ---- whatsapp_config: 1 row per owning user --------------------
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_user_id_key'
  ) THEN
    ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_user_id_key UNIQUE (user_id);
  END IF;
END $$;
-- account_id stays (NOT NULL, indexed) — still needed for "list every
-- number in this account" (Master's view, Fase 2) and for the RLS
-- account-membership check every other table already uses.

-- ---- conversations / contacts: which number owns this row ------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config ON conversations(whatsapp_config_id);
CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_config ON contacts(whatsapp_config_id);

-- Backfill: every account today has at most one whatsapp_config row,
-- so this join is unambiguous. Re-runnable (only touches NULLs).
UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL;

UPDATE contacts ct
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = ct.account_id
  AND ct.whatsapp_config_id IS NULL;

-- ---- RLS helper: does the caller have access to this number? ----
CREATE OR REPLACE FUNCTION public.owns_whatsapp_config(p_config_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM whatsapp_config wc
    WHERE wc.id = p_config_id
      AND (
        wc.user_id = auth.uid()
        OR wc.user_id = (SELECT p.invited_by_user_id FROM profiles p WHERE p.user_id = auth.uid())
      )
  );
$$;
ALTER FUNCTION public.owns_whatsapp_config(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.owns_whatsapp_config(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owns_whatsapp_config(UUID) TO authenticated;

-- ---- conversations: layer the per-number check on top -----------
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT USING (
  is_account_member(account_id)
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (
  is_account_member(account_id, 'agent')
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (
  is_account_member(account_id, 'agent')
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
-- conversations_insert unchanged (017) — creating a conversation
-- doesn't depend on pre-existing number ownership.

-- ---- contacts: same layering ------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT USING (
  is_account_member(account_id)
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
CREATE POLICY contacts_update ON contacts FOR UPDATE USING (
  is_account_member(account_id, 'agent')
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
CREATE POLICY contacts_delete ON contacts FOR DELETE USING (
  is_account_member(account_id, 'agent')
  AND (
    is_account_member(account_id, 'owner')
    OR (whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(whatsapp_config_id))
  )
);
-- contacts_insert unchanged — new contacts get whatsapp_config_id
-- stamped by app code in the next migration's companion code change;
-- until then they land NULL (Master-only, per the header note).

-- ---- whatsapp_config itself: a Gestor's own row only ------------
-- Before this, any admin+ could see/edit/delete ANY config row in
-- the account (017's policy only checked account membership) — fine
-- when there was always exactly one row, a real cross-Gestor leak
-- once each Gestor gets their own. Master (owner) keeps full access;
-- everyone else is restricted to the row they own.
DROP POLICY IF EXISTS whatsapp_config_select ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT USING (
  is_account_member(account_id)
  AND (is_account_member(account_id, 'owner') OR user_id = auth.uid())
);
CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin') AND user_id = auth.uid()
);
CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE USING (
  is_account_member(account_id, 'admin')
  AND (is_account_member(account_id, 'owner') OR user_id = auth.uid())
);
CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE USING (
  is_account_member(account_id, 'admin')
  AND (is_account_member(account_id, 'owner') OR user_id = auth.uid())
);

-- ---- messages: inherit via the conversations join ---------------
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id)
      AND (
        is_account_member(c.account_id, 'owner')
        OR (c.whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(c.whatsapp_config_id))
      )
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND (
        is_account_member(c.account_id, 'owner')
        OR (c.whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(c.whatsapp_config_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND (
        is_account_member(c.account_id, 'owner')
        OR (c.whatsapp_config_id IS NOT NULL AND owns_whatsapp_config(c.whatsapp_config_id))
      )
  )
);
