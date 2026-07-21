-- ============================================================
-- Recoverable invite tokens.
--
-- account_invitations.token_hash (SHA-256, one-way) stays as the
-- primary lookup key for peek/redeem — unchanged. This adds a
-- second column carrying the SAME token, but AES-256-GCM encrypted
-- with the app's ENCRYPTION_KEY (identical scheme to
-- whatsapp_config.instance_token), so an admin who lost the
-- one-time copy can reveal the link again instead of only being
-- able to revoke-and-recreate.
--
-- Security note: this is a deliberate, explicit trade-off vs the
-- original hash-only design (017's comment: "a leaked DB snapshot
-- doesn't yield a usable invite"). With this column, a DB leak
-- *combined with* an ENCRYPTION_KEY leak does yield usable pending
-- invite links — the same exposure already accepted for WhatsApp
-- instance tokens. Confirmed with the account owner before adding.
-- Nullable: rows created before this migration have no encrypted
-- copy and simply can't be revealed (revoke + recreate still works).
-- ============================================================

ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS token_encrypted TEXT;
