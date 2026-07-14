-- ============================================================
-- whatsapp_config: switch transport from Meta Cloud API to UAZAPI
-- ============================================================
--
-- UAZAPI (uazapiGO) is a self-hosted, QR-code-paired WhatsApp gateway.
-- Each account points at its own `server_url` (their own uazapiGO
-- instance) and holds an `instance_token` scoped to one WhatsApp
-- number — no Meta app, WABA, or phone_number_id involved.
--
-- The old Meta-only columns (phone_number_id, waba_id, access_token,
-- verify_token, registered_at, ...) are kept nullable rather than
-- dropped: message_templates / template sync still reference them for
-- any account that hasn't migrated, and dropping live columns is not
-- reversible. New rows are uazapi-only and simply leave them null.

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'uazapi'
    CHECK (provider IN ('meta', 'uazapi')),
  ADD COLUMN IF NOT EXISTS server_url TEXT,
  ADD COLUMN IF NOT EXISTS instance_token TEXT,
  ADD COLUMN IF NOT EXISTS instance_id TEXT,
  ADD COLUMN IF NOT EXISTS instance_name TEXT,
  ADD COLUMN IF NOT EXISTS owner_phone TEXT;

COMMENT ON COLUMN whatsapp_config.server_url IS
  'Base URL of the account''s self-hosted uazapiGO server, e.g. https://myserver.uazapi.com';
COMMENT ON COLUMN whatsapp_config.instance_token IS
  'Encrypted uazapi instance token (same encrypt()/decrypt() as access_token). Scopes every /send, /instance, /message call to this one WhatsApp number.';
COMMENT ON COLUMN whatsapp_config.instance_id IS
  'uazapi-assigned instance id, returned by POST /instance/init.';
COMMENT ON COLUMN whatsapp_config.owner_phone IS
  'The paired WhatsApp number (E.164-ish, from instance.owner), populated once /instance/status reports connected.';

-- uazapi's instance.status has a third value ('connecting', while the
-- QR is up and unscanned) the original Meta-only CHECK didn't allow.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'connecting', 'disconnected'));
