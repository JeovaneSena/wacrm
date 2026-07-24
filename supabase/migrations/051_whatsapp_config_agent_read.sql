-- ============================================================
-- 051 — let an Agente read their inviting Gestor's whatsapp_config
-- row (status/connectivity only — 048's policy already restricts
-- UPDATE/DELETE to the owner + Master, unaffected here).
--
-- 048's whatsapp_config_select only allowed the row's own owner or
-- the account owner (Master) to SELECT it. An Agente querying their
-- Gestor's config (e.g. the inbox "WhatsApp connected" banner, which
-- falls back to the inviting Gestor's number since an Agente never
-- owns one themselves) got silently empty-filtered by RLS — the
-- fallback query in the app code was correct, but the database
-- refused to return the row.
-- ============================================================

DROP POLICY IF EXISTS whatsapp_config_select ON whatsapp_config;
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT USING (
  is_account_member(account_id)
  AND (
    is_account_member(account_id, 'owner')
    OR user_id = auth.uid()
    OR user_id = (SELECT p.invited_by_user_id FROM profiles p WHERE p.user_id = auth.uid())
  )
);
