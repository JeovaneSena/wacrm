-- ============================================================
-- 049 — contact phone-dedup moves from account-wide to per-number
-- (Fase 1b of the Master/Gestor/Agente per-number model, migration
-- 048's follow-up).
--
-- 022_contact_phone_dedup.sql enforced UNIQUE(account_id,
-- phone_normalized) — one contact per phone per ACCOUNT. Now that
-- every write path (webhook, resolve-conversation.ts, the public API)
-- stamps `contacts.whatsapp_config_id`, the same phone talking to two
-- different Gestores' numbers should be two separate contacts, one
-- per silo — by design (confirmed with the account owner). Swap the
-- unique index to (whatsapp_config_id, phone_normalized).
--
-- Every contact already has whatsapp_config_id populated (048's
-- backfill), so no merge pass is needed here — grouping by config id
-- is a finer-grained key than the account_id it replaces, so no new
-- collisions are introduced.
-- ============================================================

DROP INDEX IF EXISTS idx_contacts_account_phone_normalized;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_config_phone_normalized
  ON contacts (whatsapp_config_id, phone_normalized)
  WHERE phone_normalized <> '' AND whatsapp_config_id IS NOT NULL;

-- Rows with no whatsapp_config_id (shouldn't exist post-048 backfill,
-- but a defensive belt for any account with zero WhatsApp connected
-- yet) fall outside the partial index above — still deduped at the
-- account level so contacts added before any number is connected
-- don't silently collide once one finally is.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone_normalized_noconfig
  ON contacts (account_id, phone_normalized)
  WHERE phone_normalized <> '' AND whatsapp_config_id IS NULL;
