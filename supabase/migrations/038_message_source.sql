-- ============================================================
-- Outbound message origin.
--
-- Three distinct origins used to collapse into sender_type='agent':
-- the CRM composer, the public API, and (since the fromMe-echo
-- feature) messages typed on the paired phone / WhatsApp Web.
-- Agents/managers need to see at a glance whether a reply was sent
-- from inside the CRM or from outside it, so each outbound insert
-- now stamps where it came from:
--
--   'crm'   — dashboard composer
--   'phone' — paired phone / WhatsApp Web echo (fromMe webhook)
--   'api'   — public /api/v1/messages
--   'bot'   — Flows / Automations / AI auto-reply
--
-- Nullable on purpose: inbound customer messages have no outbound
-- origin, and pre-existing agent rows with sender_id NULL are
-- ambiguous (old phone echo vs API send) — better no label than a
-- wrong one. The UI renders NULL as "no badge".
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source IN ('crm', 'phone', 'api', 'bot'));

-- Backfill only what is safely inferable.
UPDATE messages SET source = 'crm'
  WHERE sender_type = 'agent' AND sender_id IS NOT NULL AND source IS NULL;

UPDATE messages SET source = 'bot'
  WHERE sender_type = 'bot' AND source IS NULL;
