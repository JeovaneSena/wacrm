import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve the WhatsApp config owning a conversation (migration 048's
 * per-number model): the conversation's own `whatsapp_config_id` when
 * set, else the account's Master's config as a fallback for rows that
 * predate every write path stamping it. Shared by every route that
 * needs "the right instance token to act on this conversation" —
 * react, delete, media download, send.
 */
export async function resolveConfigForConversation<
  T extends Record<string, unknown> = { id: string; server_url: string; instance_token: string },
>(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId: string | null | undefined,
  select = 'id, server_url, instance_token',
): Promise<T | null> {
  let query = db.from('whatsapp_config').select(select);
  if (whatsappConfigId) {
    query = query.eq('id', whatsappConfigId);
  } else {
    const { data: acct } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle();
    query = query.eq('account_id', accountId).eq('user_id', acct?.owner_user_id ?? '');
  }
  const { data } = await query.maybeSingle();
  return (data as T | null) ?? null;
}
